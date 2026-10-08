# Configuration

A config file default-exports `defineConfig({...})`. The CLI looks for `ops-memory.config.ts`,
`.mts`, `.mjs` or `.js` in the current folder, or takes `--config <file>`. A `.env` file next to the
config is loaded first. TypeScript configs are run through `tsx`; no build step is needed.

```ts
import { defineConfig } from '@ops-memory/core';

export default defineConfig({
  connectors: [/* … */],
  store: /* … */,
  llm: /* … */,
  subjects: ['unit'],
  factKinds: ['recurring_issue', 'equipment', 'access_info', 'guest_question'],
  sources: [],
  sync: { backfillDays: 180, batchSize: 15, maxBatchChars: 24000, maxEventsPerRun: 500, concurrency: 4 },
  budget: { maxUsdPerDay: 5 },
  privacy: { rules: ['email', 'phone', 'access_code', 'url_token'] },
  log: (line) => console.error(line)
});
```

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `connectors` | required | One or more `Connector`s. Names must be unique. |
| `store` | required | Where facts live, e.g. `sqlite({ path })`. |
| `llm` | required | Model provider, e.g. `anthropic()`. |
| `subjects` | `['unit']` | Subject types to profile. Adding `guest` or `staff` profiles people: decide that deliberately. |
| `factKinds` | 4 kinds, see below | Built-in kind names or your own `FactKind` objects, mixed freely. |
| `sources` | all of each connector's | Source names to read, e.g. `['maintenance_ticket', 'review']`. Unknown names are ignored by connectors. |
| `sync.backfillDays` | `180` | First run reads this far back. Later runs continue from the checkpoint. |
| `sync.batchSize` | `15` | Events of one subject per model request. Lower it if a run fails with `max_tokens`. |
| `sync.maxBatchChars` | `24000` | Characters of event text per request. A longer event is cut to this length. |
| `sync.maxEventsPerRun` | `500` | Events read per run per connector. Raise it (or pass `--max-events`) for a backfill. |
| `sync.concurrency` | `4` | Model requests in flight. Same-subject batches always run in order. |
| `budget.maxUsdPerDay` | `5` | Estimated spend cap per UTC day, across all runs, from the provider's price table. |
| `privacy.rules` | all four | Which redaction rules run: `email`, `phone`, `access_code`, `url_token`. |
| `privacy.patterns` | none | Extra `RegExp`s (with the `g` flag) replaced by `[REDACTED]`. |
| `log` | silent | Receives progress lines. The CLI templates send them to stderr. |

## Fact kinds

| Name | Looks for | On by default |
| --- | --- | --- |
| `recurring_issue` | Something broken, unreliable, dirty, noisy, leaking, missing. | yes |
| `equipment` | Appliance or fixture facts: model, quirk, how to operate or reset, where it is. | yes |
| `access_info` | Entrance, parking, lockbox location, building door. Never the code itself. | yes |
| `guest_question` | What guests ask about or struggle with at this unit. | yes |
| `guest_praise` | What guests consistently like. | no |
| `cleaning_note` | What cleaners need to know: supplies, hard spots, recurring misses. | no |

A custom kind:

```ts
factKinds: [
  'recurring_issue',
  {
    name: 'pest',
    description: 'Pests seen in or around the unit (mice, ants, wasps), and what was done about them.',
    mergeKey: (f) => `pest:${f.topic}`   // optional; default is kind:topic
  }
]
```

The description is placed in the extraction prompt verbatim; write it the way you would brief a
person.

## Model provider (`@ops-memory/llm-anthropic`)

```ts
anthropic({
  extractModel: 'claude-opus-5-5',   // default
  answerModel: 'claude-opus-5-5',    // default
  effort: { extract: 'medium', answer: 'medium' },
  prices: { 'claude-opus-5-5': [4, 20] },   // USD per million tokens [input, output], for the budget
  client: new Anthropic({ /* proxy, retries, … */ })
})
```

Credentials come from `ANTHROPIC_API_KEY`, or from an `ant auth login` profile when the variable is
unset. The CleanOver example uses `claude-haiku-5-5` for extraction, which reads a lot of text on
every sync, and keeps Opus for answers; see [cleanover.md](cleanover.md#cost) for the numbers.

## CleanOver connector (`@ops-memory/connector-cleanover`)

```ts
cleanover({
  connectionString: process.env.CLEANOVER_DATABASE_URL!,
  businessId: undefined,                 // only this business
  url: ({ source, id, unitId, ticketId }) => undefined,   // optional link back into CleanOver
  pageSize: 500,
  name: 'cleanover'
})
```

Sources: `maintenance_ticket`, `maintenance_comment` (comments written by people; system log lines
are excluded), `review` (public text and private feedback, with the rating).

## Postgres store (`@ops-memory/store-postgres`)

```ts
postgres({
  connectionString: process.env.OPS_MEMORY_DATABASE_URL!,  // a database ops-memory owns
  schema: 'public',          // created if missing; lets tenants or tests share a database
  maxConnections: 5
})
```

Give ops-memory **its own database** (`CREATE DATABASE ops_memory`), on the same server as the
source if you like, never the source database itself: the connector only reads the source, the
store writes here. Migrations run on start, under an advisory lock so several processes can start
at once. Several readers (voice server, MCP, CLI) can share it across machines; still run `sync`
from one place.

To move an existing SQLite store over without re-reading events:

```bash
node scripts/sqlite-to-postgres.mjs ./ops-memory.db "$OPS_MEMORY_DATABASE_URL"
```

Stop `sync` and servers using the SQLite file first. The example configs pick Postgres whenever
`OPS_MEMORY_DATABASE_URL` is set.

The Postgres tests run against a throwaway schema when `OPS_MEMORY_TEST_DATABASE_URL` is set and
are skipped otherwise.

## SQLite store (`@ops-memory/store-sqlite`)

```ts
sqlite({ path: './ops-memory.db' })   // or ':memory:' in tests
```

Parent folders are created. One process should run `sync` at a time; readers (`ask`, `serve`) can
run alongside it (WAL mode).
