import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createVoiceAsk } from '@ops-memory/voice-web';

const answer = {
  question: 'q',
  answer: 'Wifi drops [F1].',
  spoken: 'Wifi drops.',
  answeredBy: 'model',
  sources: [],
  units: [],
  costUsd: 0
};

/** A fetch that answers after `delayMs`, or never if `delayMs` is Infinity; honours the abort signal. */
const slowFetch = (delayMs: number, body: unknown = answer, status = 200) =>
  ((_url: string, init: RequestInit) =>
    new Promise<Response>((resolve, reject) => {
      const timer = Number.isFinite(delayMs) ? setTimeout(() => resolve(new Response(JSON.stringify(body), { status })), delayMs) : null;
      init.signal?.addEventListener('abort', () => {
        if (timer) clearTimeout(timer);
        reject(new DOMException('aborted', 'AbortError'));
      });
    })) as unknown as typeof fetch;

test('a typed question returns the answer and goes back to idle when not speaking', async () => {
  const voice = createVoiceAsk({ endpoint: 'http://x', speak: false, fetch: slowFetch(1) });
  const result = await voice.ask('What about Pine 2?');
  assert.equal(result?.answer, 'Wifi drops [F1].');
  assert.equal(voice.getSnapshot().state, 'idle');
  assert.equal(voice.getSnapshot().transcript, 'What about Pine 2?');
});

test('a slow server is reported as a timeout naming the limit', async () => {
  const voice = createVoiceAsk({ endpoint: 'http://x', speak: false, timeoutMs: 20, fetch: slowFetch(Infinity) });
  assert.equal(await voice.ask('q'), null);
  assert.equal(voice.getSnapshot().state, 'error');
  assert.match(voice.getSnapshot().error ?? '', /did not answer within 0 s|did not answer within \d+ s/);
});

test('cancelling while waiting is not an error', async () => {
  const voice = createVoiceAsk({ endpoint: 'http://x', speak: false, fetch: slowFetch(Infinity) });
  const pending = voice.ask('q');
  voice.cancel();
  assert.equal(await pending, null);
  assert.equal(voice.getSnapshot().state, 'idle');
  assert.equal(voice.getSnapshot().error, null);
});

test('a newer question supersedes an older one without an error', async () => {
  const voice = createVoiceAsk({ endpoint: 'http://x', speak: false, fetch: slowFetch(30) });
  const first = voice.ask('first');
  const second = voice.ask('second');
  assert.equal(await first, null);
  assert.equal((await second)?.answer, 'Wifi drops [F1].');
  assert.equal(voice.getSnapshot().error, null);
});

test('a server error message is shown as is', async () => {
  const voice = createVoiceAsk({ endpoint: 'http://x', speak: false, fetch: slowFetch(1, { error: 'no unit named "Nowhere"' }, 400) });
  await voice.ask('q');
  assert.equal(voice.getSnapshot().error, 'no unit named "Nowhere"');
});

test('without browser speech recognition, start explains instead of throwing', () => {
  const voice = createVoiceAsk({ endpoint: 'http://x' });
  voice.start();
  assert.equal(voice.getSnapshot().state, 'error');
  assert.match(voice.getSnapshot().error ?? '', /cannot recognise speech/);
});

test('the request carries the question, unit, mode and token', async () => {
  let seen: { url: string; init: RequestInit } | null = null;
  const fetchSpy = (async (url: string, init: RequestInit) => {
    seen = { url, init };
    return new Response(JSON.stringify(answer));
  }) as unknown as typeof fetch;
  const voice = createVoiceAsk({ endpoint: 'http://x/', speak: false, unit: 'Pine 2', mode: 'facts', token: 't0k', fetch: fetchSpy });
  await voice.ask('  hello ');
  assert.equal(seen!.url, 'http://x/v1/ask');
  assert.deepEqual(JSON.parse(String(seen!.init.body)), { question: 'hello', unit: 'Pine 2', mode: 'facts' });
  assert.equal((seen!.init.headers as Record<string, string>).authorization, 'Bearer t0k');
});
