# Writing plugins

Four things are pluggable. Each is a plain object implementing an interface from
`@ops-memory/core` (`packages/core/src/plugins.ts`); none needs a base class.

| Plugin | Interface | Built-in |
| --- | --- | --- |
| Where knowledge comes from | `Connector` | `cleanover()` |
| Where facts are kept | `Store` | `sqlite()` |
| Who reads and answers | `LlmProvider` | `anthropic()` |
| What to look for | `FactKind` | six kinds, see [configuration.md](configuration.md#fact-kinds) |

## Connector

```ts
interface Connector {
  readonly name: string;
  listSubjects(types: SubjectType[]): AsyncIterable<SourceSubject>;
  listEvents(options: ListEventsOptions): AsyncIterable<SourceEvent>;
  close?(): Promise<void>;
}
```

The contract:

1. **Read-only.** Never write to the source. Open database sessions read-only where the driver
   allows it.
2. **Oldest first.** `listEvents` yields events in `occurredAt` order. The checkpoint is the time of
   the last event of a completed run, so out-of-order events could be skipped.
3. **Strictly after `since`, at most `limit`.** Read each source up to `limit`, merge them in time
   order, cut to `limit`. Use keyset pagination on `(time, id)` so equal timestamps are not lost.
4. **Stable ids.** `event.id` must be the same for the same record on every run; prefix it with
   the source (`review:<uuid>`) so ids from different tables cannot collide.
5. **Text for people.** `event.text` is what the model reads. Label the parts ("Status: Open",
   "Private feedback to the host:") and leave out ids and machine fields.
6. **No personal fields.** Do not put names, contact details or author ids into `text`. Redaction
   is a safety net, not a filter.
7. **Honour `sources` and `subjectTypes`.** Skip sources not listed (an empty list means all of
   yours) and yield nothing for subject types you do not serve.

Keep the row-to-event mapping in pure functions (see `packages/connector-cleanover/src/rows.ts`) so
it can be tested without a database.

### Example: a CSV export

```ts
import { readFileSync } from 'node:fs';
import type { Connector } from '@ops-memory/core';

export function ticketsCsv(path: string): Connector {
  const rows = readFileSync(path, 'utf8').trim().split('\n').slice(1).map((l) => l.split(','));
  return {
    name: 'tickets-csv',
    async *listSubjects() {
      const units = new Set(rows.map((r) => r[1]!));
      for (const u of units) yield { type: 'unit', id: u, name: u, connector: 'tickets-csv' };
    },
    async *listEvents({ since, limit }) {
      const events = rows
        .map(([id, unit, date, text]) => ({
          id: `ticket:${id}`, source: 'ticket', subject: { type: 'unit', id: unit! },
          occurredAt: new Date(date!).toISOString(), text: text!
        }))
        .filter((e) => new Date(e.occurredAt) > since)
        .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt))
        .slice(0, limit);
      yield* events;
    }
  };
}
```

## Store

Implement every method of `Store`. Points that matter:

- `migrate()` runs on every start: make it idempotent and versioned.
- `upsertFacts()` replaces a fact's evidence with the list given (the pipeline always passes the
  full, merged list).
- `filterNewEvents()` returns events that are unseen **or** whose hash changed.
- `costSince()` sums `costUsd` of runs started at or after the given time; the budget depends on it.
- `searchFacts()` may be as simple as keyword matching; rank by relevance, then confidence.

Run the store tests in `packages/store-sqlite/test` against your implementation as a starting point.

## LLM provider

```ts
interface LlmProvider {
  readonly name: string;
  extract(req: { subject; kinds; events }): Promise<{ facts: ExtractedFact[]; usage: LlmUsage }>;
  answer(req: { question; facts; subjects }): Promise<{ answer: string; usage: LlmUsage }>;
}
```

- `extract` returns facts whose `quote` is copied from the event text. The pipeline verifies this;
  a provider that paraphrases produces only rejections.
- Report `usage.costUsd` honestly: the daily budget is built on it.
- On a refusal, return no facts rather than throwing, so the rest of the run continues. Throw on
  truncated output so the batch is retried in a later run.

## Fact kind

```ts
{ name: 'pest', description: 'Pests seen in or around the unit, and what was done.', mergeKey: (f) => `pest:${f.topic}` }
```

Write `description` as a brief to a person: what counts, what does not, how to name the topic.

## Testing helpers

`@ops-memory/core/testing` has:

- `memoryConnector(name, subjects, events)`: a connector over arrays that follows the contract.
- `scriptedLlm(rule)`: a provider that maps each event to facts with a function, recording requests.
- `quoteFrom(event, phrase)`: returns the phrase exactly as it appears in the event text.

```ts
const memory = createMemory({
  connectors: [memoryConnector('demo', subjects, events)],
  store: sqlite({ path: ':memory:' }),
  llm: scriptedLlm((e) => [{ kind: 'recurring_issue', topic: 'wifi', statement: 'Wifi drops.', quote: quoteFrom(e, 'wifi drops') }])
});
```
