import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nameMatchScore } from '@ops-memory/core';

/** The same term building `ask` uses: words plus neighbouring words joined. */
const terms = (q: string) => {
  const w = q.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const t = new Set(w);
  w.forEach((_, i) => {
    if (w[i + 1]) t.add(w[i]! + w[i + 1]!);
    if (w[i + 2]) t.add(w[i]! + w[i + 1]! + w[i + 2]!);
  });
  return t;
};

test('a name split by speech still matches a name written as one word', () => {
  assert.ok(nameMatchScore('228 Stoneridge', terms('what about 228 stone ridge')) > 0);
});

test('case and punctuation do not matter', () => {
  assert.ok(nameMatchScore('228 Stoneridge', terms('Any issues at 228 STONERIDGE?')) > 0);
});

test('numbers must match exactly', () => {
  assert.equal(nameMatchScore('Pine 2', terms('what keeps breaking at pine 21')), 0);
  assert.ok(nameMatchScore('Pine 21', terms('what keeps breaking at pine 21')) > 0);
});

test('a bracketed note in the name is not required', () => {
  assert.ok(nameMatchScore('307 Silver Creek (SC)', terms('tell me about 307 silver creek')) > 0);
});

test('either half of an "A / B" name is enough', () => {
  assert.ok(nameMatchScore('All Golden Cabins / Kicking Horse River Chalet', terms('kicking horse river chalet parking?')) > 0);
});

test('part of a name is not a match', () => {
  assert.equal(nameMatchScore('318 Ascent', terms('what about ascent')), 0);
});

test('greetings and filler words are not searched for', async () => {
  const { searchWords } = await import('@ops-memory/core');
  assert.deepEqual(searchWords('hello there, what is this?'), []);
  assert.deepEqual(searchWords('Where is the hot tub cover?'), ['hot', 'tub', 'cover']);
  assert.deepEqual(searchWords('xin chào, căn này có wifi không'), ['wifi']);
});
