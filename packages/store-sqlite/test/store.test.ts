import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Fact } from '@ops-memory/core';
import { sqlite } from '@ops-memory/store-sqlite';

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

test('migrate is safe to run twice and data survives a reopen', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ops-memory-'));
  const path = join(dir, 'nested', 'memory.db');
  try {
    const a = sqlite({ path });
    await a.migrate();
    await a.migrate();
    await a.upsertFacts([fact()]);
    await a.close();

    const b = sqlite({ path });
    await b.migrate();
    assert.equal((await b.getFact('f1'))?.statement, 'Wifi drops.');
    await b.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('upserting a fact replaces its evidence rather than duplicating it', async () => {
  const s = sqlite({ path: ':memory:' });
  await s.migrate();
  await s.upsertFacts([fact()]);
  const second = { eventId: 'e2', connector: 'c', source: 'review', quote: 'wifi again', occurredAt: '2026-09-02T00:00:00.000Z' };
  await s.upsertFacts([fact({ confidence: 0.75, evidence: [...fact().evidence, second] })]);
  const f = await s.getFact('f1');
  assert.equal(f?.evidence.length, 2);
  assert.equal(f?.confidence, 0.75);
  assert.equal((await s.stats()).evidence, 2);
  await s.close();
});

test('an event is new until processed, and new again when its text changes', async () => {
  const s = sqlite({ path: ':memory:' });
  await s.migrate();
  const e = [{ id: 'a', hash: 'h1' }, { id: 'b', hash: 'h1' }];
  assert.equal((await s.filterNewEvents('c', e)).length, 2);
  await s.markEventsProcessed('c', e);
  assert.equal((await s.filterNewEvents('c', e)).length, 0);
  assert.deepEqual(await s.filterNewEvents('c', [{ id: 'a', hash: 'h2' }]), [{ id: 'a', hash: 'h2' }]);
  assert.equal((await s.filterNewEvents('other', e)).length, 2, 'processed state is per connector');
  await s.close();
});

test('subjects are found by exact name first, then by part of the name', async () => {
  const s = sqlite({ path: ':memory:' });
  await s.migrate();
  await s.upsertSubjects([
    { type: 'unit', id: '1', name: 'Pine 2', connector: 'c' },
    { type: 'unit', id: '2', name: 'Pine 21', connector: 'c' }
  ]);
  assert.deepEqual((await s.findSubjects('pine 2')).map((x) => x.id), ['1']);
  assert.deepEqual((await s.findSubjects('pine')).map((x) => x.id), ['1', '2']);
  await s.close();
});

test('cost is summed from the runs since a moment', async () => {
  const s = sqlite({ path: ':memory:' });
  await s.migrate();
  const run = (id: string, startedAt: string, costUsd: number) => ({
    id, connector: 'c', startedAt, finishedAt: startedAt, status: 'completed' as const, eventsSeen: 0, eventsProcessed: 0,
    factsExtracted: 0, factsRejected: 0, factsWritten: 0, inputTokens: 0, outputTokens: 0, costUsd
  });
  await s.recordRun(run('a', '2026-10-07T23:00:00.000Z', 1));
  await s.recordRun(run('b', '2026-10-08T01:00:00.000Z', 0.25));
  assert.equal(await s.costSince(new Date('2026-10-08T00:00:00.000Z')), 0.25);
  await s.close();
});
