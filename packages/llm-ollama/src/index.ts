import {
  ANSWER_SYSTEM_PROMPT,
  answerUserPrompt,
  extractionSystemPrompt,
  extractionUserPrompt,
  type ExtractedFact,
  type FactKind,
  type LlmProvider
} from '@ops-memory/core';

export interface OllamaProviderOptions {
  /** Model for extraction, as pulled with `ollama pull`. Default `qwen2.5:7b`. */
  extractModel?: string;
  /** Model for answers. Default: the extraction model. */
  answerModel?: string;
  /** Ollama server. Default `http://localhost:11434` or `OLLAMA_HOST`. */
  host?: string;
  /** Context window in tokens. Ollama's default is small; batches need room. Default 16384. */
  numCtx?: number;
  /** Default 0 for extraction (copy, don't create) and 0.3 for answers. */
  temperature?: { extract?: number; answer?: number };
  /** Per request. Local models are slow on long batches. Default 10 minutes. */
  timeoutMs?: number;
  /** How long Ollama keeps the model in memory after a request. Default `30m`, so a voice question does not wait for a reload. */
  keepAlive?: string;
  /** Override for tests. */
  fetch?: typeof fetch;
}

interface ChatResponse {
  message?: { content?: string };
  prompt_eval_count?: number;
  eval_count?: number;
  done_reason?: string;
  error?: string;
}

/**
 * Runs extraction and answers on a local Ollama model. Free and private: no text leaves the
 * machine. Smaller models paraphrase more often; quote verification drops those facts, so expect
 * fewer facts than with Claude, not wrong ones. Cost is reported as 0, so the daily budget never
 * stops a local run.
 */
export function ollama(options: OllamaProviderOptions = {}): LlmProvider {
  const extractModel = options.extractModel ?? 'qwen2.5:7b';
  const answerModel = options.answerModel ?? extractModel;
  const host = (options.host ?? process.env.OLLAMA_HOST ?? 'http://localhost:11434').replace(/\/$/, '');
  const base = /^https?:\/\//.test(host) ? host : `http://${host}`;
  const numCtx = options.numCtx ?? 16384;
  const timeoutMs = options.timeoutMs ?? 600_000;
  const doFetch = options.fetch ?? fetch;

  async function chat(body: Record<string, unknown>): Promise<ChatResponse> {
    let res: Response;
    try {
      res = await doFetch(`${base}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ stream: false, keep_alive: options.keepAlive ?? '30m', ...body }),
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (error) {
      throw new Error(`cannot reach Ollama at ${base} (is \`ollama serve\` running?): ${error instanceof Error ? error.message : error}`);
    }
    const json = (await res.json().catch(() => ({}))) as ChatResponse;
    if (!res.ok || json.error) {
      const hint = /not found/i.test(json.error ?? '') ? ` Run \`ollama pull ${body.model}\`.` : '';
      throw new Error(`Ollama error ${res.status}: ${json.error ?? 'unknown'}.${hint}`);
    }
    return json;
  }

  const usage = (r: ChatResponse) => ({ inputTokens: r.prompt_eval_count ?? 0, outputTokens: r.eval_count ?? 0, costUsd: 0 });

  return {
    name: 'ollama',

    async extract({ subject, kinds, events }) {
      const response = await chat({
        model: extractModel,
        messages: [
          { role: 'system', content: extractionSystemPrompt(kinds) },
          { role: 'user', content: extractionUserPrompt(subject, events) }
        ],
        format: factsSchema(kinds),
        options: { temperature: options.temperature?.extract ?? 0, num_ctx: numCtx }
      });
      if (response.done_reason === 'length') {
        throw new Error(`extraction ran out of context for ${subject.type} ${subject.id}; lower sync.batchSize or raise numCtx`);
      }
      return { facts: parseFacts(response.message?.content ?? '', kinds), usage: usage(response) };
    },

    async answer({ question, facts, subjects }) {
      const response = await chat({
        model: answerModel,
        messages: [
          { role: 'system', content: ANSWER_SYSTEM_PROMPT },
          { role: 'user', content: answerUserPrompt(question, facts, subjects) }
        ],
        options: { temperature: options.temperature?.answer ?? 0.3, num_ctx: numCtx }
      });
      return { answer: (response.message?.content ?? '').trim(), usage: usage(response) };
    }
  };
}

/** JSON schema Ollama constrains generation to: the same shape the Claude provider uses. */
export function factsSchema(kinds: readonly FactKind[]) {
  return {
    type: 'object',
    properties: {
      facts: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            eventId: { type: 'string' },
            kind: { type: 'string', enum: kinds.map((k) => k.name) },
            topic: { type: 'string' },
            statement: { type: 'string' },
            quote: { type: 'string' },
            resolved: { type: 'boolean' }
          },
          required: ['eventId', 'kind', 'topic', 'statement', 'quote', 'resolved']
        }
      }
    },
    required: ['facts']
  } as const;
}

/** Tolerant parse: a local model can still produce stray fields or a malformed item. Bad items are dropped, not fatal. */
export function parseFacts(content: string, kinds: readonly FactKind[]): ExtractedFact[] {
  let data: unknown;
  try {
    data = JSON.parse(content);
  } catch {
    return [];
  }
  const items = (data as { facts?: unknown }).facts;
  if (!Array.isArray(items)) return [];
  const names = new Set(kinds.map((k) => k.name));
  const out: ExtractedFact[] = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const f = item as Record<string, unknown>;
    if ([f.eventId, f.kind, f.topic, f.statement, f.quote].some((v) => typeof v !== 'string' || !v)) continue;
    if (!names.has(f.kind as string)) continue;
    out.push({
      eventId: f.eventId as string,
      kind: f.kind as string,
      topic: f.topic as string,
      statement: f.statement as string,
      quote: f.quote as string,
      ...(f.resolved === true ? { resolved: true } : {})
    });
  }
  return out;
}
