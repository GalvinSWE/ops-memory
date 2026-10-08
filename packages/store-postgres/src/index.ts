import pg from 'pg';
import type {
  Evidence,
  Fact,
  FactQuery,
  ProcessedEvent,
  RunRecord,
  SearchQuery,
  SourceSubject,
  Store,
  StoreStats,
  SubjectRef,
  SubjectType
} from '@ops-memory/core';
import { MIGRATIONS } from './migrations.js';

export interface PostgresStoreOptions {
  /** URL of the database ops-memory owns, e.g. `postgres://user:pass@localhost:5432/ops_memory`. */
  connectionString: string;
  /** Schema for the tables. Default `public`. Created if missing. Lets tests or tenants share a database. */
  schema?: string;
  /** Connections in the pool. Default 5. */
  maxConnections?: number;
}

type Row = Record<string, unknown>;
type Queryable = Pick<pg.Pool | pg.PoolClient, 'query'>;

const SCHEMA_NAME = /^[a-z_][a-z0-9_]{0,62}$/;
// Any fixed number works; it only has to be the same for every ops-memory process.
const MIGRATION_LOCK = 4_181_017;

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());

/**
 * Postgres store. Use a database (or schema) of its own, never the source system's: ops-memory
 * writes here and only reads the source. Several processes can read and write; run `sync` from
 * one place so two runs do not extract the same events twice.
 */
export function postgres(options: PostgresStoreOptions): Store {
  const schema = options.schema ?? 'public';
  if (!SCHEMA_NAME.test(schema)) throw new Error(`store-postgres: invalid schema name "${schema}"`);
  const pool = new pg.Pool({
    connectionString: options.connectionString,
    max: options.maxConnections ?? 5,
    application_name: 'ops-memory-store',
    options: `-c search_path=${schema}`
  });

  const q = async (sql: string, params: unknown[] = [], db: Queryable = pool) => (await db.query(sql, params)).rows as Row[];

  const tx = async <T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  };

  const toSubject = (r: Row): SourceSubject => ({
    type: String(r.type),
    id: String(r.id),
    name: String(r.name),
    connector: String(r.connector),
    ...(r.meta ? { meta: r.meta as Record<string, unknown> } : {})
  });

  const toFacts = async (rows: Row[]): Promise<Fact[]> => {
    if (!rows.length) return [];
    const ids = rows.map((r) => String(r.id));
    const evidence = new Map<string, Evidence[]>();
    for (const r of await q('SELECT * FROM evidence WHERE fact_id = ANY($1) ORDER BY occurred_at', [ids])) {
      const list = evidence.get(String(r.fact_id)) ?? [];
      list.push({
        eventId: String(r.event_id),
        connector: String(r.connector),
        source: String(r.source),
        quote: String(r.quote),
        occurredAt: iso(r.occurred_at),
        ...(r.url ? { url: String(r.url) } : {})
      });
      evidence.set(String(r.fact_id), list);
    }
    return rows.map((r) => ({
      id: String(r.id),
      subject: { type: String(r.subject_type), id: String(r.subject_id) },
      kind: String(r.kind),
      topic: String(r.topic),
      statement: String(r.statement),
      confidence: Number(r.confidence),
      status: String(r.status) as Fact['status'],
      evidence: evidence.get(String(r.id)) ?? [],
      firstSeen: iso(r.first_seen),
      lastSeen: iso(r.last_seen),
      updatedAt: iso(r.updated_at)
    }));
  };

  const filters = (query: { subject?: SubjectRef; kinds?: string[]; status?: FactQuery['status'] }, params: unknown[]) => {
    let sql = '';
    if (query.subject) {
      params.push(query.subject.type, query.subject.id);
      sql += ` AND subject_type = $${params.length - 1} AND subject_id = $${params.length}`;
    }
    if (query.kinds?.length) {
      params.push(query.kinds);
      sql += ` AND kind = ANY($${params.length})`;
    }
    const status = query.status ?? 'active';
    if (status !== 'all') {
      params.push(status);
      sql += ` AND status = $${params.length}`;
    }
    return sql;
  };

  return {
    name: 'postgres',

    async migrate() {
      await tx(async (c) => {
        // Two processes starting at once must not both apply the same migration.
        await c.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK]);
        await c.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
        await c.query(
          'CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY, name text NOT NULL, applied_at timestamptz NOT NULL)'
        );
        const applied = new Set((await q('SELECT version FROM schema_migrations', [], c)).map((r) => Number(r.version)));
        for (const m of MIGRATIONS) {
          if (applied.has(m.version)) continue;
          await c.query(m.sql);
          await c.query('INSERT INTO schema_migrations (version, name, applied_at) VALUES ($1, $2, now())', [m.version, m.name]);
        }
      });
    },

    async upsertSubjects(subjects) {
      if (!subjects.length) return;
      await q(
        `INSERT INTO subjects (type, id, name, connector, meta, updated_at)
         SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::jsonb[]) , LATERAL (SELECT now()) n
         ON CONFLICT (type, id) DO UPDATE SET name = excluded.name, connector = excluded.connector,
           meta = excluded.meta, updated_at = excluded.updated_at`,
        [
          subjects.map((s) => s.type),
          subjects.map((s) => s.id),
          subjects.map((s) => s.name),
          subjects.map((s) => s.connector),
          subjects.map((s) => (s.meta ? JSON.stringify(s.meta) : null))
        ]
      );
    },

    async getSubject(ref) {
      const [r] = await q('SELECT * FROM subjects WHERE type = $1 AND id = $2', [ref.type, ref.id]);
      return r ? toSubject(r) : null;
    },

    async findSubjects(text: string, type?: SubjectType) {
      const needle = text.trim().toLowerCase();
      if (!needle) return [];
      const exact = await q(
        'SELECT * FROM subjects WHERE (lower(name) = $1 OR lower(id) = $1) AND ($2::text IS NULL OR type = $2) LIMIT 20',
        [needle, type ?? null]
      );
      if (exact.length) return exact.map(toSubject);
      const like = needle.replace(/[\\%_]/g, (c) => `\\${c}`);
      return (
        await q('SELECT * FROM subjects WHERE lower(name) LIKE $1 AND ($2::text IS NULL OR type = $2) ORDER BY length(name) LIMIT 20', [
          `%${like}%`,
          type ?? null
        ])
      ).map(toSubject);
    },

    async getFact(id) {
      const rows = await q('SELECT * FROM facts WHERE id = $1', [id]);
      return (await toFacts(rows))[0] ?? null;
    },

    async upsertFacts(facts) {
      if (!facts.length) return;
      await tx(async (c) => {
        for (const f of facts) {
          await c.query(
            `INSERT INTO facts (id, subject_type, subject_id, kind, topic, statement, confidence, status, first_seen, last_seen, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
             ON CONFLICT (id) DO UPDATE SET statement = excluded.statement, topic = excluded.topic,
               confidence = excluded.confidence, status = excluded.status, first_seen = excluded.first_seen,
               last_seen = excluded.last_seen, updated_at = excluded.updated_at`,
            [f.id, f.subject.type, f.subject.id, f.kind, f.topic, f.statement, f.confidence, f.status, f.firstSeen, f.lastSeen, f.updatedAt]
          );
          await c.query('DELETE FROM evidence WHERE fact_id = $1', [f.id]);
          if (f.evidence.length) {
            await c.query(
              `INSERT INTO evidence (fact_id, connector, event_id, source, quote, occurred_at, url)
               SELECT $1, * FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::timestamptz[], $7::text[])
               ON CONFLICT DO NOTHING`,
              [
                f.id,
                f.evidence.map((e) => e.connector),
                f.evidence.map((e) => e.eventId),
                f.evidence.map((e) => e.source),
                f.evidence.map((e) => e.quote),
                f.evidence.map((e) => e.occurredAt),
                f.evidence.map((e) => e.url ?? null)
              ]
            );
          }
        }
      });
    },

    async listFacts(query: FactQuery) {
      const params: unknown[] = [];
      const where = filters(query, params);
      params.push(query.limit ?? 200);
      return toFacts(await q(`SELECT * FROM facts WHERE true${where} ORDER BY confidence DESC, last_seen DESC LIMIT $${params.length}`, params));
    },

    async searchFacts(query: SearchQuery) {
      const words = [...new Set(query.text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [])].slice(0, 12);
      if (!words.length) return [];
      const params: unknown[] = [words.map((w) => `%${w.replace(/[\\%_]/g, (c) => `\\${c}`)}%`)];
      // One point per search word found in the statement or topic.
      const score = `(SELECT count(*) FROM unnest($1::text[]) w WHERE lower(f.statement) LIKE w OR lower(f.topic) LIKE w)`;
      const where = filters({ subject: query.subject, status: query.status }, params);
      params.push(query.limit ?? 20);
      const rows = await q(
        `SELECT * FROM (SELECT f.*, ${score} AS score FROM facts f WHERE true${where}) s
         WHERE score > 0 ORDER BY score DESC, confidence DESC, last_seen DESC LIMIT $${params.length}`,
        params
      );
      return toFacts(rows);
    },

    async filterNewEvents(connector, events: readonly ProcessedEvent[]) {
      if (!events.length) return [];
      const known = new Map(
        (await q('SELECT event_id, hash FROM source_events WHERE connector = $1 AND event_id = ANY($2)', [connector, events.map((e) => e.id)])).map(
          (r) => [String(r.event_id), String(r.hash)]
        )
      );
      return events.filter((e) => known.get(e.id) !== e.hash);
    },

    async markEventsProcessed(connector, events) {
      if (!events.length) return;
      await q(
        `INSERT INTO source_events (connector, event_id, hash, processed_at)
         SELECT $1, id, hash, now() FROM unnest($2::text[], $3::text[]) AS t(id, hash)
         ON CONFLICT (connector, event_id) DO UPDATE SET hash = excluded.hash, processed_at = excluded.processed_at`,
        [connector, events.map((e) => e.id), events.map((e) => e.hash)]
      );
    },

    async getCheckpoint(connector) {
      const [r] = await q('SELECT at FROM sync_checkpoints WHERE connector = $1', [connector]);
      return r ? new Date(iso(r.at)) : null;
    },

    async setCheckpoint(connector, at) {
      await q(
        'INSERT INTO sync_checkpoints (connector, at) VALUES ($1, $2) ON CONFLICT (connector) DO UPDATE SET at = excluded.at',
        [connector, at.toISOString()]
      );
    },

    async recordRun(r: RunRecord) {
      await q(
        `INSERT INTO extraction_runs (id, connector, started_at, finished_at, status, events_seen, events_processed,
           facts_extracted, facts_rejected, facts_written, input_tokens, output_tokens, cost_usd, error)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         ON CONFLICT (id) DO NOTHING`,
        [r.id, r.connector, r.startedAt, r.finishedAt, r.status, r.eventsSeen, r.eventsProcessed, r.factsExtracted, r.factsRejected,
          r.factsWritten, r.inputTokens, r.outputTokens, r.costUsd, r.error ?? null]
      );
    },

    async listRuns(limit) {
      return (await q('SELECT * FROM extraction_runs ORDER BY started_at DESC LIMIT $1', [limit])).map((r) => ({
        id: String(r.id),
        connector: String(r.connector),
        startedAt: iso(r.started_at),
        finishedAt: iso(r.finished_at),
        status: String(r.status) as RunRecord['status'],
        eventsSeen: Number(r.events_seen),
        eventsProcessed: Number(r.events_processed),
        factsExtracted: Number(r.facts_extracted),
        factsRejected: Number(r.facts_rejected),
        factsWritten: Number(r.facts_written),
        inputTokens: Number(r.input_tokens),
        outputTokens: Number(r.output_tokens),
        costUsd: Number(r.cost_usd),
        ...(r.error ? { error: String(r.error) } : {})
      }));
    },

    async costSince(since) {
      const [r] = await q('SELECT COALESCE(SUM(cost_usd), 0) AS total FROM extraction_runs WHERE started_at >= $1', [since.toISOString()]);
      return Number(r?.total ?? 0);
    },

    async stats(): Promise<StoreStats> {
      const [r] = await q(`SELECT
        (SELECT count(*) FROM subjects) AS subjects,
        (SELECT count(*) FROM facts) AS facts,
        (SELECT count(*) FROM facts WHERE status = 'active') AS active_facts,
        (SELECT count(*) FROM evidence) AS evidence,
        (SELECT count(*) FROM source_events) AS processed_events`);
      return {
        subjects: Number(r?.subjects ?? 0),
        facts: Number(r?.facts ?? 0),
        activeFacts: Number(r?.active_facts ?? 0),
        evidence: Number(r?.evidence ?? 0),
        processedEvents: Number(r?.processed_events ?? 0)
      };
    },

    async close() {
      await pool.end();
    }
  };
}
