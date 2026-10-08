import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commentToEvent, reviewToEvent, ticketToEvent, unitToSubject } from '@ops-memory/connector-cleanover';

const at = new Date('2026-09-01T10:00:00.000Z');

test('a unit becomes a subject named by its alias', () => {
  assert.deepEqual(unitToSubject({ id: 'u1', alias: 'Pine 2', address: '1 Main', business_id: 'b1' }), {
    type: 'unit',
    id: 'u1',
    name: 'Pine 2',
    connector: 'cleanover',
    meta: { businessId: 'b1' }
  });
});

test('a ticket reads as title, status, description and comment', () => {
  const e = ticketToEvent({
    id: 't1', unit_id: 'u1', name: 'Dishwasher leak', description: 'Water under the door\r\n', comment: null,
    status_name: 'Open', created_at: at, updated_at: at
  });
  assert.equal(e?.id, 'maintenance_ticket:t1');
  assert.equal(e?.text, 'Maintenance ticket: Dishwasher leak\nStatus: Open\nWater under the door');
  assert.equal(e?.occurredAt, '2026-09-01T10:00:00.000Z');
});

test('an empty ticket is skipped', () => {
  assert.equal(
    ticketToEvent({ id: 't', unit_id: 'u', name: '', description: null, comment: ' ', status_name: null, created_at: at, updated_at: at }),
    null
  );
});

test('a comment carries its ticket title for context; a near-empty one is skipped', () => {
  const e = commentToEvent({ id: 'c1', unit_id: 'u1', ticket_id: 't1', ticket_name: 'Dishwasher leak', content: 'Replaced the seal', created_at: at });
  assert.equal(e?.text, 'Comment on maintenance ticket "Dishwasher leak":\nReplaced the seal');
  assert.equal(commentToEvent({ id: 'c2', unit_id: 'u1', ticket_id: 't1', ticket_name: 'x', content: 'ok', created_at: at }), null);
});

test('a review keeps rating, public text and private feedback, and its submitted time', () => {
  const submitted = new Date('2026-08-20T00:00:00.000Z');
  const e = reviewToEvent({
    id: 'r1', unit_id: 'u1', overall_rating: 4, review_text: 'Great view', private_feedback: 'Wifi was slow',
    submitted_at: submitted, created_at: at
  });
  assert.equal(e?.occurredAt, submitted.toISOString());
  assert.match(e?.text ?? '', /overall rating 4[\s\S]*Great view[\s\S]*Wifi was slow/);
});

test('a link builder adds the url to the record', () => {
  const e = reviewToEvent(
    { id: 'r1', unit_id: 'u1', overall_rating: null, review_text: 'Nice', private_feedback: null, submitted_at: null, created_at: at },
    ({ id }) => `https://app.example/reviews/${id}`
  );
  assert.equal(e?.url, 'https://app.example/reviews/r1');
});
