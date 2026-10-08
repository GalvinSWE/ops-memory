import assert from 'node:assert/strict';
import { test } from 'node:test';
import type Anthropic from '@anthropic-ai/sdk';
import { BUILT_IN_FACT_KINDS } from '@ops-memory/core';
import { anthropic, extractionSystemPrompt, extractionUserPrompt } from '@ops-memory/llm-anthropic';

const kinds = [BUILT_IN_FACT_KINDS.recurring_issue!];
const subject = { type: 'unit', id: 'u1', name: 'Pine 2', connector: 'c' };
const events = [
  { id: 'e"1', source: 'review', subject, occurredAt: '2026-09-01T00:00:00.000Z', text: 'Wifi drops at night.' }
];

/** A stand-in client: records the request and returns a canned response. No network. */
const fakeClient = (response: Record<string, unknown>) => {
  const requests: Record<string, unknown>[] = [];
  const respond = async (req: Record<string, unknown>) => {
    requests.push(req);
    return response;
  };
  return { client: { messages: { parse: respond, create: respond } } as unknown as Anthropic, requests };
};

const usage = { input_tokens: 1000, output_tokens: 200, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };

test('the system prompt lists the enabled kinds and stays the same between requests (cacheable)', () => {
  const a = extractionSystemPrompt(kinds);
  assert.match(a, /recurring_issue:/);
  assert.equal(a, extractionSystemPrompt(kinds));
  assert.doesNotMatch(a, /\d{4}-\d{2}-\d{2}/, 'no dates in the cached prefix');
});

test('event ids are escaped inside the prompt markup', () => {
  assert.match(extractionUserPrompt(subject, events), /id="e&quot;1"/);
});

test('extract returns the parsed facts and prices the call', async () => {
  const fact = { eventId: 'e"1', kind: 'recurring_issue', topic: 'wifi', statement: 'Wifi drops.', quote: 'Wifi drops at night', resolved: false };
  const { client, requests } = fakeClient({ stop_reason: 'end_turn', parsed_output: { facts: [fact] }, usage });
  const llm = anthropic({ client, extractModel: 'claude-haiku-5-5' });
  const result = await llm.extract({ subject, kinds, events });
  assert.equal(result.facts.length, 1);
  assert.equal(result.facts[0]!.resolved, undefined);
  assert.equal(requests[0]!.model, 'claude-haiku-5-5');
  // 1000 × $0.10 + 200 × $0.50 per million
  assert.equal(result.usage.costUsd, (1000 * 0.1 + 200 * 0.5) / 1e6);
});

test('the default model is Claude Opus 5.5', async () => {
  const { client, requests } = fakeClient({ stop_reason: 'end_turn', parsed_output: { facts: [] }, usage });
  await anthropic({ client }).extract({ subject, kinds, events });
  assert.equal(requests[0]!.model, 'claude-opus-5-5');
});

test('a refusal yields no facts instead of failing the run', async () => {
  const { client } = fakeClient({ stop_reason: 'refusal', parsed_output: null, usage });
  const result = await anthropic({ client }).extract({ subject, kinds, events });
  assert.deepEqual(result.facts, []);
});

test('an output cut off by max_tokens is an error that says what to change', async () => {
  const { client } = fakeClient({ stop_reason: 'max_tokens', parsed_output: null, usage });
  await assert.rejects(anthropic({ client }).extract({ subject, kinds, events }), /lower sync.batchSize/);
});

test('answer joins the text blocks', async () => {
  const { client } = fakeClient({
    stop_reason: 'end_turn',
    content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: 'Wifi drops at night [F1].' }],
    usage
  });
  const result = await anthropic({ client }).answer({ question: 'wifi?', facts: [], subjects: [] });
  assert.equal(result.answer, 'Wifi drops at night [F1].');
});
