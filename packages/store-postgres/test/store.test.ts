import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import pg from 'pg';
import { createMemory, type Fact, type Store } from '@ops-memory/core';
import { memoryConnector, quoteFrom, scriptedLlm } from '@ops-memory/core/testing';
import { postgres } from '@ops-memory/store-postgres';

/**
 * Runs against a real Postgres when OPS_MEMORY_TEST_DATABASE_URL is set, in a throwaway schema that
 * is dropped afterwards. Skipped otherwise, so `npm test` needs no database.
 */
const url = process.env.OPS_MEMORY_TEST_DATABASE_URL;
const schema = `ops_memory_test_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
const skip = url ? false : 'set OPS_MEMORY_TEST_DATABASE_URL to run the Postgres store tests';
let store: Store;

before(async () => {
  if (!url) return;
  store = postgres({ connectionString: url, schema });
  await store.migrate();
});

after(async () => {
  if (!url) return;
  await store.close();
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await admin.end();
});

const fact = (over: Partial<Fact> = {}): Fact => ({
  id: 'f1',
  subject: { type: 'unit', id: 'u1' },
  kind: 'recurring_issue',
  topic: 'wifi',
  statement: 'Wifi drops.',
  confidence: 0.5,
  status: 'active',
  evidence: [{ eventId: 'e1', connector: 'c', source: 'review', quote: 'wifi drops', occurredAt: '2026-09-01T00:00:00.000Z' }],
  firstSeen: '2026-09-01T00:00:00.000Z',
  lastSeen: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  ...over
});

test('migrate is safe to run again, including from two processes at once', { skip }, async () => {
  const other = postgres({ connectionString: url!, schema });
  await Promise.all([store.migrate(), other.migrate()]);
  await other.close();
});

test('a fact round-trips with its evidence and ISO dates', { skip }, async () => {
  await store.upsertFacts([fact()]);
  const f = await store.getFact('f1');
  assert.equal(f?.statement, 'Wifi drops.');
  assert.equal(f?.firstSeen, '2026-09-01T00:00:00.000Z');
  assert.deepEqual(f?.evidence.map((e) => e.quote), ['wifi drops']);
});

test('upserting replaces evidence rather than duplicating it', { skip }, async () => {
  const second = { eventId: 'e2', connector: 'c', source: 'review', quote: 'wifi again', occurredAt: '2026-09-02T00:00:00.000Z' };
  await store.upsertFacts([fact({ confidence: 0.75, evidence: [...fact().evidence, second] })]);
  const f = await store.getFact('f1');
  assert.equal(f?.evidence.length, 2);
  assert.equal(f?.confidence, 0.75);
});

test('events are new until processed, and again when their text changes', { skip }, async () => {
  const e = [{ id: 'a', hash: 'h1' }, { id: 'b', hash: 'h1' }];
  assert.equal((await store.filterNewEvents('c', e)).length, 2);
  await store.markEventsProcessed('c', e);
  assert.equal((await store.filterNewEvents('c', e)).length, 0);
  assert.deepEqual(await store.filterNewEvents('c', [{ id: 'a', hash: 'h2' }]), [{ id: 'a', hash: 'h2' }]);
});

test('subjects are found by exact name first, then by part of it; LIKE wildcards are literal', { skip }, async () => {
  await store.upsertSubjects([
    { type: 'unit', id: '1', name: 'Pine 2', connector: 'c', meta: { businessId: 'b' } },
    { type: 'unit', id: '2', name: 'Pine 21', connector: 'c' },
    { type: 'unit', id: '3', name: '100% View', connector: 'c' }
  ]);
  assert.deepEqual((await store.findSubjects('pine 2')).map((s) => s.id), ['1']);
  assert.deepEqual((await store.findSubjects('pine')).map((s) => s.id), ['1', '2']);
  assert.deepEqual((await store.findSubjects('0%')).map((s) => s.id), ['3']);
  assert.deepEqual((await store.getSubject({ type: 'unit', id: '1' }))?.meta, { businessId: 'b' });
});

test('checkpoints, runs and cost', { skip }, async () => {
  await store.setCheckpoint('c', new Date('2026-09-05T10:00:00.000Z'));
  assert.equal((await store.getCheckpoint('c'))?.toISOString(), '2026-09-05T10:00:00.000Z');
  const run = (id: string, startedAt: string, costUsd: number) => ({
    id, connector: 'c', startedAt, finishedAt: startedAt, status: 'completed' as const, eventsSeen: 1, eventsProcessed: 1,
    factsExtracted: 1, factsRejected: 0, factsWritten: 1, inputTokens: 10, outputTokens: 2, costUsd
  });
  await store.recordRun(run('r1', '2026-10-07T23:00:00.000Z', 1));
  await store.recordRun(run('r2', '2026-10-08T01:00:00.000Z', 0.25));
  assert.equal(await store.costSince(new Date('2026-10-08T00:00:00.000Z')), 0.25);
  assert.equal((await store.listRuns(1))[0]?.id, 'r2');
});

test('a full sync and ask work end to end on Postgres', { skip }, async () => {
  const s = postgres({ connectionString: url!, schema: `${schema}_e2e` });
  const memory = createMemory({
    connectors: [
      memoryConnector(
        'demo',
        [{ type: 'unit', id: 'u9', name: '228 Stoneridge', connector: 'demo' }],
        [{ id: 'e1', source: 'review', subject: { type: 'unit', id: 'u9' }, occurredAt: new Date().toISOString(), text: 'The hot tub was cold all weekend.' }]
      )
    ],
    store: s,
    llm: scriptedLlm((e) => [{ kind: 'recurring_issue', topic: 'hot_tub', statement: 'Hot tub does not heat.', quote: quoteFrom(e, 'hot tub was cold') }])
  });
  try {
    const [run] = await memory.sync();
    assert.equal(run?.factsWritten, 1);
    const result = await memory.ask('anything at 228 stone ridge?');
    assert.deepEqual(result.subjects.map((x) => x.name), ['228 Stoneridge']);
    assert.equal((await memory.search('hot tub'))[0]?.topic, 'hot_tub');
  } finally {
    await memory.close();
    const admin = new pg.Client({ connectionString: url! });
    await admin.connect();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema}_e2e CASCADE`);
    await admin.end();
  }
});
