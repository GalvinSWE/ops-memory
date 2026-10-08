import assert from 'node:assert/strict';
import { test } from 'node:test';
import { batchEvents, resolveConfig, type SourceEvent } from '@ops-memory/core';
import { memoryConnector, scriptedLlm } from '@ops-memory/core/testing';

const store = {} as never;
const base = () => ({ connectors: [memoryConnector('a', [], [])], store, llm: scriptedLlm(() => []) });

test('defaults: units only, the four default kinds, $5 a day', () => {
  const c = resolveConfig(base());
  assert.deepEqual(c.subjects, ['unit']);
  assert.deepEqual(c.factKinds.map((k) => k.name), ['recurring_issue', 'equipment', 'access_info', 'guest_question']);
  assert.equal(c.budget.maxUsdPerDay, 5);
});

test('an unknown built-in kind name is an error that lists the real ones', () => {
  assert.throws(() => resolveConfig({ ...base(), factKinds: ['wifi'] }), /unknown fact kind "wifi".*recurring_issue/);
});

test('custom kinds sit next to built-in ones', () => {
  const c = resolveConfig({ ...base(), factKinds: ['equipment', { name: 'pest', description: 'Pests seen in the unit' }] });
  assert.deepEqual(c.factKinds.map((k) => k.name), ['equipment', 'pest']);
});

test('two connectors with one name are refused', () => {
  assert.throws(
    () => resolveConfig({ ...base(), connectors: [memoryConnector('a', [], []), memoryConnector('a', [], [])] }),
    /two connectors are named "a"/
  );
});

test('batches respect both the event count and the text budget, and cut an oversized event', () => {
  const ev = (id: string, len: number): SourceEvent => ({
    id,
    source: 's',
    subject: { type: 'unit', id: 'u' },
    occurredAt: '2026-01-01T00:00:00.000Z',
    text: 'x'.repeat(len)
  });
  const batches = batchEvents([ev('1', 10), ev('2', 10), ev('3', 10), ev('4', 50), ev('5', 500)], 3, 60);
  assert.deepEqual(batches.map((b) => b.map((e) => e.id)), [['1', '2', '3'], ['4'], ['5']]);
  assert.equal(batches[2]![0]!.text.length, 60);
});
