/**
 * Test doubles for writing connectors, stores and kinds without a database or an API key.
 * `import { memoryConnector, scriptedLlm } from '@ops-memory/core/testing'`.
 */
import type { AnswerRequest, Connector, ExtractRequest, LlmProvider } from './plugins.js';
import type { ExtractedFact, SourceEvent, SourceSubject, SubjectType } from './types.js';

/** A connector over arrays. Honours `since`, `sources`, `subjectTypes` and `limit` like a real one must. */
export function memoryConnector(name: string, subjects: SourceSubject[], events: SourceEvent[]): Connector & {
  subjects: SourceSubject[];
  events: SourceEvent[];
} {
  return {
    name,
    subjects,
    events,
    async *listSubjects(types: SubjectType[]) {
      for (const s of subjects) if (types.includes(s.type)) yield s;
    },
    async *listEvents({ since, sources, subjectTypes, limit }) {
      const list = events
        .filter((e) => new Date(e.occurredAt) > since)
        .filter((e) => !sources.length || sources.includes(e.source))
        .filter((e) => subjectTypes.includes(e.subject.type))
        .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt))
        .slice(0, limit);
      for (const e of list) yield e;
    }
  };
}

export type ExtractRule = (event: SourceEvent) => Omit<ExtractedFact, 'eventId'>[];

/**
 * An LLM that answers from rules instead of a model: each rule maps an event to the facts a model
 * would have returned. Records every request for assertions.
 */
export function scriptedLlm(rule: ExtractRule, options: { costPerRequest?: number } = {}): LlmProvider & {
  extractRequests: ExtractRequest[];
  answerRequests: AnswerRequest[];
} {
  const extractRequests: ExtractRequest[] = [];
  const answerRequests: AnswerRequest[] = [];
  const cost = options.costPerRequest ?? 0.001;
  return {
    name: 'scripted',
    extractRequests,
    answerRequests,
    async extract(request) {
      extractRequests.push(request);
      const facts = request.events.flatMap((e) => rule(e).map((f) => ({ ...f, eventId: e.id })));
      return { facts, usage: { inputTokens: 100, outputTokens: 20, costUsd: cost } };
    },
    async answer(request) {
      answerRequests.push(request);
      const lines = request.facts.map((f) => `- ${f.statement} (${f.status})`);
      return { answer: lines.join('\n'), usage: { inputTokens: 50, outputTokens: 10, costUsd: cost } };
    }
  };
}

/** A quote that is literally in the event text: what a well-behaved model returns. */
export const quoteFrom = (event: SourceEvent, phrase: string): string => {
  const at = event.text.toLowerCase().indexOf(phrase.toLowerCase());
  if (at < 0) throw new Error(`phrase "${phrase}" not in event ${event.id}`);
  return event.text.slice(at, at + phrase.length);
};
