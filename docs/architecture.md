# Architecture

ops-memory turns records into facts in one direction, and answers questions from facts.

```text
 Source system (read-only)          ops-memory                                   Readers
┌──────────────────────┐   ┌────────────────────────────────────────────┐   ┌─────────────────┐
│ CleanOver Postgres   │──▶│ Connector ─▶ redact ─▶ LLM extract          │   │ CLI             │
│ (tickets, comments,  │   │                          │                  │   │ MCP (Claude)    │
│  reviews, units)     │   │                 verify quotes ─▶ merge ─────┼──▶│ library (ask)   │
└──────────────────────┘   │                                    │        │   └─────────────────┘
                           │                              Store (SQLite) │
                           └────────────────────────────────────────────┘
```

## Concepts

| Term | Meaning |
| --- | --- |
| **Subject** | What a fact is about. Built in: `unit` (default), `guest`, `staff`. Stored as id and name only. |
| **Event** | One source record that may hold knowledge: a ticket, a comment, a review. Has `id`, `source`, `subject`, `occurredAt`, `text`. |
| **Fact** | One durable statement about a subject, with a kind, a topic, a status, a confidence and evidence. |
| **Evidence** | A verbatim quote from one event, with the event id, source, date and an optional link back. |
| **Fact kind** | A category of knowledge to look for. Its description is part of the extraction prompt. |

## Sync, step by step

`memory.sync()` runs each connector in turn (`packages/core/src/pipeline.ts`):

1. **Subjects.** The connector lists subjects of the enabled types. Ids and names are upserted so
   that a question can name a unit.
2. **Events since the checkpoint.** On the first run the checkpoint is `now − backfillDays`. The
   connector returns events oldest first, at most `maxEventsPerRun`.
3. **Skip what is known.** Each event's text is hashed; events already processed with the same hash
   are skipped. An edited record is read again.
4. **Redact.** Codes, phone numbers, emails and URL tokens are replaced with `[REDACTED_*]`. From
   here on only redacted text exists in the pipeline.
5. **Batch by subject.** One subject's events are grouped into requests of at most `batchSize`
   events and `maxBatchChars` characters. An oversized event is cut, not dropped.
6. **Extract.** The model returns `{eventId, kind, topic, statement, quote, resolved}` for each
   piece of lasting knowledge, using structured output so the shape is guaranteed.
7. **Verify.** A fact is kept only if its event was in the request, its kind is enabled, and its
   quote is found in that event's text (case, whitespace and typographic quotes ignored). Rejected
   facts are counted and logged with the reason.
8. **Merge.** Verified facts fold into stored facts (below). Batches of the same subject run one
   after another; different subjects run in parallel up to `concurrency`.
9. **Mark and checkpoint.** Processed events are recorded with their hash. The checkpoint moves to
   the last event read only when the run completes, so a run stopped by the budget is resumed, not
   skipped.
10. **Record the run.** Counts, tokens and estimated cost go to `extraction_runs`; the daily budget
    is enforced from this table.

## Merging and resolution

Each fact has a **merge key**, by default `kind:topic` with the topic slugged (`Hot Water` →
`hot_water`). The fact id is a hash of the subject and the merge key, so the same knowledge always
lands on the same fact across runs and machines. A `FactKind` can supply its own `mergeKey`.

| A verified extraction… | Effect |
| --- | --- |
| has no existing fact | Creates one: status `active` (or `resolved` if the record says it was fixed), confidence 0.5. |
| repeats an existing fact | Adds evidence; confidence becomes `1 − 0.5^n` (0.5, 0.75, 0.875…); the newest record's statement wins. |
| says it was fixed (`resolved: true`) and is the newest record | Status becomes `resolved`. |
| reports the problem again after a resolution | Status returns to `active`: it came back. |
| is older than the fact's last evidence | Adds evidence and widens `firstSeen`, but does not change the current status or statement. |
| comes from an event already in the evidence | Ignored; one record never counts twice. |

At most 20 pieces of evidence are kept per fact (the newest); confidence still reflects the full count.

## Answering

`memory.ask(question)`:

1. Finds subjects named in the question by matching stored subject names as whole words, so
   "Pine 2" does not match "Pine 21". `--unit` / `options.subject` skips this step.
2. Collects facts (active and resolved) of those subjects, or, if none is named, runs keyword search
   over all facts.
3. With no facts, returns a fixed message and **calls no model**.
4. Otherwise sends the facts, numbered `[F1]…`, with their latest quotes to the model, which answers
   only from them and cites ids. The result carries the answer **and** the facts, for any UI.

## Storage

Both stores (`packages/store-sqlite/src/migrations.ts`, `packages/store-postgres/src/migrations.ts`) have these tables:

| Table | Holds |
| --- | --- |
| `subjects` | Type, id, name, connector of each subject. No other columns from the source. |
| `facts` | One row per fact: subject, kind, topic, statement, confidence, status, first/last seen. |
| `evidence` | Quotes per fact with event id, source, date and link. |
| `source_events` | Event id and text hash of everything processed. Never the text. |
| `sync_checkpoints` | Per connector, the time of the last event read. |
| `extraction_runs` | Per run: counts, tokens, estimated cost, status, error. |
| `schema_migrations` | Applied schema versions. |

Migrations run on every start (`store.migrate()`), are idempotent, and are never edited after release.

## Failure behaviour

| Situation | What happens |
| --- | --- |
| Model refuses a batch | No facts from that batch; the run continues. |
| Model output truncated (`max_tokens`) | The run fails with a message to lower `sync.batchSize`. Events of failed batches are not marked processed. |
| Database or network error | The run is recorded as `failed` with the error; the checkpoint does not move. |
| Daily budget reached | No new requests start; the run is `budget_exhausted`; the next run continues. |
| Same event edited in the source | Its hash changes, so it is read again; evidence from it is not double-counted. |
