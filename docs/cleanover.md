# Installing ops-memory for CleanOver

ops-memory runs **beside** CleanOver, not inside it. It reads CleanOver's Postgres with a read-only
connection and keeps its own facts in a separate file. Nothing in the CleanOver repositories
changes, and no CleanOver migration is needed.

```text
CleanOver Postgres ──(read-only)──▶ ops-memory sync ──▶ ops-memory.db ──▶ ask / profile / MCP
```

## What it reads

| Source | Table(s) | Fields read | Notes |
| --- | --- | --- | --- |
| Units (subjects) | `units` | `id`, `alias`, `business_id` | Deleted units are skipped. |
| `maintenance_ticket` | `maintenance_tickets` + `maintenance_ticket_statuses` | title, description, comment, status name, `created_at` | Deleted tickets and tickets of deleted units are skipped. |
| `maintenance_comment` | `ticket_maintenance_comments` | content, `created_at`, the ticket's title | Only `comment_type = 1` (written by a person). Type 2 is the system's change log and is skipped. Author ids are not read. |
| `review` | `reviews` | overall rating, review text, private feedback, submitted time | Guest names are **not** read. Reviews with no unit are skipped. |

Nothing else is selected: no guest names, phone numbers, emails, door codes columns, payments or
staff records. Text that people typed can still contain such things; it is redacted before any of it
reaches a model ([privacy-and-safety.md](privacy-and-safety.md)).

Measured on a CleanOver database copy on 2026-10-08, for the last 180 days: about 3,400 tickets
(average 380 characters), 10,600 reviews (290) and 77,500 person-written comments (66), across
948 units.

## 1. A read-only database role

Ask whoever administers the database to create a role that can only read the four tables:

```sql
CREATE ROLE ops_memory_reader LOGIN PASSWORD '<choose one>';
GRANT CONNECT ON DATABASE cleanover TO ops_memory_reader;
GRANT USAGE ON SCHEMA public TO ops_memory_reader;
GRANT SELECT ON units, maintenance_tickets, maintenance_ticket_statuses,
                ticket_maintenance_comments, reviews TO ops_memory_reader;
ALTER ROLE ops_memory_reader SET default_transaction_read_only = on;
```

The connector also opens every connection with `default_transaction_read_only=on` and a 60-second
statement timeout, so even a role that could write cannot write through ops-memory. On a
production database, point it at a **read replica** if one exists.

For a local trial against your development database, your usual local user works; the connector
still forces read-only sessions.

## 2. Settings

```bash
cp .env.example examples/cleanover/.env
```

| Variable | Value |
| --- | --- |
| `CLEANOVER_DATABASE_URL` | `postgres://ops_memory_reader:<password>@<host>:5432/cleanover` |
| `CLEANOVER_BUSINESS_ID` | Optional: one business's uuid. Empty reads every business. |
| `ANTHROPIC_API_KEY` | Claude API key. Leave unset if `ant auth login` is set up on the machine. |
| `OPS_MEMORY_DB` | Where the facts file goes, e.g. `./examples/cleanover/ops-memory.db`. |

`.env` files are git-ignored. Do not commit the database URL or the API key.

## 3. Check what it will read (no cost)

```bash
npm run ops-memory -- sync --dry-run --max-events 100000 --config examples/cleanover/ops-memory.config.ts
```

This lists subjects and counts events since the backfill start. It calls no model and writes
nothing.

## 4. First sync

Start small and read the result before spending more:

```bash
npm run ops-memory -- sync --max-events 300 --config examples/cleanover/ops-memory.config.ts
```
```bash
npm run ops-memory -- status --config examples/cleanover/ops-memory.config.ts
```
```bash
npm run ops-memory -- profile "<a unit alias you know well>" --config examples/cleanover/ops-memory.config.ts
```

Check a handful of facts against what you know about those units. Look at the `rejected` count in
the sync summary: a high share means the model is paraphrasing instead of quoting, which the
verification step catches but which also wastes tokens.

Then backfill the rest. With the default budget of $5 a day the run stops when the budget is used
and the next run continues where it stopped:

```bash
npm run ops-memory -- sync --max-events 100000 --config examples/cleanover/ops-memory.config.ts
```

## Cost

Estimates for the 180-day backfill above (about 91,500 events, roughly 15 million characters of
text, about 8,000 requests). They are estimates; measure your first real run with `status`.

| Extraction model | Backfill (180 days) | Ongoing, per month | Notes |
| --- | --- | --- | --- |
| `claude-haiku-5-5` (example config) | about $2–4 | about $0.50 | Fits inside one day of the default budget. |
| `claude-opus-5-5` (library default) | about $80–130 | about $15–25 | Raise `budget.maxUsdPerDay` or let it run over several days. |

Input is about 12 million tokens (event text, markup and the instructions repeated per request);
output is the facts plus the model's reasoning, which varies. Prices used: Haiku 5.5 $0.10 / $0.50
and Opus 5.5 $4 / $20 per million input / output tokens.

Answers (`ask`) use `claude-opus-5-5` in the example config: a few thousand tokens each, about
1–5 cents. `profile`, `search` and the MCP tools other than `ask` call no model and cost nothing.

## 5. Keep it current

Run `sync` on a schedule from one machine, for example every 30 minutes with cron:

```cron
*/30 * * * * cd /opt/ops-memory && npm run --silent ops-memory -- sync --config examples/cleanover/ops-memory.config.ts >> /var/log/ops-memory.log 2>&1
```

More in [operations.md](operations.md).

## 6. Give staff access

- **Claude (Code or Desktop):** add the MCP server, see [mcp.md](mcp.md). Staff ask "What should
  I know before sending a cleaner to Pine 2?" and Claude calls `get_unit_profile`.
- **Terminal:** `ops-memory ask "…"`.
- **Inside CleanOver:** not built. A "Unit memory" card on the unit page would call the library or
  an HTTP endpoint around it; that is a CleanOver change and goes through CleanOver's own plan and
  review. See [roadmap.md](roadmap.md).

## Links back into CleanOver

Evidence can carry a link to the record. Supply a `url` builder in the config once you have
confirmed the routes in your CleanOver frontend:

```ts
cleanover({
  connectionString: required('CLEANOVER_DATABASE_URL'),
  url: ({ source, id, ticketId }) =>
    source === 'review' ? undefined : `https://app.example.com/<ticket route>/${ticketId ?? id}`
})
```

The connector ships without links because routes differ between environments.
