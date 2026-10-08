import assert from 'node:assert/strict';
import { test } from 'node:test';
import { confidenceFor, factId, mergeFact, type ExtractedFact, type Fact, type SourceEvent } from '@ops-memory/core';

const subject = { type: 'unit', id: 'u1' };
const event = (id: string, day: string): SourceEvent => ({
  id,
  source: 'maintenance_ticket',
  subject,
  occurredAt: `2026-${day}T10:00:00.000Z`,
  text: '…'
});
const extracted = (over: Partial<ExtractedFact> = {}): ExtractedFact => ({
  eventId: 'x',
  kind: 'recurring_issue',
  topic: 'Dishwasher',
  statement: 'The dishwasher leaks.',
  quote: 'dishwasher is leaking',
  ...over
});
const merge = (existing: Fact | null, e: SourceEvent, x: ExtractedFact) =>
  mergeFact({ subject, extracted: x, event: e, connector: 'c', kind: undefined, existing, now: '2026-10-08T00:00:00.000Z' });

test('confidence rises with each independent piece of evidence', () => {
  assert.deepEqual([1, 2, 3, 4].map(confidenceFor), [0.5, 0.75, 0.875, 0.938]);
});

test('the same topic written differently lands on the same fact', () => {
  const a = merge(null, event('e1', '09-01'), extracted({ topic: 'Dishwasher' }));
  const b = merge(null, event('e2', '09-02'), extracted({ topic: ' dishwasher ' }));
  assert.equal(a.id, b.id);
  assert.equal(a.id, factId(subject, 'recurring_issue:dishwasher'));
});

test('a second report adds evidence, raises confidence and keeps the newest statement', () => {
  const first = merge(null, event('e1', '09-01'), extracted());
  const second = merge(first, event('e2', '09-10'), extracted({ statement: 'The dishwasher leaks again.' }));
  assert.equal(second.evidence.length, 2);
  assert.equal(second.confidence, 0.75);
  assert.equal(second.statement, 'The dishwasher leaks again.');
  assert.equal(second.firstSeen, '2026-09-01T10:00:00.000Z');
  assert.equal(second.lastSeen, '2026-09-10T10:00:00.000Z');
});

test('the same event read twice does not count twice', () => {
  const first = merge(null, event('e1', '09-01'), extracted());
  const again = merge(first, event('e1', '09-01'), extracted());
  assert.equal(again.evidence.length, 1);
  assert.equal(again.confidence, 0.5);
});

test('a later "fixed" record resolves the fact, and a newer report reopens it', () => {
  const broken = merge(null, event('e1', '09-01'), extracted());
  const fixed = merge(broken, event('e2', '09-05'), extracted({ resolved: true, statement: 'Dishwasher replaced.' }));
  assert.equal(fixed.status, 'resolved');
  const back = merge(fixed, event('e3', '09-20'), extracted({ statement: 'The new dishwasher leaks too.' }));
  assert.equal(back.status, 'active');
  assert.equal(back.statement, 'The new dishwasher leaks too.');
});

test('an older record read late adds evidence without overriding the current state', () => {
  const fixed = merge(null, event('e2', '09-05'), extracted({ resolved: true, statement: 'Dishwasher replaced.' }));
  const late = merge(fixed, event('e1', '09-01'), extracted());
  assert.equal(late.status, 'resolved');
  assert.equal(late.statement, 'Dishwasher replaced.');
  assert.equal(late.firstSeen, '2026-09-01T10:00:00.000Z');
  assert.deepEqual(late.evidence.map((e) => e.eventId), ['e1', 'e2']);
});

test('a kind can define its own merge key', () => {
  const kind = { name: 'equipment', description: '', mergeKey: () => 'equipment:any' };
  const f = mergeFact({
    subject,
    extracted: extracted({ kind: 'equipment' }),
    event: event('e1', '09-01'),
    connector: 'c',
    kind,
    existing: null,
    now: '2026-10-08T00:00:00.000Z'
  });
  assert.equal(f.id, factId(subject, 'equipment:any'));
});
