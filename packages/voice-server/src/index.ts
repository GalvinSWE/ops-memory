import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import type { OpsMemory } from '@ops-memory/core';
import { answerTurn, VoiceInputError, type AnswerMode, type VoiceAskRequest } from '@ops-memory/voice-core';

export interface VoiceServerOptions {
  /** Default 7401. */
  port?: number;
  /** Default `127.0.0.1`: reachable from this machine only. Set `0.0.0.0` deliberately. */
  host?: string;
  /** Browser origins allowed to call the API (CORS). Default: localhost:3000 and 127.0.0.1:3000. */
  allowedOrigins?: string[];
  /** When set, requests must send `Authorization: Bearer <token>`. */
  token?: string;
  /** Requests per minute per client address. Default 30. */
  rateLimitPerMinute?: number;
  /** Mode when the request does not choose one. Default `auto`. */
  defaultMode?: AnswerMode;
  /** Allow clients to ask for `model` / `auto` (token spend). Default true. */
  allowModel?: boolean;
  log?: (line: string) => void;
}

const MAX_BODY_BYTES = 8 * 1024;
const DEFAULT_ORIGINS = ['http://localhost:3000', 'http://127.0.0.1:3000'];

/**
 * Builds the request handler. Routes:
 * - `GET  /v1/health` → `{ ok, facts, subjects }`
 * - `POST /v1/ask`    → `VoiceAskResponse` for a `VoiceAskRequest` body
 */
export function createVoiceHandler(memory: OpsMemory, options: VoiceServerOptions = {}) {
  const origins = new Set(options.allowedOrigins ?? DEFAULT_ORIGINS);
  const limit = options.rateLimitPerMinute ?? 30;
  const log = options.log ?? (() => {});
  const hits = new Map<string, number[]>();

  const rateLimited = (key: string): boolean => {
    const now = Date.now();
    const recent = (hits.get(key) ?? []).filter((t) => now - t < 60_000);
    recent.push(now);
    hits.set(key, recent);
    if (hits.size > 10_000) hits.clear(); // bounded memory; a restart of the window is acceptable
    return recent.length > limit;
  };

  const authorized = (req: IncomingMessage): boolean => {
    if (!options.token) return true;
    const header = req.headers.authorization ?? '';
    const given = Buffer.from(header.replace(/^Bearer\s+/i, ''));
    const expected = Buffer.from(options.token);
    return given.length === expected.length && timingSafeEqual(given, expected);
  };

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const origin = req.headers.origin;
    if (origin && origins.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'content-type, authorization');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Max-Age', '600');
    }
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    };

    try {
      const url = new URL(req.url ?? '/', 'http://local');
      if (req.method === 'OPTIONS') {
        res.writeHead(origin && origins.has(origin) ? 204 : 403);
        res.end();
        return;
      }
      if (origin && !origins.has(origin)) return send(403, { error: 'origin not allowed' });
      if (!authorized(req)) return send(401, { error: 'missing or wrong token' });

      if (req.method === 'GET' && url.pathname === '/v1/health') {
        const { stats } = await memory.status();
        return send(200, { ok: true, facts: stats.facts, subjects: stats.subjects });
      }

      if (req.method === 'POST' && url.pathname === '/v1/ask') {
        if (rateLimited(req.socket.remoteAddress ?? 'unknown')) return send(429, { error: 'too many requests, try again in a minute' });
        const body = (await readJson(req)) as VoiceAskRequest;
        const mode = options.allowModel === false ? 'facts' : body.mode;
        const started = Date.now();
        log(`ask started (${String(body.question ?? '').length} chars, mode ${mode ?? options.defaultMode ?? 'auto'})`);
        const result = await answerTurn(
          memory,
          { question: String(body.question ?? ''), unit: body.unit ? String(body.unit) : undefined, mode },
          { defaultMode: options.allowModel === false ? 'facts' : options.defaultMode, onFallback: (e) => log(`model unavailable, answered from facts: ${e instanceof Error ? e.message : e}`) }
        );
        log(`ask ${result.answeredBy} ${result.sources.length} facts ${Date.now() - started}ms $${result.costUsd.toFixed(4)}`);
        return send(200, result);
      }

      return send(404, { error: 'not found' });
    } catch (error) {
      if (error instanceof VoiceInputError || error instanceof BodyError) return send(400, { error: error.message });
      log(`error: ${error instanceof Error ? error.stack : error}`);
      return send(500, { error: 'internal error' });
    }
  };
}

export async function startVoiceServer(memory: OpsMemory, options: VoiceServerOptions = {}): Promise<{ server: Server; url: string }> {
  const server = createServer(createVoiceHandler(memory, options));
  const port = options.port ?? 7401;
  const host = options.host ?? '127.0.0.1';
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  return { server, url: `http://${host}:${actualPort}` };
}

class BodyError extends Error {}

async function readJson(req: IncomingMessage): Promise<unknown> {
  if (!/^application\/json/i.test(req.headers['content-type'] ?? '')) throw new BodyError('send JSON (content-type: application/json)');
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new BodyError('request body too large');
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw new BodyError('body is not valid JSON');
  }
}
