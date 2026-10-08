# MCP server

`ops-memory serve` runs an MCP server on stdio. It exposes read-only tools: no tool syncs, writes,
or deletes anything.

| Tool | Input | Returns | Calls a model |
| --- | --- | --- | --- |
| `find_subjects` | `query` | Units whose name or id matches | no |
| `get_unit_profile` | `unit` (name or id) | Active and resolved facts with quotes | no |
| `search_facts` | `query`, optional `unit`, `limit` | Facts matching the words | no |
| `ask` | `question` | Answer citing facts, then the facts | yes |

`serve --no-ask` hides `ask`, so connected clients cannot spend tokens; Claude then answers from
`get_unit_profile` and `search_facts` itself.

## Claude Code

```bash
claude mcp add ops-memory -- node /abs/path/ops-memory/packages/cli/dist/bin.js serve --config /abs/path/ops-memory/examples/cleanover/ops-memory.config.ts
```

## Claude Desktop

In `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "ops-memory": {
      "command": "node",
      "args": [
        "/abs/path/ops-memory/packages/cli/dist/bin.js",
        "serve",
        "--no-ask",
        "--config",
        "/abs/path/ops-memory/examples/cleanover/ops-memory.config.ts"
      ]
    }
  }
}
```

The `.env` next to the config is loaded by the server, so the database URL and API key do not need
to be in the client config.

## In your own code

```ts
import { createMemory } from '@ops-memory/core';
import { createMcpServer } from '@ops-memory/mcp';

const server = createMcpServer(createMemory(config), { allowAsk: false });
// connect it to any MCP transport
```

Do not run `sync` from an MCP client; schedule it instead ([operations.md](operations.md)).
