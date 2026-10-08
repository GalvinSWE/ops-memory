# @ops-memory/llm-anthropic

Claude provider. Extraction uses structured output (`messages.parse` with a Zod schema) so every fact has the expected shape; answers cite fact ids. Tracks estimated cost for the daily budget.

```ts
import { anthropic } from '@ops-memory/llm-anthropic';

const llm = anthropic({ extractModel: 'claude-haiku-5-5', answerModel: 'claude-opus-5-5' });
```

Part of [ops-memory](../../README.md). See [configuration.md#model-provider-ops-memoryllm-anthropic](../../docs/configuration.md#model-provider-ops-memoryllm-anthropic).
