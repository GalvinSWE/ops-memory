import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import type { ExtractedFact, LlmProvider, LlmUsage } from '@ops-memory/core';
import { ANSWER_SYSTEM_PROMPT, answerUserPrompt, extractionSystemPrompt, extractionUserPrompt } from './prompts.js';

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** USD per million tokens, [input, output]. First-party API list prices; override for your contract. */
export const DEFAULT_PRICES: Record<string, [number, number]> = {
  'claude-opus-5-5': [4, 20],
  'claude-sonnet-5-5': [2, 10],
  'claude-haiku-5-5': [0.1, 0.5]
};

export interface AnthropicProviderOptions {
  /** Model that reads records and extracts facts. Default `claude-opus-5-5`. */
  extractModel?: string;
  /** Model that answers questions from facts. Default `claude-opus-5-5`. */
  answerModel?: string;
  /** Default `medium` for both. */
  effort?: { extract?: Effort; answer?: Effort };
  /** Pass your own client (proxy, Bedrock, custom retries). Default: `new Anthropic()`, which reads ANTHROPIC_API_KEY or an `ant auth login` profile. */
  client?: Anthropic;
  /** Price table used for budget tracking. Unknown models count as the Opus price. */
  prices?: Record<string, [number, number]>;
}

export function anthropic(options: AnthropicProviderOptions = {}): LlmProvider {
  const extractModel = options.extractModel ?? 'claude-opus-5-5';
  const answerModel = options.answerModel ?? 'claude-opus-5-5';
  const effort = { extract: options.effort?.extract ?? 'medium', answer: options.effort?.answer ?? 'medium' };
  const prices = { ...DEFAULT_PRICES, ...options.prices };
  let client = options.client;
  const getClient = () => (client ??= new Anthropic());

  const usageOf = (model: string, usage: Anthropic.Usage): LlmUsage => {
    const [inPrice, outPrice] = prices[model] ?? DEFAULT_PRICES['claude-opus-5-5']!;
    const cacheWrite = usage.cache_creation_input_tokens ?? 0;
    const cacheRead = usage.cache_read_input_tokens ?? 0;
    const inputTokens = usage.input_tokens + cacheWrite + cacheRead;
    const costUsd =
      (usage.input_tokens * inPrice + cacheWrite * inPrice * 1.25 + cacheRead * inPrice * 0.1 + usage.output_tokens * outPrice) / 1e6;
    return { inputTokens, outputTokens: usage.output_tokens, costUsd };
  };

  return {
    name: 'anthropic',

    async extract({ subject, kinds, events }) {
      const kindNames = kinds.map((k) => k.name) as [string, ...string[]];
      const schema = z.object({
        facts: z.array(
          z.object({
            eventId: z.string(),
            kind: z.enum(kindNames),
            topic: z.string(),
            statement: z.string(),
            quote: z.string(),
            resolved: z.boolean()
          })
        )
      });

      const response = await getClient().messages.parse({
        model: extractModel,
        max_tokens: 16000,
        system: [{ type: 'text', text: extractionSystemPrompt(kinds), cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: extractionUserPrompt(subject, events) }],
        output_config: { format: zodOutputFormat(schema), effort: effort.extract }
      });

      const usage = usageOf(extractModel, response.usage);
      if (response.stop_reason === 'refusal') return { facts: [], usage };
      if (response.stop_reason === 'max_tokens') {
        throw new Error(`extraction hit max_tokens for ${subject.type} ${subject.id}; lower sync.batchSize`);
      }
      const parsed = response.parsed_output;
      if (!parsed) throw new Error(`extraction returned no parsable output for ${subject.type} ${subject.id}`);
      const facts: ExtractedFact[] = parsed.facts.map((f) => ({ ...f, resolved: f.resolved || undefined }));
      return { facts, usage };
    },

    async answer({ question, facts, subjects }) {
      const response = await getClient().messages.create({
        model: answerModel,
        max_tokens: 16000,
        system: ANSWER_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: answerUserPrompt(question, facts, subjects) }],
        output_config: { effort: effort.answer }
      });
      const usage = usageOf(answerModel, response.usage);
      if (response.stop_reason === 'refusal') {
        return { answer: 'The model declined to answer this question.', usage };
      }
      const answer = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim();
      return { answer, usage };
    }
  };
}

export { extractionSystemPrompt, extractionUserPrompt, ANSWER_SYSTEM_PROMPT, answerUserPrompt } from './prompts.js';
