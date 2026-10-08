# Changelog

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
