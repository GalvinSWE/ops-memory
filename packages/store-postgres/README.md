# @ops-memory/store-postgres

Postgres store for ops-memory, in a database (or schema) of its own. Same tables as the SQLite
store; migrations run on start under an advisory lock. Use it when several readers or machines share
one memory.

```ts
import { postgres } from '@ops-memory/store-postgres';

const store = postgres({ connectionString: process.env.OPS_MEMORY_DATABASE_URL! });
```

Part of [ops-memory](../../README.md). See [configuration.md](../../docs/configuration.md#postgres-store-ops-memorystore-postgres).
