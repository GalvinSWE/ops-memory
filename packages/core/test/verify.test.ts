import assert from 'node:assert/strict';
import { test } from 'node:test';
import { verifyExtracted, type ExtractedFact, type SourceEvent } from '@ops-memory/core';

const event: SourceEvent = {
  id: 'e1',
  source: 'maintenance_ticket',
  subject: { type: 'unit', id: 'u1' },
  occurredAt: '2026-09-01T10:00:00.000Z',
  text: 'Guest says the   WiFi drops every evening; router in the hall closet.'
};
const kinds = new Set(['recurring_issue', 'equipment']);
const fact = (over: Partial<ExtractedFact>): ExtractedFact => ({
  eventId: 'e1',
  kind: 'recurring_issue',
  topic: 'wifi',
  statement: 'The wifi drops in the evenings.',
  quote: 'the WiFi drops every evening',
  ...over
});

test('a quote found in the event is accepted, ignoring case and spacing', () => {
  const { accepted, rejected } = verifyExtracted([fact({})], [event], kinds);
  assert.equal(accepted.length, 1);
  assert.equal(rejected.length, 0);
});

test('typographic quotes and dashes in the quote still match', () => {
  const e = { ...event, text: "The owner's note - don't use the dryer" };
  const { accepted } = verifyExtracted([fact({ quote: 'owner’s note – don’t use the dryer' })], [e], kinds);
  assert.equal(accepted.length, 1);
});

test('an invented or paraphrased quote is rejected', () => {
  const { accepted, rejected } = verifyExtracted([fact({ quote: 'the internet is unreliable at night' })], [event], kinds);
  assert.equal(accepted.length, 0);
  assert.equal(rejected[0]?.reason, 'quote_not_found');
});

test('a fact pointing at an event that was not sent is rejected', () => {
  const { rejected } = verifyExtracted([fact({ eventId: 'e999' })], [event], kinds);
  assert.equal(rejected[0]?.reason, 'unknown_event');
});

test('a kind that is not enabled is rejected', () => {
  const { rejected } = verifyExtracted([fact({ kind: 'guest_praise' })], [event], kinds);
  assert.equal(rejected[0]?.reason, 'unknown_kind');
});

test('a trivially short quote is rejected', () => {
  const { rejected } = verifyExtracted([fact({ quote: 'wifi' })], [event], kinds);
  assert.equal(rejected[0]?.reason, 'quote_not_found');
});
