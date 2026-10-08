import { BUILT_IN_FACT_KINDS, DEFAULT_FACT_KINDS } from './fact-kinds.js';
import type { Connector, FactKind, LlmProvider, Store } from './plugins.js';
import { DEFAULT_REDACTION, type RedactionOptions } from './redact.js';
import type { SubjectType } from './types.js';

export interface OpsMemoryConfig {
  /** Where knowledge is read from. Read-only. */
  connectors: Connector[];
  /** Where ops-memory keeps its own facts. */
  store: Store;
  /** Extracts facts and answers questions. */
  llm: LlmProvider;
  /** Subject types to build memory for. Start with `['unit']`; people need an explicit decision. */
  subjects?: SubjectType[];
  /** Built-in kind names, or your own `FactKind` objects. */
  factKinds?: (string | FactKind)[];
  /** Source names to read, as the connectors define them. Empty or omitted: every source a connector offers. */
  sources?: string[];
  sync?: {
    /** On the first run, how far back to read. Default 180. */
    backfillDays?: number;
    /** Events of one subject sent to the model in one request. Default 15. */
    batchSize?: number;
    /** Cap on characters of event text in one request. Default 24000. */
    maxBatchChars?: number;
    /** Events read per run, per connector. Default 500; the next run continues from the checkpoint. */
    maxEventsPerRun?: number;
    /** Requests to the model in flight at once. Default 4. */
    concurrency?: number;
  };
  budget?: {
    /** Stop extracting once today's (UTC) estimated spend reaches this. Default 5. */
    maxUsdPerDay?: number;
  };
  privacy?: RedactionOptions;
  /** Optional sink for progress lines. Defaults to silent. */
  log?: (line: string) => void;
}

export interface ResolvedConfig {
  connectors: Connector[];
  store: Store;
  llm: LlmProvider;
  subjects: SubjectType[];
  factKinds: FactKind[];
  sources: string[];
  sync: Required<NonNullable<OpsMemoryConfig['sync']>>;
  budget: Required<NonNullable<OpsMemoryConfig['budget']>>;
  privacy: RedactionOptions;
  log: (line: string) => void;
}

/** Identity function that gives a config file its types. */
export const defineConfig = (config: OpsMemoryConfig): OpsMemoryConfig => config;

export function resolveConfig(config: OpsMemoryConfig): ResolvedConfig {
  if (!config.connectors?.length) throw new Error('ops-memory: config.connectors needs at least one connector');
  if (!config.store) throw new Error('ops-memory: config.store is required');
  if (!config.llm) throw new Error('ops-memory: config.llm is required');

  const names = new Set<string>();
  for (const c of config.connectors) {
    if (names.has(c.name)) throw new Error(`ops-memory: two connectors are named "${c.name}"`);
    names.add(c.name);
  }

  const factKinds = (config.factKinds ?? DEFAULT_FACT_KINDS).map((k) => {
    if (typeof k !== 'string') return k;
    const kind = BUILT_IN_FACT_KINDS[k];
    if (!kind) {
      const known = Object.keys(BUILT_IN_FACT_KINDS).join(', ');
      throw new Error(`ops-memory: unknown fact kind "${k}". Built-in kinds: ${known}`);
    }
    return kind;
  });
  if (!factKinds.length) throw new Error('ops-memory: config.factKinds is empty');

  const sync = {
    backfillDays: config.sync?.backfillDays ?? 180,
    batchSize: config.sync?.batchSize ?? 15,
    maxBatchChars: config.sync?.maxBatchChars ?? 24_000,
    maxEventsPerRun: config.sync?.maxEventsPerRun ?? 500,
    concurrency: config.sync?.concurrency ?? 4
  };
  for (const [key, value] of Object.entries(sync)) {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`ops-memory: sync.${key} must be a positive number`);
  }

  return {
    connectors: config.connectors,
    store: config.store,
    llm: config.llm,
    subjects: config.subjects?.length ? config.subjects : ['unit'],
    factKinds,
    sources: config.sources ?? [],
    sync,
    budget: { maxUsdPerDay: config.budget?.maxUsdPerDay ?? 5 },
    privacy: config.privacy ?? DEFAULT_REDACTION,
    log: config.log ?? (() => {})
  };
}
