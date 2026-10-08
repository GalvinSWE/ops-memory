# Roadmap

Not built yet, roughly in order of value.

| Item | Why | Notes |
| --- | --- | --- |
| **Real-data evaluation set** | Measure extraction precision and recall on 30–50 labelled records before trusting it widely. | Labelled by people who know the units. Run on every prompt or model change. |
| **Semantic search** | Keyword search misses "router" for a question about "internet". | Embeddings per fact; `sqlite-vec` or Postgres `pgvector`. |
| **Postgres store** | Several readers on different machines; managed backups. | Same `Store` interface; schema mirrors SQLite. |
| **Batch backfill** | The Message Batches API halves the cost of a large first run. | Submit, poll, then run the same verify/merge on results. |
| **More CleanOver sources** | Guest messages, clean checklists and inspection notes hold much of the knowledge. | Guest messages are large and personal: needs a decision on scope and stronger redaction. |
| **Other PMS connectors** | Hostaway, Repull, Guesty: the same memory for any portfolio. | Each is a `Connector`; nothing else changes. |
| **HTTP API** | A "Unit memory" card in CleanOver or other apps without linking the library. | Read-only endpoints over `profile`, `search`, `ask`. |
| **Voice interface** | Ask and hear the answer, hands free (cleaners, technicians on site). | Separate package (`@ops-memory/voice`): speech-to-text → `memory.ask()` → text-to-speech, reading out the sources. The core stays headless. |
| **Proactive notes** | "Third dishwasher report at Pine 2 this month" pushed to the right person. | Built on facts whose evidence count crosses a threshold. |
| **Model fallbacks** | Keep extraction going if a model declines a request. | Server-side fallbacks on the Claude API; today a refusal yields no facts for that batch. |
