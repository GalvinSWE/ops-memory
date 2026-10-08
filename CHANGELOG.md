# Changelog

## Unreleased

- `@ops-memory/store-postgres`: Postgres store in a database or schema of its own, advisory-locked
  migrations, the same tables as SQLite. `scripts/sqlite-to-postgres.mjs` moves a SQLite store over.
- `@ops-memory/llm-ollama`: local model provider through Ollama.
- Voice phase 1: `voice-core`, `voice-server`, `@galvinswe/ops-memory-voice-web`, `ops-memory voice`.
- Units are found the way people say them; stop words are dropped before keyword search.

## 0.1.0 (2026-10-08)

First version.

- `@ops-memory/core`: facts with verbatim evidence, quote verification, merge and resolution,
  redaction, daily budget, `createMemory()` with `sync`, `ask`, `profile`, `search`, `status`.
- `@ops-memory/store-sqlite`: store on `node:sqlite` with versioned migrations.
- `@ops-memory/llm-anthropic`: Claude provider with structured extraction and cited answers.
- `@ops-memory/connector-cleanover`: read-only connector for units, maintenance tickets and
  comments, and reviews.
- `@ops-memory/mcp`: read-only MCP tools.
- `@ops-memory/cli`: `init`, `sync`, `ask`, `profile`, `search`, `units`, `status`, `serve`.
