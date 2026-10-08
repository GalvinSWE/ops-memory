import { defaultMergeKey } from './fact-kinds.js';
import { factId } from './ids.js';
import type { FactKind } from './plugins.js';
import type { Evidence, ExtractedFact, Fact, SourceEvent, SubjectRef } from './types.js';

/** 1 piece of evidence: 0.5, 2: 0.75, 3: 0.875 … Independent mentions make a fact more certain. */
export const confidenceFor = (evidenceCount: number): number =>
  Math.round((1 - 0.5 ** Math.max(1, evidenceCount)) * 1000) / 1000;

/** Evidence kept per fact; the oldest beyond this are dropped, the count still drives confidence. */
export const MAX_EVIDENCE_PER_FACT = 20;

export interface MergeInput {
  subject: SubjectRef;
  extracted: ExtractedFact;
  event: SourceEvent;
  connector: string;
  kind: FactKind | undefined;
  existing: Fact | null;
  now: string;
}

/**
 * Folds one verified extraction into the fact it belongs to.
 *
 * - New knowledge creates a fact.
 * - The same knowledge again adds evidence and raises confidence.
 * - A record saying the problem was fixed marks the fact `resolved`.
 * - A newer report after a resolution reopens it: the problem came back.
 */
export function mergeFact({ subject, extracted, event, connector, kind, existing, now }: MergeInput): Fact {
  const key = kind?.mergeKey?.(extracted) ?? defaultMergeKey(extracted.kind, extracted.topic);
  const evidence: Evidence = {
    eventId: event.id,
    connector,
    source: event.source,
    quote: extracted.quote.trim(),
    occurredAt: event.occurredAt,
    ...(event.url ? { url: event.url } : {})
  };
  const status = extracted.resolved ? 'resolved' : 'active';

  if (!existing) {
    return {
      id: factId(subject, key),
      subject,
      kind: extracted.kind,
      topic: extracted.topic.trim(),
      statement: extracted.statement.trim(),
      confidence: confidenceFor(1),
      status,
      evidence: [evidence],
      firstSeen: event.occurredAt,
      lastSeen: event.occurredAt,
      updatedAt: now
    };
  }

  const already = existing.evidence.some((e) => e.eventId === event.id && e.connector === connector);
  const allEvidence = already ? existing.evidence : [...existing.evidence, evidence];
  allEvidence.sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
  const isNewest = event.occurredAt >= existing.lastSeen;

  return {
    ...existing,
    // The newest record decides what is true now; an older record only adds evidence.
    statement: isNewest ? extracted.statement.trim() : existing.statement,
    status: isNewest ? status : existing.status,
    confidence: confidenceFor(allEvidence.length),
    evidence: allEvidence.slice(-MAX_EVIDENCE_PER_FACT),
    firstSeen: event.occurredAt < existing.firstSeen ? event.occurredAt : existing.firstSeen,
    lastSeen: isNewest ? event.occurredAt : existing.lastSeen,
    updatedAt: now
  };
}
