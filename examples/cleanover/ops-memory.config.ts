/**
 * ops-memory for CleanOver. Reads units, maintenance tickets, their comments and guest reviews from
 * CleanOver's Postgres (read-only) and keeps unit facts in a local SQLite file.
 *
 *   cp .env.example examples/cleanover/.env   # then fill it in
 *   npx ops-memory sync --dry-run --config examples/cleanover/ops-memory.config.ts
 */
import { defineConfig } from '@ops-memory/core';
import { cleanover } from '@ops-memory/connector-cleanover';
import { sqlite } from '@ops-memory/store-sqlite';
import { postgres } from '@ops-memory/store-postgres';
import { anthropic } from '@ops-memory/llm-anthropic';

const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name} in .env next to this config (see .env.example)`);
  return value;
};

export default defineConfig({
  connectors: [
    cleanover({
      connectionString: required('CLEANOVER_DATABASE_URL'),
      businessId: process.env.CLEANOVER_BUSINESS_ID || undefined
    })
  ],
  // A Postgres database of its own when OPS_MEMORY_DATABASE_URL is set (never CleanOver's), else a SQLite file.
  store: process.env.OPS_MEMORY_DATABASE_URL
    ? postgres({ connectionString: process.env.OPS_MEMORY_DATABASE_URL })
    : sqlite({ path: process.env.OPS_MEMORY_DB ?? './ops-memory.db' }),

  // Extraction reads a lot of text and runs on every sync: Claude Haiku 5.5 keeps that cheap.
  // Answers are few and read by people: Claude Opus 5.5 by default. Both are one line to change.
  llm: anthropic({ extractModel: 'claude-haiku-5-5', answerModel: 'claude-opus-5-5' }),

  // Units only. Guests and staff are people: turn them on only after the business has decided to.
  subjects: ['unit'],
  factKinds: ['recurring_issue', 'equipment', 'access_info', 'guest_question', 'cleaning_note'],
  sources: ['maintenance_ticket', 'maintenance_comment', 'review'],

  sync: { backfillDays: 180, maxEventsPerRun: 500, batchSize: 15, concurrency: 4 },
  budget: { maxUsdPerDay: 5 },
  log: (line) => console.error(line)
});
