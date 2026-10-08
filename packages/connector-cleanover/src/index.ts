import pg from 'pg';
import type { Connector, ListEventsOptions, SourceEvent, SourceSubject, SubjectType } from '@ops-memory/core';
import {
  CONNECTOR_NAME,
  SOURCES,
  commentToEvent,
  reviewToEvent,
  ticketToEvent,
  unitToSubject,
  type CleanoverSource,
  type CommentRow,
  type ReviewRow,
  type TicketRow,
  type UnitRow,
  type UrlBuilder
} from './rows.js';

export interface CleanoverConnectorOptions {
  /** Postgres URL of the CleanOver database. Use a read-only role (docs/cleanover.md). */
  connectionString: string;
  /** Only read this business. Default: every business in the database. */
  businessId?: string;
  /** Builds a link back into CleanOver for each record, shown with the evidence. */
  url?: UrlBuilder;
  /** Rows fetched per query. Default 500. */
  pageSize?: number;
  /** Connector name, if you run more than one CleanOver connector. Default `cleanover`. */
  name?: string;
}

/**
 * Reads CleanOver's Postgres directly. Every connection is opened with
 * `default_transaction_read_only=on`, so a write fails even if the role could write.
 */
export function cleanover(options: CleanoverConnectorOptions): Connector {
  const pool = new pg.Pool({
    connectionString: options.connectionString,
    max: 2,
    options: '-c default_transaction_read_only=on -c statement_timeout=60000',
    application_name: 'ops-memory'
  });
  const pageSize = options.pageSize ?? 500;
  const biz = options.businessId ?? null;

  /** Keyset pagination on (time, id): stable even when many rows share a timestamp. */
  async function* pages<T extends { id: string }>(
    sql: string,
    timeOf: (row: T) => Date,
    since: Date,
    remaining: () => number
  ): AsyncGenerator<T> {
    let afterTime = since;
    let afterId = '00000000-0000-0000-0000-000000000000';
    while (remaining() > 0) {
      const { rows } = await pool.query<T>(sql, [afterTime, afterId, biz, Math.min(pageSize, remaining())]);
      for (const row of rows) yield row;
      if (rows.length < Math.min(pageSize, remaining() + rows.length)) return;
      const last = rows[rows.length - 1]!;
      afterTime = timeOf(last);
      afterId = last.id;
    }
  }

  const QUERIES: Record<CleanoverSource, { sql: string; time: string; toEvent: (row: never) => SourceEvent | null }> = {
    maintenance_ticket: {
      time: 'created_at',
      sql: `
        SELECT t.id, t.unit_id, t.name::text AS name, t.description, t.comment, s.name AS status_name,
               t.created_at, t.updated_at
        FROM maintenance_tickets t
        JOIN units u ON u.id = t.unit_id AND u.deleted_at IS NULL
        LEFT JOIN maintenance_ticket_statuses s ON s.id = t.ticket_maintenance_status_id
        WHERE t.deleted_at IS NULL
          AND (t.created_at, t.id) > ($1::timestamp, $2::uuid)
          AND ($3::uuid IS NULL OR t.business_id = $3::uuid)
        ORDER BY t.created_at, t.id
        LIMIT $4`,
      toEvent: (row: TicketRow) => ticketToEvent(row, options.url)
    },
    maintenance_comment: {
      time: 'created_at',
      // comment_type 1 is written by a person; 2 is the system's own change log.
      sql: `
        SELECT c.id, t.unit_id, t.id AS ticket_id, t.name::text AS ticket_name, c.content, c.created_at
        FROM ticket_maintenance_comments c
        JOIN maintenance_tickets t ON t.id = c.ticket_maintenance_id AND t.deleted_at IS NULL
        JOIN units u ON u.id = t.unit_id AND u.deleted_at IS NULL
        WHERE c.deleted_at IS NULL AND c.comment_type = 1
          AND (c.created_at, c.id) > ($1::timestamp, $2::uuid)
          AND ($3::uuid IS NULL OR t.business_id = $3::uuid)
        ORDER BY c.created_at, c.id
        LIMIT $4`,
      toEvent: (row: CommentRow) => commentToEvent(row, options.url)
    },
    review: {
      time: 'event_time',
      sql: `
        SELECT r.id, r.unit_id, r.overall_rating, r.review_text, r.private_feedback, r.submitted_at, r.created_at,
               COALESCE(r.submitted_at, r.created_at) AS event_time
        FROM reviews r
        JOIN units u ON u.id = r.unit_id AND u.deleted_at IS NULL
        WHERE r.deleted_at IS NULL AND r.unit_id IS NOT NULL
          AND (COALESCE(r.review_text, '') <> '' OR COALESCE(r.private_feedback, '') <> '')
          AND (COALESCE(r.submitted_at, r.created_at), r.id) > ($1::timestamp, $2::uuid)
          AND ($3::uuid IS NULL OR r.business_id = $3::uuid)
        ORDER BY COALESCE(r.submitted_at, r.created_at), r.id
        LIMIT $4`,
      toEvent: (row: ReviewRow) => reviewToEvent(row, options.url)
    }
  };

  return {
    name: options.name ?? CONNECTOR_NAME,

    async *listSubjects(types: SubjectType[]): AsyncIterable<SourceSubject> {
      if (!types.includes('unit')) return;
      const { rows } = await pool.query<UnitRow>(
        `SELECT id, alias, address, business_id FROM units
         WHERE deleted_at IS NULL AND ($1::uuid IS NULL OR business_id = $1::uuid)
         ORDER BY alias`,
        [biz]
      );
      for (const row of rows) yield unitToSubject(row);
    },

    async *listEvents({ since, sources, subjectTypes, limit }: ListEventsOptions): AsyncIterable<SourceEvent> {
      if (!subjectTypes.includes('unit')) return;
      const enabled = (sources.length ? sources : [...SOURCES]).filter((s): s is CleanoverSource =>
        (SOURCES as readonly string[]).includes(s)
      );

      // Each source is read up to `limit`, then all are merged in time order and cut to `limit`, so
      // the checkpoint never skips past an unread record of another source.
      const perSource = await Promise.all(
        enabled.map(async (source) => {
          const q = QUERIES[source];
          const out: SourceEvent[] = [];
          let read = 0;
          for await (const row of pages<{ id: string } & Record<string, unknown>>(
            q.sql,
            (r) => r[q.time] as Date,
            since,
            () => limit - read
          )) {
            read++;
            const event = q.toEvent(row as never);
            if (event) out.push(event);
          }
          return out;
        })
      );
      const merged = perSource.flat().sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.id.localeCompare(b.id));
      for (const event of merged.slice(0, limit)) yield event;
    },

    async close() {
      await pool.end();
    }
  };
}

export { SOURCES, CONNECTOR_NAME, unitToSubject, ticketToEvent, commentToEvent, reviewToEvent } from './rows.js';
export type { CleanoverSource, UrlBuilder, UnitRow, TicketRow, CommentRow, ReviewRow } from './rows.js';
