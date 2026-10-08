import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { main } from '@ops-memory/cli';

const capture = () => {
  const lines: string[] = [];
  const errors: string[] = [];
  return { out: { log: (s: string) => lines.push(s), error: (s: string) => errors.push(s) }, lines, errors };
};

async function inTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'ops-memory-cli-'));
  const cwd = process.cwd();
  process.chdir(dir);
  try {
    return await fn(dir);
  } finally {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
}

test('no command prints help', async () => {
  const c = capture();
  assert.equal(await main([], c.out), 0);
  assert.match(c.lines.join('\n'), /Usage: ops-memory <command>/);
});

test('init writes a config once and refuses to overwrite it', async () => {
  await inTempDir(async (dir) => {
    const c = capture();
    assert.equal(await main(['init'], c.out), 0);
    assert.match(readFileSync(join(dir, 'ops-memory.config.ts'), 'utf8'), /defineConfig\(/);
    assert.equal(await main(['init'], c.out), 1);
  });
});

test('a missing config says how to make one', async () => {
  await inTempDir(async () => {
    await assert.rejects(main(['status'], capture().out), /Run `ops-memory init`/);
  });
});

test('sync, status and profile run end to end from a JS config', async () => {
  await inTempDir(async (dir) => {
    const core = import.meta.resolve('@ops-memory/core');
    const testing = import.meta.resolve('@ops-memory/core/testing');
    const store = import.meta.resolve('@ops-memory/store-sqlite');
    writeFileSync(
      join(dir, 'ops-memory.config.mjs'),
      `import { defineConfig } from '${core}';
       import { memoryConnector, scriptedLlm, quoteFrom } from '${testing}';
       import { sqlite } from '${store}';
       export default defineConfig({
         connectors: [memoryConnector('demo',
           [{ type: 'unit', id: 'u1', name: 'Pine 2', connector: 'demo' }],
           [{ id: 'e1', source: 'review', subject: { type: 'unit', id: 'u1' }, occurredAt: new Date().toISOString(), text: 'Parking is behind the building.' }])],
         store: sqlite({ path: './memory.db' }),
         llm: scriptedLlm((e) => [{ kind: 'access_info', topic: 'parking', statement: 'Park behind the building.', quote: quoteFrom(e, 'Parking is behind the building') }])
       });`
    );
    const c = capture();
    assert.equal(await main(['sync'], c.out), 0);
    assert.match(c.lines.join('\n'), /demo: completed · 1 events read · 1 processed · 1 facts written/);
    assert.ok(existsSync(join(dir, 'memory.db')));

    const s = capture();
    assert.equal(await main(['status'], s.out), 0);
    assert.match(s.lines.join('\n'), /facts 1 \(1 active\)/);

    const p = capture();
    assert.equal(await main(['profile', 'Pine', '2'], p.out), 0);
    assert.match(p.lines.join('\n'), /Park behind the building\./);
  });
});
