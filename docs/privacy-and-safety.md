# Privacy and safety

## What leaves the machine

Only **redacted event text** goes to the model provider during `sync`, and only **stored facts and
their quotes** during `ask`. Subject names (unit aliases) are included so the model knows which
unit it reads about. Nothing goes anywhere else.

With the Anthropic provider, data handling follows your Anthropic account's terms and retention
settings.

## Read-only towards the source

- Connectors never write. The CleanOver connector opens every session with
  `default_transaction_read_only=on` and a statement timeout.
- Use a role that can only `SELECT` the tables listed in [cleanover.md](cleanover.md).
- ops-memory's own data lives in its own store.

## Redaction

Before text reaches a model (and so before any quote can be stored), these are replaced:

| Rule | Example in | Out |
| --- | --- | --- |
| `access_code` | `door code is 4821#`, `lockbox: 0912`, `wifi password: summer24` | `door code is [REDACTED_CODE]` |
| `phone` | `+1 (403) 555-0199` | `[REDACTED_PHONE]` (dates are left alone) |
| `email` | `jo@example.com` | `[REDACTED_EMAIL]` |
| `url_token` | `?token=abc123` | `?token=[REDACTED]` |

A code is only redacted when the value contains a digit or `#`/`*`, so "the code is broken" stays
readable. Add your own patterns with `privacy.patterns`. Redaction is pattern-based and can miss
unusual formats; connectors should still not select personal columns.

The `access_info` kind is told never to record codes, and the prompt tells the model never to guess
redacted values. Even if it did, the quote check would fail because the original value is no longer
in the text.

## Facts about people

The default subject type is `unit`. The built-in kinds describe places and work, and the extraction
prompt forbids describing a guest's or worker's character, behaviour or performance. Turning on
`guest` or `staff` subjects is a business and legal decision, not a technical one: make it
explicitly, and write fact kinds for it with the same care.

## Hallucination controls

1. Structured output: the model can only return the expected fields.
2. Quote verification: a fact survives only if its quote is literally in the record it names.
3. Answers are generated from stored facts only, and cite them; with no facts, no model is called.
4. Rejections are counted per run (`status`), so a drift in model behaviour shows up as a number.

## Deleting data

ops-memory's data is one SQLite file. To remove everything: stop scheduled syncs and delete the
file. To forget one unit, delete its rows from `facts` (evidence cascades) and `subjects`; events
already read will not be read again unless their text changes, so also delete that unit's rows from
`source_events` if you want it rebuilt.
