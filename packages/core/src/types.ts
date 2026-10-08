/**
 * What a fact is about. `unit`, `guest` and `staff` are the built-in kinds of subject; a connector
 * may introduce others (a building, an owner) without any change to the core.
 */
export type SubjectType = 'unit' | 'guest' | 'staff' | (string & {});

export interface SubjectRef {
  type: SubjectType;
  /** The id the source system uses, e.g. CleanOver's unit uuid. */
  id: string;
}

/** A subject as a connector reports it. Only ids and display names are kept, never full records. */
export interface SourceSubject extends SubjectRef {
  /** Display name people use for it, e.g. a unit alias. Used to find the subject from a question. */
  name: string;
  /** Connector that reported it. */
  connector: string;
  meta?: Record<string, unknown>;
}

/**
 * One thing that happened in the source system and may hold knowledge: a ticket, a comment, a
 * review, a guest message. `text` is what the model reads; it is redacted before it leaves the
 * process.
 */
export interface SourceEvent {
  /** Unique within its connector. */
  id: string;
  /** Kind of record, e.g. `maintenance_ticket`, `review`. Config chooses which sources run. */
  source: string;
  subject: SubjectRef;
  /** ISO 8601. */
  occurredAt: string;
  text: string;
  /** Link back to the record in the source system, when the connector can build one. */
  url?: string;
  meta?: Record<string, unknown>;
}

/** Where a fact came from: the exact words, and the record they were read in. */
export interface Evidence {
  eventId: string;
  connector: string;
  source: string;
  /** Verbatim (after redaction) span of the event's text. Checked by code, never trusted blindly. */
  quote: string;
  occurredAt: string;
  url?: string;
}

/** `active`: still true as far as we know. `resolved`: a later record said it was fixed or no longer holds. */
export type FactStatus = 'active' | 'resolved';

export interface Fact {
  /** Stable: derived from the subject and the merge key, so the same knowledge always lands on the same row. */
  id: string;
  subject: SubjectRef;
  kind: string;
  /** Short normalised label the model gives the fact, e.g. `wifi`, `dishwasher`, `parking`. */
  topic: string;
  /** One sentence, as the latest evidence states it. */
  statement: string;
  /** 0..1. Rises with each independent piece of evidence. */
  confidence: number;
  status: FactStatus;
  evidence: Evidence[];
  firstSeen: string;
  lastSeen: string;
  updatedAt: string;
}

/** What the model returns for one event. Verified against the event before it becomes a fact. */
export interface ExtractedFact {
  eventId: string;
  kind: string;
  topic: string;
  statement: string;
  quote: string;
  /** True when the event says an earlier problem on this topic was fixed or no longer applies. */
  resolved?: boolean;
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  /** Estimated from the provider's price table. */
  costUsd: number;
}

export interface RunRecord {
  id: string;
  connector: string;
  startedAt: string;
  finishedAt: string;
  status: 'completed' | 'budget_exhausted' | 'failed';
  eventsSeen: number;
  eventsProcessed: number;
  factsExtracted: number;
  factsRejected: number;
  factsWritten: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  error?: string;
}
