# @ops-memory/store-sqlite

Store on Node's built-in `node:sqlite` (Node 22.13+): one file, WAL mode, versioned migrations, no native build.

```ts
import { sqlite } from '@ops-memory/store-sqlite';

const store = sqlite({ path: './ops-memory.db' });
```

Part of [ops-memory](../../README.md). See [architecture.md#storage](../../docs/architecture.md#storage), [operations.md](../../docs/operations.md).
