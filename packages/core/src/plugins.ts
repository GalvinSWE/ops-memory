import type {
  ExtractedFact,
  Fact,
  FactStatus,
  LlmUsage,
  RunRecord,
  SourceEvent,
  SourceSubject,
  SubjectRef,
  SubjectType
} from './types.js';

/**
 * Reads a source system. Read-only by contract: a connector never writes back.
 * Events must come back in `occurredAt` order, oldest first.
 */
export interface Connector {
  readonly name: string;
  listSubjects(types: SubjectType[]): AsyncIterable<SourceSubject>;
  listEvents(options: ListEventsOptions): AsyncIterable<SourceEvent>;
  close?(): Promise<void>;
}

export interface ListEventsOptions {
  /** Only events after this instant; null means from the beginning of the backfill window. */
  since: Date;
  /** Sources enabled in config, e.g. `['maintenance_ticket', 'review']`. */
  sources: string[];
  /** Subject types enabled in config. */
  subjectTypes: SubjectType[];
  /** Upper bound on events returned in one call. */
  limit: number;
}

/**
 * A kind of knowledge worth keeping. Adding one is how ops-memory learns something new to look
 * for; the description goes straight into the extraction prompt.
 */
export interface FactKind {
  readonly name: string;
  readonly description: string;
  /** Facts with the same key on the same subject merge. Defaults to `kind:topic`. */
  mergeKey?(fact: ExtractedFact): string;
}

export interface ExtractRequest {
  subject: SourceSubject | SubjectRef;
  kinds: readonly FactKind[];
  events: readonly SourceEvent[];
}

export interface ExtractResult {
  facts: ExtractedFact[];
  usage: LlmUsage;
}

export interface AnswerRequest {
  question: string;
  facts: readonly Fact[];
  subjects: readonly SourceSubject[];
}

export interface AnswerResult {
  answer: string;
  usage: LlmUsage;
}

export interface LlmProvider {
  readonly name: string;
  extract(request: ExtractRequest): Promise<ExtractResult>;
  answer(request: AnswerRequest): Promise<AnswerResult>;
}

export interface FactQuery {
  subject?: SubjectRef;
  kinds?: string[];
  /** Defaults to `active`. */
  status?: FactStatus | 'all';
  limit?: number;
}

export interface SearchQuery {
  text: string;
  subject?: SubjectRef;
  status?: FactStatus | 'all';
  limit?: number;
}

export interface ProcessedEvent {
  id: string;
  /** Hash of the event text: an edited record is read again. */
  hash: string;
}

/** Where ops-memory keeps its own data. Never the source system's database. */
export interface Store {
  readonly name: string;
  /** Creates or upgrades the store's tables. Safe to call on every start. */
  migrate(): Promise<void>;

  upsertSubjects(subjects: readonly SourceSubject[]): Promise<void>;
  getSubject(ref: SubjectRef): Promise<SourceSubject | null>;
  /** Subjects whose name or id matches, case-insensitively. */
  findSubjects(text: string, type?: SubjectType): Promise<SourceSubject[]>;

  getFact(id: string): Promise<Fact | null>;
  upsertFacts(facts: readonly Fact[]): Promise<void>;
  listFacts(query: FactQuery): Promise<Fact[]>;
  searchFacts(query: SearchQuery): Promise<Fact[]>;

  /** The events among `events` that are new or changed since they were last processed. */
  filterNewEvents(connector: string, events: readonly ProcessedEvent[]): Promise<ProcessedEvent[]>;
  markEventsProcessed(connector: string, events: readonly ProcessedEvent[]): Promise<void>;

  getCheckpoint(connector: string): Promise<Date | null>;
  setCheckpoint(connector: string, at: Date): Promise<void>;

  recordRun(run: RunRecord): Promise<void>;
  listRuns(limit: number): Promise<RunRecord[]>;
  /** Total estimated LLM spend of runs started at or after `since`. */
  costSince(since: Date): Promise<number>;

  stats(): Promise<StoreStats>;
  close(): Promise<void>;
}

export interface StoreStats {
  subjects: number;
  facts: number;
  activeFacts: number;
  evidence: number;
  processedEvents: number;
}
