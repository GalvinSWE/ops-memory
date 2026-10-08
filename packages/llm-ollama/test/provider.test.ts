import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BUILT_IN_FACT_KINDS } from '@ops-memory/core';
import { factsSchema, ollama, parseFacts } from '@ops-memory/llm-ollama';

const kinds = [BUILT_IN_FACT_KINDS.recurring_issue!, BUILT_IN_FACT_KINDS.access_info!];
const subject = { type: 'unit', id: 'u1', name: 'Pine 2', connector: 'c' };
const events = [{ id: 'e1', source: 'review', subject, occurredAt: '2026-09-01T00:00:00.000Z', text: 'Wifi drops at night.' }];

const fakeFetch = (body: unknown, status = 200) => {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { fn, calls };
};

test('extraction is constrained to the facts schema with the enabled kinds, at temperature 0', async () => {
  const content = JSON.stringify({ facts: [{ eventId: 'e1', kind: 'recurring_issue', topic: 'wifi', statement: 'Wifi drops.', quote: 'Wifi drops at night', resolved: false }] });
  const { fn, calls } = fakeFetch({ message: { content }, prompt_eval_count: 300, eval_count: 40, done_reason: 'stop' });
  const result = await ollama({ fetch: fn }).extract({ subject, kinds, events });
  assert.equal(calls[0]!.url, 'http://localhost:11434/api/chat');
  assert.equal(calls[0]!.body.model, 'qwen2.5:7b');
  assert.deepEqual(calls[0]!.body.format, factsSchema(kinds));
  assert.equal((calls[0]!.body.options as { temperature: number }).temperature, 0);
  assert.equal(result.facts.length, 1);
  assert.deepEqual(result.usage, { inputTokens: 300, outputTokens: 40, costUsd: 0 });
});

test('malformed items and unknown kinds are dropped, the rest kept', () => {
  const facts = parseFacts(
    JSON.stringify({
      facts: [
        { eventId: 'e1', kind: 'recurring_issue', topic: 'wifi', statement: 'Wifi drops.', quote: 'Wifi drops', resolved: true },
        { eventId: 'e1', kind: 'made_up', topic: 'x', statement: 'x', quote: 'x' },
        { eventId: 'e1', kind: 'access_info', topic: '', statement: 's', quote: 'q' },
        'nonsense'
      ]
    }),
    kinds
  );
  assert.equal(facts.length, 1);
  assert.equal(facts[0]!.resolved, true);
  assert.deepEqual(parseFacts('not json', kinds), []);
});

test('a missing model says how to get it', async () => {
  const { fn } = fakeFetch({ error: 'model "qwen2.5:7b" not found, try pulling it first' }, 404);
  await assert.rejects(ollama({ fetch: fn }).extract({ subject, kinds, events }), /ollama pull qwen2.5:7b/);
});

test('an unreachable server says to start it', async () => {
  const fn = (async () => {
    throw new TypeError('fetch failed');
  }) as unknown as typeof fetch;
  await assert.rejects(ollama({ fetch: fn }).answer({ question: 'q', facts: [], subjects: [] }), /ollama serve/);
});

test('running out of context is an error that names the setting to change', async () => {
  const { fn } = fakeFetch({ message: { content: '{"facts":[]}' }, done_reason: 'length' });
  await assert.rejects(ollama({ fetch: fn }).extract({ subject, kinds, events }), /lower sync.batchSize or raise numCtx/);
});
