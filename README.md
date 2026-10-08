# ops-memory

**Operational memory for property management.** ops-memory reads the records a property
management system already has (maintenance tickets, their comments, guest reviews) and keeps a
short list of **facts about every unit**, each one backed by the exact words it came from:

```text
$ ops-memory profile "Pine 2"
unit "Pine 2" (3f1c…)

Active (2)
[F1] recurring_issue/wifi · active · confidence 0.875 · seen 2026-05-02 → 2026-09-14
  The wifi drops in the evenings.
    "wifi kept dropping at night" (review, 2026-08-30)
    "router in the hall closet needs a restart" (maintenance_comment, 2026-09-14)
[F2] access_info/parking · active · confidence 0.5 · seen 2026-07-11 → 2026-07-11
  Guest parking is the second stall behind the building.
    "park in stall 2 behind the building" (maintenance_ticket, 2026-07-11)

Resolved (1)
[F3] recurring_issue/dishwasher · resolved · confidence 0.875 · seen 2026-04-03 → 2026-09-02
  The dishwasher was replaced and no longer leaks.
    "Dishwasher is leaking again" (maintenance_ticket, 2026-06-20)
    "replaced with a new Bosch unit" (maintenance_comment, 2026-09-02)
```

Staff ask in plain words, from the terminal or from Claude through MCP:

```text
$ ops-memory ask "What keeps breaking at Pine 2?"
The wifi drops in the evenings; it has been reported three times since May, most recently on
14 Sep [F1]. The dishwasher leaked repeatedly but was replaced on 2 Sep [F3].
```

The examples above are illustrative. The tool is built and tested; real output depends on your data
and an API key.

> **Tiếng Việt, tóm tắt:** ops-memory đọc ticket bảo trì, comment và review có sẵn trong PMS
> (CleanOver), dùng Claude rút ra các "fact" về từng căn nhà, mỗi fact kèm trích dẫn nguyên văn
> làm bằng chứng, và lưu vào một kho riêng. Nhân viên hỏi bằng ngôn ngữ tự nhiên qua CLI hoặc qua
> Claude (MCP). Chỉ đọc dữ liệu nguồn, không bao giờ ghi ngược lại. Cài vào CleanOver: xem
> [docs/cleanover.md](docs/cleanover.md).

## Why

Knowledge about each unit lives in hundreds of tickets, comments and reviews, and in the heads of
the people who handled them. Nobody can read all of it before answering a guest or sending a
technician. ops-memory reads it once, keeps what lasts, and drops what it cannot prove.

- **Evidence or nothing.** Every fact quotes the record it came from. Code checks that the quote is
  really in that record; a fact whose quote cannot be found is thrown away.
- **Knows what is fixed.** A later "replaced the dishwasher" marks the leak *resolved*; a newer
  leak report reopens it.
- **Read-only.** Connectors open the source database with `default_transaction_read_only=on`.
  ops-memory keeps its own store and never writes back.
- **Private by default.** Door codes, PINs, phone numbers and emails are redacted before any text
  reaches a model. Only units are profiled; facts about people are out of scope unless you add them.
- **Pluggable.** Connectors (where data comes from), stores (where facts live), the model provider
  and the kinds of facts are all plugins chosen in one config file.

## Packages

| Package | What it is |
| --- | --- |
| [`@ops-memory/core`](packages/core) | Facts, evidence, the sync pipeline, plugin interfaces, `createMemory()`. No dependencies. |
| [`@ops-memory/store-sqlite`](packages/store-sqlite) | Store on Node's built-in `node:sqlite`: one file, no native build. |
| [`@ops-memory/llm-anthropic`](packages/llm-anthropic) | Claude provider: structured extraction and grounded answers. |
| [`@ops-memory/connector-cleanover`](packages/connector-cleanover) | Reads CleanOver's Postgres: units, maintenance tickets and comments, reviews. |
| [`@ops-memory/mcp`](packages/mcp) | MCP server with read-only tools for Claude and other MCP clients. |
| [`@ops-memory/cli`](packages/cli) | `ops-memory` command: `sync`, `ask`, `profile`, `search`, `status`, `serve`. |

## Quick start

Requires Node.js 22.13 or later.

```bash
git clone https://github.com/GalvinSWE/ops-memory.git
```
```bash
cd ops-memory && npm install && npm run build
```

Copy the example settings next to the CleanOver config and fill them in (database URL, and an
Anthropic API key unless you use `ant auth login`):

```bash
cp .env.example examples/cleanover/.env
```

See what a first run would read, without calling a model:

```bash
npm run ops-memory -- sync --dry-run --config examples/cleanover/ops-memory.config.ts
```

Then run it for real, and ask:

```bash
npm run ops-memory -- sync --config examples/cleanover/ops-memory.config.ts
```
```bash
npm run ops-memory -- ask "What keeps breaking at Pine 2?" --config examples/cleanover/ops-memory.config.ts
```

Full CleanOver setup, including a read-only database role and cost estimates:
[docs/cleanover.md](docs/cleanover.md).

## Commands

| Command | Does |
| --- | --- |
| `ops-memory init` | Writes `ops-memory.config.ts` in the current folder. |
| `ops-memory sync [--dry-run] [--max-events N] [--connector NAME]` | Reads records since the last checkpoint and extracts facts. |
| `ops-memory ask "<question>" [--unit NAME] [--no-sources]` | Answers from stored facts and lists them as sources. |
| `ops-memory profile <unit>` | Everything known about one unit, active and resolved. |
| `ops-memory search "<words>" [--unit NAME]` | Keyword search over facts. |
| `ops-memory units "<name>"` | Finds units by name. |
| `ops-memory status` | Counts, checkpoints, today's spend, recent runs. |
| `ops-memory serve [--no-ask]` | MCP server on stdio. |

Every command takes `--config <file>`; without it, `ops-memory.config.ts` in the current folder is used.

## Use it from Claude

`ops-memory serve` is an MCP server. In Claude Code:

```bash
claude mcp add ops-memory -- node /path/to/ops-memory/packages/cli/dist/bin.js serve --config /path/to/ops-memory.config.ts
```

Tools: `find_subjects`, `get_unit_profile`, `search_facts`, and `ask` (hide it with `--no-ask` so
connected clients cannot spend tokens). None of them writes anything. Details in
[docs/mcp.md](docs/mcp.md).

## Use it as a library

```ts
import { createMemory } from '@ops-memory/core';
import config from './ops-memory.config.js';

const memory = createMemory(config);
await memory.sync();
const { answer, facts } = await memory.ask('Where do guests park at Pine 2?');
await memory.close();
```

`ask()` returns the answer and the facts it used, with their quotes, so any interface (a card in
CleanOver, a chat, a voice assistant) can show or read out its sources.

## Documentation

- [Architecture](docs/architecture.md): how a record becomes a fact, and how facts merge and resolve.
- [Configuration](docs/configuration.md): every option and its default.
- [Writing plugins](docs/plugins.md): connectors, stores, model providers, fact kinds.
- [CleanOver setup](docs/cleanover.md): read-only role, first sync, cost, scheduling.
- [MCP](docs/mcp.md): tools and client setup.
- [Privacy and safety](docs/privacy-and-safety.md): what is read, redacted, sent and stored.
- [Operations](docs/operations.md): scheduling, budget, backups, upgrades, reset.
- [Roadmap](docs/roadmap.md): what is not built yet.

## Development

```bash
npm install && npm test
```

`npm test` builds every package and runs all tests. They need no database and no API key: the
pipeline is exercised with `memoryConnector` and `scriptedLlm` from `@ops-memory/core/testing`.

Node prints `ExperimentalWarning: SQLite is an experimental feature` for `node:sqlite`. It is
expected and harmless.
