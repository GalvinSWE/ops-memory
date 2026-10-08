/**
 * ops-memory for CleanOver with a local model through Ollama: free, nothing leaves the machine.
 * Same sources and store as ops-memory.config.ts, so facts from either config land in one place.
 *
 *   brew install ollama && ollama serve        # in another terminal
 *   ollama pull qwen2.5:7b
 *   npm run ops-memory -- sync --max-events 100 --config examples/cleanover/ops-memory.local.config.ts
 */
import { defineConfig } from '@ops-memory/core';
import { cleanover } from '@ops-memory/connector-cleanover';
import { sqlite } from '@ops-memory/store-sqlite';
import { ollama } from '@ops-memory/llm-ollama';

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
  store: sqlite({ path: process.env.OPS_MEMORY_DB ?? './ops-memory.db' }),
  llm: ollama({ extractModel: process.env.OLLAMA_MODEL ?? 'qwen2.5:7b' }),

  subjects: ['unit'],
  factKinds: ['recurring_issue', 'equipment', 'access_info', 'guest_question', 'cleaning_note'],
  sources: ['maintenance_ticket', 'maintenance_comment', 'review'],

  // Smaller batches than with Claude: a 7B model keeps quotes exact more often on short inputs,
  // and one model on one machine gains little from many requests at once.
  sync: { backfillDays: 180, maxEventsPerRun: 200, batchSize: 6, maxBatchChars: 8000, concurrency: 1 },
  log: (line) => console.error(line)
});
