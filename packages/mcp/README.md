# @ops-memory/mcp

MCP server with read-only tools: `find_subjects`, `get_unit_profile`, `search_facts`, `ask`.

```ts
import { createMcpServer, serveStdio } from '@ops-memory/mcp';

await serveStdio(memory, { allowAsk: false });
```

Part of [ops-memory](../../README.md). See [mcp.md](../../docs/mcp.md).
