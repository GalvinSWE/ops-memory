# Operations

## One writer

Run `sync` from **one** place on a schedule. `ask`, `profile`, `search` and `serve` only read and
can run anywhere that can open the store.

```cron
*/30 * * * * cd /opt/ops-memory && npm run --silent ops-memory -- sync --config examples/cleanover/ops-memory.config.ts >> /var/log/ops-memory.log 2>&1
```

A sync that finds nothing new calls no model and costs nothing.

## Watching it

```bash
npm run ops-memory -- status --config examples/cleanover/ops-memory.config.ts
```

Shows counts, each connector's checkpoint, today's estimated spend against the budget, and the last
ten runs with their status (`completed`, `budget_exhausted`, `failed`).

| Sign | Likely cause | Action |
| --- | --- | --- |
| `failed` with `max_tokens` | Batches too large for one response | Lower `sync.batchSize` |
| `failed` with a connection error | Database unreachable or credentials changed | Fix `.env`; the next run resumes |
| `budget_exhausted` every run | Backlog larger than the budget | Raise `budget.maxUsdPerDay` or wait; progress is kept |
| Many `rejected` | Model paraphrasing instead of quoting | Check the model setting; review the prompt if you changed it |
| Checkpoint not moving | Runs failing or stopping at the budget | Read the last run's error |

## Backups

The store is one SQLite file (plus `-wal`/`-shm` while open). Copy it while no `sync` is running, or
use `sqlite3 ops-memory.db ".backup backup.db"`. Everything in it can be rebuilt from the source by
deleting it and syncing again, at the cost of the extraction tokens.

## Upgrading

`npm install` the new versions and run any command: `store.migrate()` applies new schema versions on
start. Migrations are additive and never edited after release.

## Re-reading everything

After changing fact kinds or the prompt you may want to re-extract. Delete the store file (or the
`facts`, `evidence`, `source_events` and `sync_checkpoints` rows) and sync again. Check the cost
estimate in [cleanover.md](cleanover.md#cost) first.

## Budget

`budget.maxUsdPerDay` caps the estimated spend per UTC day across all runs. Estimates come from the
provider's price table (`prices` option of `anthropic()`); keep it in line with your contract.
Requests already in flight when the cap is reached finish, so a day can end slightly over the cap.
