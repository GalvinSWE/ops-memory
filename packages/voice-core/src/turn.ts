import type { Fact, OpsMemory, SourceSubject, SubjectRef } from '@ops-memory/core';
import type { AnswerMode, VoiceAskRequest, VoiceAskResponse, VoiceSource } from './protocol.js';
import { spokenDate, toSpeech } from './speech.js';

export interface VoiceTurnOptions {
  /** Used when the request does not say. Default `auto`. */
  defaultMode?: AnswerMode;
  /** Facts read out in `facts` mode. Default 5. */
  maxSpokenFacts?: number;
  /** Longest spoken answer, in characters. Default 600 (about 40 seconds of speech). */
  maxSpokenChars?: number;
  /** Called when `auto` falls back to `facts`, with the reason. */
  onFallback?: (error: unknown) => void;
}

export const MAX_QUESTION_CHARS = 500;

/**
 * One voice turn: a transcribed question in, an answer for the screen and for the speaker out.
 * Speech-to-text happens before this (in the browser in phase 1) and text-to-speech after it.
 */
export async function answerTurn(memory: OpsMemory, request: VoiceAskRequest, options: VoiceTurnOptions = {}): Promise<VoiceAskResponse> {
  const question = request.question?.trim();
  if (!question) throw new VoiceInputError('question is empty');
  if (question.length > MAX_QUESTION_CHARS) throw new VoiceInputError(`question is longer than ${MAX_QUESTION_CHARS} characters`);

  const subject = request.unit ? await resolveUnit(memory, request.unit) : undefined;
  if (request.unit && !subject) throw new VoiceInputError(`no unit named "${request.unit}"`);

  const mode = request.mode ?? options.defaultMode ?? 'auto';
  const maxChars = options.maxSpokenChars ?? 600;

  if (mode !== 'facts') {
    try {
      const result = await memory.ask(question, { subject });
      if (!result.facts.length) {
        const text = await nothingFound(memory, question, result.subjects);
        return build(question, text, toSpeech(text, maxChars), 'facts', [], result.subjects, 0);
      }
      return build(question, result.answer, toSpeech(result.answer, maxChars), 'model', result.facts, result.subjects, result.usage?.costUsd ?? 0);
    } catch (error) {
      if (mode === 'model') throw error;
      options.onFallback?.(error);
    }
  }

  const { facts, subjects } = await memory.recall(question, { subject });
  const text = facts.length ? factsAnswer(facts, subjects, options.maxSpokenFacts ?? 5) : await nothingFound(memory, question, subjects);
  return build(question, text, toSpeech(text, maxChars), 'facts', facts, subjects, 0);
}

/**
 * An answer read straight from the facts, no model involved: active facts first, most certain
 * first, then what was fixed. Used when there is no model, or to keep a turn free.
 */
export function factsAnswer(facts: readonly Fact[], subjects: readonly SourceSubject[], maxFacts = 5): string {
  if (!facts.length) return 'No notes found.';
  const names = new Map(subjects.map((s) => [`${s.type}:${s.id}`, s.name]));
  const byUnit = new Map<string, Fact[]>();
  for (const f of facts) {
    const key = `${f.subject.type}:${f.subject.id}`;
    (byUnit.get(key) ?? byUnit.set(key, []).get(key)!).push(f);
  }
  const parts: string[] = [];
  for (const [key, list] of byUnit) {
    const name = names.get(key) ?? 'This unit';
    const active = list.filter((f) => f.status === 'active').sort((a, b) => b.confidence - a.confidence);
    const resolved = list.filter((f) => f.status === 'resolved').sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
    const lines = [`${name}: ${active.length} open ${active.length === 1 ? 'note' : 'notes'}.`];
    for (const f of active.slice(0, maxFacts)) lines.push(`${f.statement} Last mentioned ${spokenDate(f.lastSeen)}.`);
    if (active.length > maxFacts) lines.push(`And ${active.length - maxFacts} more on screen.`);
    if (resolved.length) lines.push(`Fixed: ${resolved.slice(0, 2).map((f) => f.statement).join(' ')}`);
    parts.push(lines.join(' '));
  }
  return parts.join('\n\n');
}

function build(
  question: string,
  answer: string,
  spoken: string,
  answeredBy: 'model' | 'facts',
  facts: readonly Fact[],
  subjects: readonly SourceSubject[],
  costUsd: number
): VoiceAskResponse {
  const names = new Map(subjects.map((s) => [`${s.type}:${s.id}`, s.name]));
  const sources: VoiceSource[] = facts.map((f, i) => {
    const latest = f.evidence[f.evidence.length - 1];
    return {
      ref: `F${i + 1}`,
      unit: names.get(`${f.subject.type}:${f.subject.id}`) ?? f.subject.id,
      kind: f.kind,
      topic: f.topic,
      status: f.status,
      statement: f.statement,
      confidence: f.confidence,
      quote: latest?.quote ?? '',
      date: latest?.occurredAt ?? f.lastSeen,
      ...(latest?.url ? { url: latest.url } : {})
    };
  });
  return {
    question,
    answer,
    spoken,
    answeredBy,
    sources,
    units: subjects.map((s) => ({ id: s.id, name: s.name })),
    costUsd
  };
}

/**
 * What to say when nothing answers: repeat what was heard (speech recognition may have misheard the
 * unit), and name a few units that do have notes so the person can try one.
 */
export async function nothingFound(memory: OpsMemory, question: string, subjects: readonly SourceSubject[]): Promise<string> {
  if (subjects.length) {
    return `I have no notes about ${subjects.map((s) => s.name).join(' or ')} yet.`;
  }
  const known: string[] = [];
  for (const f of await memory.facts({ status: 'active', limit: 200 })) {
    const s = await memory.config.store.getSubject(f.subject);
    if (s && !known.includes(s.name)) known.push(s.name);
    if (known.length >= 3) break;
  }
  const heard = `I heard "${question}" but did not recognise a unit name in it.`;
  return known.length ? `${heard} Units with notes include ${known.join(', ')}.` : `${heard} No unit has notes yet: run ops-memory sync first.`;
}

async function resolveUnit(memory: OpsMemory, nameOrId: string): Promise<SubjectRef | undefined> {
  const byId = await memory.config.store.getSubject({ type: 'unit', id: nameOrId });
  if (byId) return byId;
  const matches = (await memory.findSubjects(nameOrId)).filter((s) => s.type === 'unit');
  return matches.find((s) => s.name.toLowerCase() === nameOrId.toLowerCase()) ?? (matches.length === 1 ? matches[0] : undefined);
}

/** A problem with what the client sent, as opposed to a server failure. */
export class VoiceInputError extends Error {
  override name = 'VoiceInputError';
}
