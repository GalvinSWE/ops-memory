import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
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

export interface SqliteStoreOptions {
  /** File path, or `:memory:` for tests. Parent folders are created. */
  path: string;
}

type Row = Record<string, SQLInputValue>;

/**
 * A single-file store. Fits one office's memory comfortably (hundreds of units, tens of thousands
 * of facts). One process should write to it at a time: run `sync` from one place only.
 */
export function sqlite(options: SqliteStoreOptions): Store {
  if (options.path !== ':memory:') mkdirSync(dirname(options.path), { recursive: true });
  const db = new DatabaseSync(options.path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

  const all = (sql: string, ...params: SQLInputValue[]) => db.prepare(sql).all(...params) as Row[];
  const get = (sql: string, ...params: SQLInputValue[]) => db.prepare(sql).get(...params) as Row | undefined;
  const run = (sql: string, ...params: SQLInputValue[]) => db.prepare(sql).run(...params);
  const tx = <T>(fn: () => T): T => {
    db.exec('BEGIN');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  };

  const toSubject = (r: Row): SourceSubject => ({
    type: String(r.type),
    id: String(r.id),
    name: String(r.name),
    connector: String(r.connector),
    ...(r.meta ? { meta: JSON.parse(String(r.meta)) } : {})
  });

  const evidenceFor = (factIds: string[]): Map<string, Evidence[]> => {
    const byFact = new Map<string, Evidence[]>();
    if (!factIds.length) return byFact;
    // Chunked: SQLite caps the number of bound parameters.
    for (let i = 0; i < factIds.length; i += 500) {
      const chunk = factIds.slice(i, i + 500);
      const rows = all(
        `SELECT * FROM evidence WHERE fact_id IN (${chunk.map(() => '?').join(',')}) ORDER BY occurred_at`,
        ...chunk
      );
      for (const r of rows) {
        const list = byFact.get(String(r.fact_id)) ?? [];
        list.push({
          eventId: String(r.event_id),
          connector: String(r.connector),
          source: String(r.source),
          quote: String(r.quote),
          occurredAt: String(r.occurred_at),
          ...(r.url ? { url: String(r.url) } : {})
        });
        byFact.set(String(r.fact_id), list);
      }
    }
    return byFact;
  };

  const toFacts = (rows: Row[]): Fact[] => {
    const evidence = evidenceFor(rows.map((r) => String(r.id)));
    return rows.map((r) => ({
      id: String(r.id),
      subject: { type: String(r.subject_type), id: String(r.subject_id) },
      kind: String(r.kind),
      topic: String(r.topic),
      statement: String(r.statement),
      confidence: Number(r.confidence),
      status: String(r.status) as Fact['status'],
      evidence: evidence.get(String(r.id)) ?? [],
      firstSeen: String(r.first_seen),
      lastSeen: String(r.last_seen),
      updatedAt: String(r.updated_at)
    }));
  };

  const statusClause = (status: FactQuery['status'], params: SQLInputValue[]) => {
    const s = status ?? 'active';
    if (s === 'all') return '';
    params.push(s);
    return ' AND status = ?';
  };

  return {
    name: 'sqlite',

    async migrate() {
      db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
      const applied = new Set(all('SELECT version FROM schema_migrations').map((r) => Number(r.version)));
      for (const m of MIGRATIONS) {
        if (applied.has(m.version)) continue;
        tx(() => {
          db.exec(m.sql);
          run('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)', m.version, m.name, new Date().toISOString());
        });
      }
    },

    async upsertSubjects(subjects) {
      const now = new Date().toISOString();
      const stmt = db.prepare(
        `INSERT INTO subjects (type, id, name, connector, meta, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (type, id) DO UPDATE SET name = excluded.name, connector = excluded.connector,
           meta = excluded.meta, updated_at = excluded.updated_at`
      );
      tx(() => {
        for (const s of subjects) stmt.run(s.type, s.id, s.name, s.connector, s.meta ? JSON.stringify(s.meta) : null, now);
      });
    },

    async getSubject(ref: SubjectRef) {
      const r = get('SELECT * FROM subjects WHERE type = ? AND id = ?', ref.type, ref.id);
      return r ? toSubject(r) : null;
    },

    async findSubjects(text: string, type?: SubjectType) {
      const needle = text.trim().toLowerCase();
      if (!needle) return [];
      const params: SQLInputValue[] = [needle, needle];
      let sql = 'SELECT * FROM subjects WHERE (lower(name) = ? OR lower(id) = ?)';
      if (type) {
        sql += ' AND type = ?';
        params.push(type);
      }
      const exact = all(sql + ' LIMIT 20', ...params);
      if (exact.length) return exact.map(toSubject);
      const likeParams: SQLInputValue[] = [`%${needle}%`];
      let likeSql = 'SELECT * FROM subjects WHERE lower(name) LIKE ?';
      if (type) {
        likeSql += ' AND type = ?';
        likeParams.push(type);
      }
      return all(likeSql + ' ORDER BY length(name) LIMIT 20', ...likeParams).map(toSubject);
    },

    async getFact(id) {
      const r = get('SELECT * FROM facts WHERE id = ?', id);
      return r ? (toFacts([r])[0] ?? null) : null;
    },

    async upsertFacts(facts) {
      const upsert = db.prepare(
        `INSERT INTO facts (id, subject_type, subject_id, kind, topic, statement, confidence, status, first_seen, last_seen, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET statement = excluded.statement, topic = excluded.topic,
           confidence = excluded.confidence, status = excluded.status, first_seen = excluded.first_seen,
           last_seen = excluded.last_seen, updated_at = excluded.updated_at`
      );
      const clearEvidence = db.prepare('DELETE FROM evidence WHERE fact_id = ?');
      const addEvidence = db.prepare(
        `INSERT OR REPLACE INTO evidence (fact_id, connector, event_id, source, quote, occurred_at, url)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      );
      tx(() => {
        for (const f of facts) {
          upsert.run(f.id, f.subject.type, f.subject.id, f.kind, f.topic, f.statement, f.confidence, f.status, f.firstSeen, f.lastSeen, f.updatedAt);
          clearEvidence.run(f.id);
          for (const e of f.evidence) addEvidence.run(f.id, e.connector, e.eventId, e.source, e.quote, e.occurredAt, e.url ?? null);
        }
      });
    },

    async listFacts(query: FactQuery) {
      const params: SQLInputValue[] = [];
      let sql = 'SELECT * FROM facts WHERE 1 = 1';
      if (query.subject) {
        sql += ' AND subject_type = ? AND subject_id = ?';
        params.push(query.subject.type, query.subject.id);
      }
      if (query.kinds?.length) {
        sql += ` AND kind IN (${query.kinds.map(() => '?').join(',')})`;
        params.push(...query.kinds);
      }
      sql += statusClause(query.status, params);
      sql += ' ORDER BY confidence DESC, last_seen DESC LIMIT ?';
      params.push(query.limit ?? 200);
      return toFacts(all(sql, ...params));
    },

    async searchFacts(query: SearchQuery) {
      // Keyword search over statement and topic, ranked by how many words match, then confidence.
      // Semantic (embedding) search is on the roadmap; see docs/roadmap.md.
      const words = [...new Set((query.text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []))].slice(0, 12);
      if (!words.length) return [];
      const params: SQLInputValue[] = [];
      const score = words
        .map((w) => {
          params.push(`%${w}%`, `%${w}%`);
          return '(CASE WHEN lower(statement) LIKE ? OR lower(topic) LIKE ? THEN 1 ELSE 0 END)';
        })
        .join(' + ');
      let sql = `SELECT *, (${score}) AS score FROM facts WHERE 1 = 1`;
      if (query.subject) {
        sql += ' AND subject_type = ? AND subject_id = ?';
        params.push(query.subject.type, query.subject.id);
      }
      sql += statusClause(query.status, params);
      sql += ' AND score > 0 ORDER BY score DESC, confidence DESC, last_seen DESC LIMIT ?';
      params.push(query.limit ?? 20);
      return toFacts(all(sql, ...params));
    },

    async filterNewEvents(connector, events: readonly ProcessedEvent[]) {
      const fresh: ProcessedEvent[] = [];
      const stmt = db.prepare('SELECT hash FROM source_events WHERE connector = ? AND event_id = ?');
      for (const e of events) {
        const row = stmt.get(connector, e.id) as Row | undefined;
        if (!row || String(row.hash) !== e.hash) fresh.push(e);
      }
      return fresh;
    },

    async markEventsProcessed(connector, events) {
      const now = new Date().toISOString();
      const stmt = db.prepare(
        `INSERT INTO source_events (connector, event_id, hash, processed_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (connector, event_id) DO UPDATE SET hash = excluded.hash, processed_at = excluded.processed_at`
      );
      tx(() => {
        for (const e of events) stmt.run(connector, e.id, e.hash, now);
      });
    },

    async getCheckpoint(connector) {
      const r = get('SELECT at FROM sync_checkpoints WHERE connector = ?', connector);
      return r ? new Date(String(r.at)) : null;
    },

    async setCheckpoint(connector, at) {
      run(
        'INSERT INTO sync_checkpoints (connector, at) VALUES (?, ?) ON CONFLICT (connector) DO UPDATE SET at = excluded.at',
        connector,
        at.toISOString()
      );
    },

    async recordRun(r: RunRecord) {
      run(
        `INSERT INTO extraction_runs (id, connector, started_at, finished_at, status, events_seen, events_processed,
           facts_extracted, facts_rejected, facts_written, input_tokens, output_tokens, cost_usd, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        r.id, r.connector, r.startedAt, r.finishedAt, r.status, r.eventsSeen, r.eventsProcessed, r.factsExtracted,
        r.factsRejected, r.factsWritten, r.inputTokens, r.outputTokens, r.costUsd, r.error ?? null
      );
    },

    async listRuns(limit) {
      return all('SELECT * FROM extraction_runs ORDER BY started_at DESC LIMIT ?', limit).map((r) => ({
        id: String(r.id),
        connector: String(r.connector),
        startedAt: String(r.started_at),
        finishedAt: String(r.finished_at),
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
      const r = get('SELECT COALESCE(SUM(cost_usd), 0) AS total FROM extraction_runs WHERE started_at >= ?', since.toISOString());
      return Number(r?.total ?? 0);
    },

    async stats(): Promise<StoreStats> {
      const count = (sql: string) => Number(get(sql)?.n ?? 0);
      return {
        subjects: count('SELECT COUNT(*) AS n FROM subjects'),
        facts: count('SELECT COUNT(*) AS n FROM facts'),
        activeFacts: count("SELECT COUNT(*) AS n FROM facts WHERE status = 'active'"),
        evidence: count('SELECT COUNT(*) AS n FROM evidence'),
        processedEvents: count('SELECT COUNT(*) AS n FROM source_events')
      };
    },

    async close() {
      if (db.isOpen) db.close();
    }
  };
}
