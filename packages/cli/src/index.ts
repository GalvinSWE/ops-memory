import { existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createMemory, type OpsMemory, type SubjectRef } from '@ops-memory/core';
import { formatAnswer, formatFacts, formatProfile, formatSubjects, serveStdio } from '@ops-memory/mcp';
import { startVoiceServer } from '@ops-memory/voice-server';
import { findConfig, loadConfig } from './load-config.js';
import { CONFIG_TEMPLATE } from './template.js';

export const HELP = `ops-memory — operational memory for property management

Usage: ops-memory <command> [options]

Commands
  init                      Write ops-memory.config.ts in the current folder
  sync                      Read new records and extract facts
      --connector <name>      Only this connector
      --max-events <n>        Cap events read this run
      --dry-run               Count new events; call no model, write nothing
  ask "<question>"          Answer from stored facts, with sources
      --unit <name|id>        Only facts about this unit
      --no-sources            Print the answer only
  profile <unit>            Everything known about one unit
  search "<words>"          Keyword search over facts
      --unit <name|id>        Within one unit
  units "<name>"            Find units by name
  status                    Counts, checkpoints, today's spend, recent runs
  serve                     Run as an MCP server on stdio (read-only tools)
      --no-ask                Hide the ask tool (no model spend from clients)
  voice                     HTTP server for voice clients (POST /v1/ask)
      --port <n>              Default 7401
      --host <addr>           Default 127.0.0.1 (this machine only)
      --origin <url>          Allowed browser origin; repeat for several (default localhost:3000)
      --mode <auto|facts|model>  Default auto; facts never calls a model
      Token: set OPS_MEMORY_VOICE_TOKEN to require "Authorization: Bearer <token>"

Global options
  --config <file>           Config file (default: ops-memory.config.ts in the current folder)
  -h, --help                This help
`;

type Out = { log: (s: string) => void; error: (s: string) => void };

export async function main(argv: string[], out: Out = { log: console.log, error: console.error }): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      config: { type: 'string' },
      connector: { type: 'string' },
      'max-events': { type: 'string' },
      'dry-run': { type: 'boolean' },
      unit: { type: 'string' },
      'no-sources': { type: 'boolean' },
      'no-ask': { type: 'boolean' },
      port: { type: 'string' },
      host: { type: 'string' },
      origin: { type: 'string', multiple: true },
      mode: { type: 'string' },
      help: { type: 'boolean', short: 'h' }
    }
  });
  const [command, ...rest] = positionals;

  if (!command || values.help) {
    out.log(HELP);
    return 0;
  }

  if (command === 'init') {
    const path = resolve(process.cwd(), 'ops-memory.config.ts');
    if (existsSync(path)) {
      out.error(`${path} already exists; not overwritten.`);
      return 1;
    }
    writeFileSync(path, CONFIG_TEMPLATE);
    out.log(`Wrote ${path}. Copy .env.example to .env and fill it in, then run \`ops-memory sync --dry-run\`.`);
    return 0;
  }

  const memory = createMemory(await loadConfig(findConfig(process.cwd(), values.config)));
  try {
    await memory.init();
    return await run(memory, command, rest, values, out);
  } finally {
    if (command !== 'serve' && command !== 'voice') await memory.close();
  }
}

async function unitRef(memory: OpsMemory, nameOrId: string): Promise<SubjectRef> {
  const byId = await memory.config.store.getSubject({ type: 'unit', id: nameOrId });
  if (byId) return byId;
  const matches = (await memory.findSubjects(nameOrId)).filter((s) => s.type === 'unit');
  const exact = matches.find((s) => s.name.toLowerCase() === nameOrId.toLowerCase());
  if (exact) return exact;
  if (matches.length === 1) return matches[0]!;
  if (!matches.length) throw new Error(`No unit named "${nameOrId}". Run \`ops-memory sync\` first, or try \`ops-memory units "${nameOrId}"\`.`);
  throw new Error(`"${nameOrId}" matches ${matches.length} units:\n${formatSubjects(matches.slice(0, 10))}`);
}

async function run(
  memory: OpsMemory,
  command: string,
  args: string[],
  values: Record<string, string | boolean | string[] | undefined>,
  out: Out
): Promise<number> {
  switch (command) {
    case 'sync': {
      const maxEvents = values['max-events'] ? Number(values['max-events']) : undefined;
      const results = await memory.sync({
        connector: values.connector as string | undefined,
        maxEvents,
        dryRun: !!values['dry-run']
      });
      for (const r of results) {
        out.log(
          `${r.connector}: ${r.status}${r.dryRun ? ' (dry run)' : ''} · ${r.eventsSeen} events read · ` +
            `${r.eventsProcessed} processed · ${r.factsWritten} facts written · ${r.factsRejected} rejected · ` +
            `$${r.costUsd.toFixed(4)}${r.error ? `\n  error: ${r.error}` : ''}`
        );
      }
      return results.some((r) => r.status === 'failed') ? 1 : 0;
    }
    case 'ask': {
      const question = args.join(' ').trim();
      if (!question) throw new Error('Usage: ops-memory ask "<question>"');
      const subject = values.unit ? await unitRef(memory, String(values.unit)) : undefined;
      const result = await memory.ask(question, { subject });
      out.log(formatAnswer(result, !values['no-sources']));
      if (result.usage) out.error(`(${result.usage.inputTokens} in / ${result.usage.outputTokens} out, $${result.usage.costUsd.toFixed(4)})`);
      return 0;
    }
    case 'profile': {
      const name = args.join(' ').trim();
      if (!name) throw new Error('Usage: ops-memory profile <unit>');
      out.log(formatProfile(await memory.profile(await unitRef(memory, name))));
      return 0;
    }
    case 'search': {
      const text = args.join(' ').trim();
      if (!text) throw new Error('Usage: ops-memory search "<words>"');
      const subject = values.unit ? await unitRef(memory, String(values.unit)) : undefined;
      out.log(formatFacts(await memory.search(text, { subject })));
      return 0;
    }
    case 'units': {
      out.log(formatSubjects(await memory.findSubjects(args.join(' ').trim())));
      return 0;
    }
    case 'status': {
      const s = await memory.status();
      out.log(
        [
          `Subjects ${s.stats.subjects} · facts ${s.stats.facts} (${s.stats.activeFacts} active) · evidence ${s.stats.evidence} · events read ${s.stats.processedEvents}`,
          `Spent today $${s.spentTodayUsd.toFixed(4)} of $${s.budgetPerDayUsd}`,
          ...s.checkpoints.map((c) => `Checkpoint ${c.connector}: ${c.at ?? 'never synced'}`),
          s.recentRuns.length ? '\nRecent runs' : '',
          ...s.recentRuns.map(
            (r) => `  ${r.startedAt.slice(0, 19)} ${r.connector} ${r.status} · ${r.eventsProcessed}/${r.eventsSeen} events · ${r.factsWritten} facts · $${r.costUsd.toFixed(4)}`
          )
        ]
          .filter(Boolean)
          .join('\n')
      );
      return 0;
    }
    case 'serve': {
      // stdout belongs to the MCP protocol from here on; log to stderr only.
      await serveStdio(memory, { allowAsk: !values['no-ask'] });
      out.error('ops-memory MCP server running on stdio');
      return 0;
    }
    case 'voice': {
      const mode = (values.mode as string | undefined) ?? 'auto';
      if (!['auto', 'facts', 'model'].includes(mode)) throw new Error('--mode must be auto, facts or model');
      const { url } = await startVoiceServer(memory, {
        port: values.port ? Number(values.port) : undefined,
        host: values.host as string | undefined,
        allowedOrigins: values.origin as string[] | undefined,
        token: process.env.OPS_MEMORY_VOICE_TOKEN || undefined,
        defaultMode: mode as 'auto' | 'facts' | 'model',
        allowModel: mode !== 'facts',
        log: (line) => out.error(line)
      });
      out.log(`ops-memory voice server on ${url} (mode ${mode})`);
      return 0;
    }
    default:
      out.error(`Unknown command "${command}".\n\n${HELP}`);
      return 1;
  }
}
