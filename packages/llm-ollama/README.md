# @ops-memory/llm-ollama

Local model provider for ops-memory through [Ollama](https://ollama.com): free, and no text leaves
the machine. Extraction is constrained to the facts JSON schema; quote verification drops facts a
smaller model paraphrases.

```ts
import { ollama } from '@ops-memory/llm-ollama';

const llm = ollama({ extractModel: 'qwen2.5:7b', numCtx: 16384, keepAlive: '30m' });
```

Part of [ops-memory](../../README.md).
