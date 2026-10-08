import type { Fact, FactKind, SourceEvent, SourceSubject, SubjectRef } from '@ops-memory/core';

/**
 * Kept stable across requests (no dates, no ids) so it can be cached; everything that varies goes
 * in the user turn.
 */
export function extractionSystemPrompt(kinds: readonly FactKind[]): string {
  const kindList = kinds.map((k) => `- ${k.name}: ${k.description}`).join('\n');
  return `You read operational records about one short-term rental property (a "unit") and pull out durable knowledge about the place: things that will still matter to the next person who works there or stays there.

Kinds of knowledge to look for:
${kindList}

Rules:
- Only record knowledge that the text states. Do not infer, generalise across units, or add advice.
- Every fact must quote the exact words it rests on. "quote" is copied character for character from that event's text, 8 to 200 characters long, and must not be paraphrased, translated, or stitched together from separate places.
- "topic" is a short lowercase label for the thing the fact is about (e.g. wifi, dishwasher, parking, hot_tub, front_door). Use the same topic for the same thing across events, so facts merge.
- "statement" is one plain sentence in English, written so it stays true out of context: name the thing and what is true about it.
- Set "resolved" to true only when the event says an earlier problem on that topic was fixed, replaced, or no longer happens.
- One-off events with no lasting lesson (a single late check-out, a routine clean that went fine) are not knowledge. Skip them.
- Facts are about the place and the work, never about a person: do not describe a guest's or a worker's character, behaviour, or performance.
- Text marked [REDACTED_*] was removed on purpose. Never guess what it was.
- If an event holds nothing worth keeping, return nothing for it. Returning no facts at all is a valid answer.`;
}

const describeSubject = (subject: SourceSubject | SubjectRef): string =>
  'name' in subject ? `${subject.type} "${subject.name}" (id ${subject.id})` : `${subject.type} ${subject.id}`;

export function extractionUserPrompt(subject: SourceSubject | SubjectRef, events: readonly SourceEvent[]): string {
  const body = events
    .map(
      (e) =>
        `<event id="${escapeAttr(e.id)}" source="${escapeAttr(e.source)}" date="${e.occurredAt.slice(0, 10)}">\n${e.text}\n</event>`
    )
    .join('\n\n');
  return `Records for ${describeSubject(subject)}, oldest first:\n\n${body}\n\nReturn the facts these records support.`;
}

export const ANSWER_SYSTEM_PROMPT = `You answer questions from operations staff of a short-term rental company, using only the facts provided. Each fact has an id like [F3], a status, a confidence, and dated quotes from the records it came from.

- Answer in the language of the question. Be brief and concrete; lead with the answer.
- Use only the facts given. If they do not answer the question, say so plainly and say what is missing.
- Cite the facts you use with their ids, e.g. [F2][F5].
- A "resolved" fact describes something that used to be true; say so when you mention it ("was fixed on …").
- Mention low confidence (below 0.6) when a conclusion rests on a single record.`;

export function answerUserPrompt(question: string, facts: readonly Fact[], subjects: readonly SourceSubject[]): string {
  const names = new Map(subjects.map((s) => [`${s.type}:${s.id}`, s.name]));
  const lines = facts.map((f, i) => {
    const who = names.get(`${f.subject.type}:${f.subject.id}`) ?? `${f.subject.type} ${f.subject.id}`;
    const quotes = f.evidence
      .slice(-3)
      .map((e) => `    - ${e.occurredAt.slice(0, 10)} ${e.source}: "${e.quote}"`)
      .join('\n');
    return `[F${i + 1}] ${who} · ${f.kind}/${f.topic} · ${f.status} · confidence ${f.confidence} · last seen ${f.lastSeen.slice(0, 10)}\n  ${f.statement}\n${quotes}`;
  });
  return `Facts:\n${lines.join('\n')}\n\nQuestion: ${question}`;
}

const escapeAttr = (s: string) => s.replace(/["<>&]/g, (c) => ({ '"': '&quot;', '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c]!);
