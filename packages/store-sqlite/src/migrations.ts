/**
 * Schema versions, applied in order and recorded in `schema_migrations`. Never edit a released
 * migration; add the next one.
 */
export const MIGRATIONS: { version: number; name: string; sql: string }[] = [
  {
    version: 1,
    name: 'initial',
    sql: `
      CREATE TABLE subjects (
        type        TEXT NOT NULL,
        id          TEXT NOT NULL,
        name        TEXT NOT NULL,
        connector   TEXT NOT NULL,
        meta        TEXT,
        updated_at  TEXT NOT NULL,
        PRIMARY KEY (type, id)
      );
      CREATE INDEX subjects_name ON subjects (lower(name));

      CREATE TABLE facts (
        id            TEXT PRIMARY KEY,
        subject_type  TEXT NOT NULL,
        subject_id    TEXT NOT NULL,
        kind          TEXT NOT NULL,
        topic         TEXT NOT NULL,
        statement     TEXT NOT NULL,
        confidence    REAL NOT NULL,
        status        TEXT NOT NULL CHECK (status IN ('active', 'resolved')),
        first_seen    TEXT NOT NULL,
        last_seen     TEXT NOT NULL,
        updated_at    TEXT NOT NULL
      );
      CREATE INDEX facts_subject ON facts (subject_type, subject_id, status);
      CREATE INDEX facts_kind ON facts (kind);

      CREATE TABLE evidence (
        fact_id      TEXT NOT NULL REFERENCES facts (id) ON DELETE CASCADE,
        connector    TEXT NOT NULL,
        event_id     TEXT NOT NULL,
        source       TEXT NOT NULL,
        quote        TEXT NOT NULL,
        occurred_at  TEXT NOT NULL,
        url          TEXT,
        PRIMARY KEY (fact_id, connector, event_id)
      );

      CREATE TABLE source_events (
        connector     TEXT NOT NULL,
        event_id      TEXT NOT NULL,
        hash          TEXT NOT NULL,
        processed_at  TEXT NOT NULL,
        PRIMARY KEY (connector, event_id)
      );

      CREATE TABLE sync_checkpoints (
        connector   TEXT PRIMARY KEY,
        at          TEXT NOT NULL
      );

      CREATE TABLE extraction_runs (
        id                TEXT PRIMARY KEY,
        connector         TEXT NOT NULL,
        started_at        TEXT NOT NULL,
        finished_at       TEXT NOT NULL,
        status            TEXT NOT NULL,
        events_seen       INTEGER NOT NULL,
        events_processed  INTEGER NOT NULL,
        facts_extracted   INTEGER NOT NULL,
        facts_rejected    INTEGER NOT NULL,
        facts_written     INTEGER NOT NULL,
        input_tokens      INTEGER NOT NULL,
        output_tokens     INTEGER NOT NULL,
        cost_usd          REAL NOT NULL,
        error             TEXT
      );
      CREATE INDEX extraction_runs_started ON extraction_runs (started_at);
    `
  }
];
