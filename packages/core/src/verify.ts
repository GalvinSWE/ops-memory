import type { ExtractedFact, SourceEvent } from './types.js';

export type RejectReason = 'unknown_event' | 'unknown_kind' | 'quote_not_found' | 'empty_statement';

export interface Verification {
  accepted: ExtractedFact[];
  rejected: { fact: ExtractedFact; reason: RejectReason }[];
}

/** Whitespace and quote-style differences are not evidence of invention; anything else is. */
export const normalizeForMatch = (text: string): string =>
  text
    .normalize('NFKC')
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

/**
 * Keeps a fact only if it points at an event that was actually sent, uses an enabled kind, and its
 * quote is really in that event's (redacted) text. No quote, no fact.
 */
export function verifyExtracted(
  facts: readonly ExtractedFact[],
  events: readonly SourceEvent[],
  enabledKinds: ReadonlySet<string>,
  minQuoteLength = 8
): Verification {
  const textById = new Map(events.map((e) => [e.id, normalizeForMatch(e.text)]));
  const accepted: ExtractedFact[] = [];
  const rejected: Verification['rejected'] = [];

  for (const fact of facts) {
    const text = textById.get(fact.eventId);
    const quote = normalizeForMatch(fact.quote ?? '');
    if (text === undefined) rejected.push({ fact, reason: 'unknown_event' });
    else if (!enabledKinds.has(fact.kind)) rejected.push({ fact, reason: 'unknown_kind' });
    else if (!fact.statement?.trim()) rejected.push({ fact, reason: 'empty_statement' });
    else if (quote.length < Math.min(minQuoteLength, text.length) || !text.includes(quote))
      rejected.push({ fact, reason: 'quote_not_found' });
    else accepted.push(fact);
  }
  return { accepted, rejected };
}
