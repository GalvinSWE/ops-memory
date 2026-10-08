/** Written by `ops-memory init`. Kept in sync with examples/cleanover/ops-memory.config.ts. */
export const CONFIG_TEMPLATE = `import { defineConfig } from '@ops-memory/core';
import { cleanover } from '@ops-memory/connector-cleanover';
import { sqlite } from '@ops-memory/store-sqlite';
import { anthropic } from '@ops-memory/llm-anthropic';

const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(\`Set \${name} in .env (see .env.example)\`);
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
  llm: anthropic(),

  subjects: ['unit'],
  factKinds: ['recurring_issue', 'equipment', 'access_info', 'guest_question'],
  sources: ['maintenance_ticket', 'maintenance_comment', 'review'],

  sync: { backfillDays: 180, maxEventsPerRun: 500 },
  budget: { maxUsdPerDay: 5 },
  log: (line) => console.error(line)
});
`;
