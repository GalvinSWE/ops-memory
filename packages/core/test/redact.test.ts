import assert from 'node:assert/strict';
import { test } from 'node:test';
import { redact } from '@ops-memory/core';

test('door, lockbox and wifi codes are removed, the words around them kept', () => {
  assert.equal(redact('Door code is 4821# for the side entrance'), 'Door code is [REDACTED_CODE] for the side entrance');
  assert.equal(redact('lockbox: 0912'), 'lockbox: [REDACTED_CODE]');
  assert.equal(redact('wifi password: summer2024'), 'wifi password: [REDACTED_CODE]');
  assert.equal(redact('PIN 7788'), 'PIN [REDACTED_CODE]');
});

test('the word "code" followed by an ordinary word is not a code', () => {
  assert.equal(redact('The code is broken on the keypad'), 'The code is broken on the keypad');
});

test('emails and phone numbers are removed', () => {
  assert.equal(redact('Call me at +1 (403) 555-0199 or jo@example.com'), 'Call me at [REDACTED_PHONE] or [REDACTED_EMAIL]');
});

test('short numbers such as unit numbers and dates stay', () => {
  assert.equal(redact('Unit 305, checked on 2026-09-12'), 'Unit 305, checked on 2026-09-12');
});

test('secrets in link query strings are removed', () => {
  assert.equal(redact('https://x.test/a?token=abc123&b=1'), 'https://x.test/a?token=[REDACTED]&b=1');
});

test('rules can be switched off and custom patterns added', () => {
  assert.equal(redact('jo@example.com', { rules: [] }), 'jo@example.com');
  assert.equal(redact('ref ZX-99', { rules: [], patterns: [/ZX-\d+/g] }), 'ref [REDACTED]');
});
