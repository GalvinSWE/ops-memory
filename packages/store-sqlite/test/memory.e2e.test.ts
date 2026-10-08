import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMemory, type SourceEvent, type SourceSubject } from '@ops-memory/core';
import { memoryConnector, quoteFrom, scriptedLlm, type ExtractRule } from '@ops-memory/core/testing';
import { sqlite } from '@ops-memory/store-sqlite';

const days = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

const units: SourceSubject[] = [
  { type: 'unit', id: 'u-pine-2', name: 'Pine 2', connector: 'demo' },
  { type: 'unit', id: 'u-pine-21', name: 'Pine 21', connector: 'demo' }
];

const ev = (id: string, unit: string, ago: number, text: string, source = 'maintenance_ticket'): SourceEvent => ({
  id,
  source,
  subject: { type: 'unit', id: unit },
  occurredAt: days(ago),
  text
});

const events = [
  ev('t1', 'u-pine-2', 30, 'Dishwasher is leaking under the door. Door code 4821# for the plumber.'),
  ev('t2', 'u-pine-2', 20, 'Dishwasher is leaking again, towels on the floor.'),
  ev('r1', 'u-pine-2', 10, 'Lovely stay but the wifi kept dropping at night.', 'review'),
  ev('t3', 'u-pine-21', 5, 'Smoke alarm chirping in bedroom.'),
  ev('t4', 'u-pine-2', 2, 'Dishwasher replaced with a new Bosch unit, no more leaking.')
];

/** Plays the model: one fact per known phrase, quoting it exactly as a good model would. */
const rule: ExtractRule = (e) => {
  const out = [];
  if (/dishwasher is leaking/i.test(e.text))
    out.push({ kind: 'recurring_issue', topic: 'dishwasher', statement: 'The dishwasher leaks.', quote: quoteFrom(e, 'Dishwasher is leaking') });
  if (/dishwasher replaced/i.test(e.text))
    out.push({ kind: 'recurring_issue', topic: 'dishwasher', statement: 'Dishwasher replaced.', quote: quoteFrom(e, 'Dishwasher replaced'), resolved: true });
  if (/wifi/i.test(e.text))
    out.push({ kind: 'recurring_issue', topic: 'wifi', statement: 'Wifi drops at night.', quote: quoteFrom(e, 'wifi kept dropping at night') });
  if (/smoke alarm/i.test(e.text))
    out.push({ kind: 'recurring_issue', topic: 'smoke_alarm', statement: 'Smoke alarm chirps.', quote: 'smoke alarm is beeping loudly' }); // invented quote
  return out;
};

const setup = (overrides: { costPerRequest?: number; maxUsdPerDay?: number } = {}) => {
  const llm = scriptedLlm(rule, { costPerRequest: overrides.costPerRequest });
  const memory = createMemory({
    connectors: [memoryConnector('demo', units, events)],
    store: sqlite({ path: ':memory:' }),
    llm,
    sync: { batchSize: 2, concurrency: 2 },
    budget: { maxUsdPerDay: overrides.maxUsdPerDay ?? 5 }
  });
  return { memory, llm };
};

test('a sync turns records into facts with evidence, and resolves what was fixed', async () => {
  const { memory } = setup();
  const [run] = await memory.sync();
  assert.equal(run?.status, 'completed');
  assert.equal(run?.eventsProcessed, 5);
  assert.equal(run?.factsRejected, 1, 'the invented smoke-alarm quote is rejected');

  const profile = await memory.profile({ type: 'unit', id: 'u-pine-2' });
  assert.equal(profile.subject?.name, 'Pine 2');
  assert.deepEqual(profile.active.map((f) => f.topic), ['wifi']);
  const dishwasher = profile.resolved[0];
  assert.equal(dishwasher?.topic, 'dishwasher');
  assert.equal(dishwasher?.evidence.length, 3);
  assert.equal(dishwasher?.confidence, 0.875);
  assert.equal(dishwasher?.statement, 'Dishwasher replaced.');

  const other = await memory.profile({ type: 'unit', id: 'u-pine-21' });
  assert.equal(other.active.length, 0, 'nothing is kept without a real quote');
  await memory.close();
});

test('codes are redacted before the model sees the text', async () => {
  const { memory, llm } = setup();
  await memory.sync();
  const sent = llm.extractRequests.flatMap((r) => r.events.map((e) => e.text)).join('\n');
  assert.ok(!sent.includes('4821'), 'door code reached the model');
  assert.ok(sent.includes('[REDACTED_CODE]'));
  await memory.close();
});

test('a second sync reads nothing new and spends nothing', async () => {
  const { memory, llm } = setup();
  await memory.sync();
  const before = llm.extractRequests.length;
  const [again] = await memory.sync();
  assert.equal(again?.eventsProcessed, 0);
  assert.equal(llm.extractRequests.length, before);
  await memory.close();
});

test('a dry run counts events and writes nothing', async () => {
  const { memory, llm } = setup();
  const [dry] = await memory.sync({ dryRun: true });
  assert.equal(dry?.eventsSeen, 5);
  assert.equal(llm.extractRequests.length, 0);
  assert.equal((await memory.status()).stats.facts, 0);
  await memory.close();
});

test('the daily budget stops extraction and the next run picks up the rest', async () => {
  const { memory } = setup({ costPerRequest: 1, maxUsdPerDay: 1 });
  const [first] = await memory.sync();
  assert.equal(first?.status, 'budget_exhausted');
  assert.ok((first?.eventsProcessed ?? 0) < 5);
  const status = await memory.status();
  assert.equal(status.checkpoints[0]?.at, null, 'checkpoint does not move past unread events');
  await memory.close();
});

test('ask finds the unit named in the question, and not the one with a longer name', async () => {
  const { memory, llm } = setup();
  await memory.sync();
  const result = await memory.ask('What keeps breaking at Pine 2?');
  assert.deepEqual(result.subjects.map((s) => s.name), ['Pine 2']);
  assert.ok(result.facts.every((f) => f.subject.id === 'u-pine-2'));
  assert.ok(result.answer.includes('Wifi drops at night.'));
  assert.equal(llm.answerRequests.length, 1);
  await memory.close();
});

test('ask without facts says so and calls no model', async () => {
  const { memory, llm } = setup();
  const result = await memory.ask('Anything about the sauna?');
  assert.equal(result.facts.length, 0);
  assert.equal(result.usage, null);
  assert.equal(llm.answerRequests.length, 0);
  await memory.close();
});

test('keyword search spans units', async () => {
  const { memory } = setup();
  await memory.sync();
  const found = await memory.search('wifi');
  assert.deepEqual(found.map((f) => f.topic), ['wifi']);
  await memory.close();
});
