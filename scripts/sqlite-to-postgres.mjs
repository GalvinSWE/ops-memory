#!/usr/bin/env node
/**
 * Copies an ops-memory SQLite store into a Postgres store, so a switch keeps every fact and does
 * not re-read (and re-pay for) events already processed.
 *
 *   node scripts/sqlite-to-postgres.mjs <sqlite file> <postgres url> [schema]
 *
 * Stop `sync` and any server using the SQLite file first. The Postgres tables are created if
 * missing. Rows already in Postgres are kept; copied rows overwrite them by primary key.
 */
import { DatabaseSync } from 'node:sqlite';
import pg from 'pg';
import { postgres } from '@ops-memory/store-postgres';

const [file, url, schema = 'public'] = process.argv.slice(2);
if (!file || !url) {
  console.error('usage: node scripts/sqlite-to-postgres.mjs <sqlite file> <postgres url> [schema]');
  process.exit(1);
}

// Create the tables through the store itself, so the schema is exactly the one it expects.
const store = postgres({ connectionString: url, schema });
await store.migrate();
await store.close();

const db = new DatabaseSync(file, { readOnly: true });
const client = new pg.Client({ connectionString: url, options: `-c search_path=${schema}` });
await client.connect();

const TABLES = [
  { name: 'subjects', key: ['type', 'id'], json: ['meta'] },
  { name: 'facts', key: ['id'] },
  { name: 'evidence', key: ['fact_id', 'connector', 'event_id'] },
  { name: 'source_events', key: ['connector', 'event_id'] },
  { name: 'sync_checkpoints', key: ['connector'] },
  { name: 'extraction_runs', key: ['id'] }
];

try {
  await client.query('BEGIN');
  for (const table of TABLES) {
    const rows = db.prepare(`SELECT * FROM ${table.name}`).all();
    if (!rows.length) {
      console.log(`${table.name}: 0`);
      continue;
    }
    const columns = Object.keys(rows[0]);
    const updates = columns.filter((c) => !table.key.includes(c));
    const set = updates.length ? `DO UPDATE SET ${updates.map((c) => `${c} = excluded.${c}`).join(', ')}` : 'DO NOTHING';
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500);
      const params = [];
      const values = chunk.map((row) => {
        const placeholders = columns.map((c) => {
          params.push(row[c] ?? null);
          return `$${params.length}`;
        });
        return `(${placeholders.join(', ')})`;
      });
      await client.query(
        `INSERT INTO ${table.name} (${columns.join(', ')}) VALUES ${values.join(', ')} ON CONFLICT (${table.key.join(', ')}) ${set}`,
        params
      );
    }
    console.log(`${table.name}: ${rows.length}`);
  }
  await client.query('COMMIT');
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  await client.end();
  db.close();
}
