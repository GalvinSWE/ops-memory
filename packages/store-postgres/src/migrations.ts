/**
 * Schema versions for Postgres, applied in order and recorded in `schema_migrations`. Same tables
 * and meaning as the SQLite store. Never edit a released migration; add the next one.
 */
export const MIGRATIONS: { version: number; name: string; sql: string }[] = [
  {
    version: 1,
    name: 'initial',
    sql: `
      CREATE TABLE subjects (
        type        text NOT NULL,
        id          text NOT NULL,
        name        text NOT NULL,
        connector   text NOT NULL,
        meta        jsonb,
        updated_at  timestamptz NOT NULL,
        PRIMARY KEY (type, id)
      );
      CREATE INDEX subjects_name ON subjects (lower(name));

      CREATE TABLE facts (
        id            text PRIMARY KEY,
        subject_type  text NOT NULL,
        subject_id    text NOT NULL,
        kind          text NOT NULL,
        topic         text NOT NULL,
        statement     text NOT NULL,
        confidence    double precision NOT NULL,
        status        text NOT NULL CHECK (status IN ('active', 'resolved')),
        first_seen    timestamptz NOT NULL,
        last_seen     timestamptz NOT NULL,
        updated_at    timestamptz NOT NULL
      );
      CREATE INDEX facts_subject ON facts (subject_type, subject_id, status);
      CREATE INDEX facts_kind ON facts (kind);

      CREATE TABLE evidence (
        fact_id      text NOT NULL REFERENCES facts (id) ON DELETE CASCADE,
        connector    text NOT NULL,
        event_id     text NOT NULL,
        source       text NOT NULL,
        quote        text NOT NULL,
        occurred_at  timestamptz NOT NULL,
        url          text,
        PRIMARY KEY (fact_id, connector, event_id)
      );

      CREATE TABLE source_events (
        connector     text NOT NULL,
        event_id      text NOT NULL,
        hash          text NOT NULL,
        processed_at  timestamptz NOT NULL,
        PRIMARY KEY (connector, event_id)
      );

      CREATE TABLE sync_checkpoints (
        connector  text PRIMARY KEY,
        at         timestamptz NOT NULL
      );

      CREATE TABLE extraction_runs (
        id                text PRIMARY KEY,
        connector         text NOT NULL,
        started_at        timestamptz NOT NULL,
        finished_at       timestamptz NOT NULL,
        status            text NOT NULL,
        events_seen       integer NOT NULL,
        events_processed  integer NOT NULL,
        facts_extracted   integer NOT NULL,
        facts_rejected    integer NOT NULL,
        facts_written     integer NOT NULL,
        input_tokens      bigint NOT NULL,
        output_tokens     bigint NOT NULL,
        cost_usd          double precision NOT NULL,
        error             text
      );
      CREATE INDEX extraction_runs_started ON extraction_runs (started_at);
    `
  }
];
