# @ops-memory/connector-cleanover

Reads CleanOver's Postgres, read-only: units, maintenance tickets, person-written ticket comments and guest reviews. Never selects guest names or author ids.

```ts
import { cleanover } from '@ops-memory/connector-cleanover';

const connector = cleanover({ connectionString: process.env.CLEANOVER_DATABASE_URL! });
```

Part of [ops-memory](../../README.md). See [cleanover.md](../../docs/cleanover.md).
