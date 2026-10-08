import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMemory } from '@ops-memory/core';
import { memoryConnector, quoteFrom, scriptedLlm } from '@ops-memory/core/testing';
import { createMcpServer } from '@ops-memory/mcp';
import { sqlite } from '@ops-memory/store-sqlite';

async function connected(allowAsk = true) {
  const memory = createMemory({
    connectors: [
      memoryConnector(
        'demo',
        [{ type: 'unit', id: 'u1', name: 'Pine 2', connector: 'demo' }],
        [{ id: 'e1', source: 'review', subject: { type: 'unit', id: 'u1' }, occurredAt: new Date().toISOString(), text: 'The hot tub was cold all weekend.' }]
      )
    ],
    store: sqlite({ path: ':memory:' }),
    llm: scriptedLlm((e) => [
      { kind: 'recurring_issue', topic: 'hot_tub', statement: 'The hot tub does not heat.', quote: quoteFrom(e, 'hot tub was cold') }
    ])
  });
  await memory.sync();
  const server = createMcpServer(memory, { allowAsk });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientSide);
  return { client, memory };
}

const textOf = (r: unknown) => ((r as { content: { text: string }[] }).content[0]?.text ?? '');

test('the server offers read-only tools only', async () => {
  const { client, memory } = await connected();
  const names = (await client.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['ask', 'find_subjects', 'get_unit_profile', 'search_facts']);
  await client.close();
  await memory.close();
});

test('ask can be hidden so clients cannot spend tokens', async () => {
  const { client, memory } = await connected(false);
  assert.ok(!(await client.listTools()).tools.some((t) => t.name === 'ask'));
  await client.close();
  await memory.close();
});

test('get_unit_profile finds a unit by name and shows facts with quotes', async () => {
  const { client, memory } = await connected();
  const out = textOf(await client.callTool({ name: 'get_unit_profile', arguments: { unit: 'Pine 2' } }));
  assert.match(out, /unit "Pine 2"/);
  assert.match(out, /The hot tub does not heat\./);
  assert.match(out, /"hot tub was cold"/);
  await client.close();
  await memory.close();
});

test('an unknown unit gets a pointer to find_subjects', async () => {
  const { client, memory } = await connected();
  const out = textOf(await client.callTool({ name: 'get_unit_profile', arguments: { unit: 'Nowhere 9' } }));
  assert.match(out, /No unit named "Nowhere 9"\. Try find_subjects\./);
  await client.close();
  await memory.close();
});
