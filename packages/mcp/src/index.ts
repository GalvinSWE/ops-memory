import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import type { OpsMemory, SourceSubject } from '@ops-memory/core';
import { formatAnswer, formatFacts, formatProfile, formatSubjects } from './format.js';

export interface McpOptions {
  /** Server name shown to the client. Default `ops-memory`. */
  name?: string;
  /** Expose `ask`, which spends model tokens. Default true. */
  allowAsk?: boolean;
}

const text = (body: string) => ({ content: [{ type: 'text' as const, text: body }] });

/**
 * Read-only tools over an ops-memory. No tool syncs, writes or deletes: an agent connected here can
 * look things up, nothing more.
 */
export function createMcpServer(memory: OpsMemory, options: McpOptions = {}): McpServer {
  const server = new McpServer({ name: options.name ?? 'ops-memory', version: '0.1.0' });

  async function resolveSubject(nameOrId: string, type: string): Promise<SourceSubject | null> {
    const byId = await memory.config.store.getSubject({ type, id: nameOrId });
    if (byId) return byId;
    const matches = await memory.findSubjects(nameOrId);
    return matches.find((s) => s.type === type) ?? null;
  }

  server.registerTool(
    'find_subjects',
    {
      title: 'Find units',
      description: 'Find units (or other subjects) by name or id. Use it to get the exact name before asking for a profile.',
      inputSchema: { query: z.string().describe('Part of a unit name, e.g. "Pine" or "Glacier 305"') }
    },
    async ({ query }) => text(formatSubjects(await memory.findSubjects(query)))
  );

  server.registerTool(
    'get_unit_profile',
    {
      title: 'Unit profile',
      description:
        'Everything ops-memory knows about one unit: recurring issues, equipment, access notes, guest questions, ' +
        'each with confidence and the quotes it rests on. Resolved facts are listed separately.',
      inputSchema: {
        unit: z.string().describe('Unit name (alias) or id'),
        type: z.string().default('unit').describe('Subject type; leave as "unit"')
      }
    },
    async ({ unit, type }) => {
      const subject = await resolveSubject(unit, type);
      if (!subject) return text(`No ${type} named "${unit}". Try find_subjects.`);
      return text(formatProfile(await memory.profile(subject)));
    }
  );

  server.registerTool(
    'search_facts',
    {
      title: 'Search facts',
      description: 'Keyword search across all facts, e.g. "hot tub", "parking", "smoke alarm". Optionally within one unit.',
      inputSchema: {
        query: z.string(),
        unit: z.string().optional().describe('Limit to this unit (name or id)'),
        limit: z.number().int().min(1).max(100).default(20)
      }
    },
    async ({ query, unit, limit }) => {
      const subject = unit ? await resolveSubject(unit, 'unit') : undefined;
      if (unit && !subject) return text(`No unit named "${unit}".`);
      return text(formatFacts(await memory.search(query, { subject: subject ?? undefined, limit })));
    }
  );

  if (options.allowAsk !== false) {
    server.registerTool(
      'ask',
      {
        title: 'Ask ops-memory',
        description:
          'Answer a question in natural language from stored facts, citing them. Name the unit in the question ' +
          '(e.g. "What keeps breaking at Pine 2?"). Calls a model, so it costs tokens; prefer get_unit_profile ' +
          'when you only need the facts.',
        inputSchema: { question: z.string() }
      },
      async ({ question }) => text(formatAnswer(await memory.ask(question)))
    );
  }

  return server;
}

/** Serves over stdio, the transport Claude Desktop and Claude Code use for local servers. */
export async function serveStdio(memory: OpsMemory, options: McpOptions = {}): Promise<void> {
  const server = createMcpServer(memory, options);
  await server.connect(new StdioServerTransport());
}

export { formatAnswer, formatFact, formatFacts, formatProfile, formatSubjects } from './format.js';
