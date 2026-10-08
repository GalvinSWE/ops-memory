import { resolveConfig, type OpsMemoryConfig, type ResolvedConfig } from './config.js';
import { syncConnector, type SyncOptions, type SyncResult } from './pipeline.js';
import type { FactQuery, StoreStats } from './plugins.js';
import type { Fact, LlmUsage, RunRecord, SourceSubject, SubjectRef } from './types.js';

export interface AskOptions {
  /** Answer about this subject only. Otherwise subjects named in the question are found by name. */
  subject?: SubjectRef;
  /** Facts given to the model. Default 40. */
  maxFacts?: number;
}

/**
 * An answer and what it rests on. The facts carry their evidence, so a UI (text, voice, a card in
 * CleanOver) can show or read out the sources without asking again.
 */
export interface AskResult {
  answer: string;
  facts: Fact[];
  subjects: SourceSubject[];
  usage: LlmUsage | null;
}

export interface RecallResult {
  facts: Fact[];
  subjects: SourceSubject[];
}

export interface SubjectProfile {
  subject: SourceSubject | null;
  active: Fact[];
  resolved: Fact[];
}

export interface StatusReport {
  stats: StoreStats;
  checkpoints: { connector: string; at: string | null }[];
  spentTodayUsd: number;
  budgetPerDayUsd: number;
  recentRuns: RunRecord[];
}

export interface OpsMemory {
  readonly config: ResolvedConfig;
  /** Prepares the store. Called by every other method; call it yourself to fail fast. */
  init(): Promise<void>;
  sync(options?: SyncOptions): Promise<SyncResult[]>;
  profile(subject: SubjectRef): Promise<SubjectProfile>;
  facts(query: FactQuery): Promise<Fact[]>;
  search(text: string, options?: { subject?: SubjectRef; limit?: number }): Promise<Fact[]>;
  findSubjects(text: string): Promise<SourceSubject[]>;
  /** The subjects named in a question and their facts, without calling a model. What `ask` answers from. */
  recall(question: string, options?: AskOptions): Promise<RecallResult>;
  ask(question: string, options?: AskOptions): Promise<AskResult>;
  status(): Promise<StatusReport>;
  close(): Promise<void>;
}

export const NO_FACTS_ANSWER =
  'ops-memory has no facts that answer this yet. Run `ops-memory sync`, or ask about a specific unit by name.';

/** Words in a question long enough to look up as a subject name, e.g. a unit alias. */
const candidateNames = (question: string): string[] => {
  const words = question.match(/[\p{L}\p{N}][\p{L}\p{N}#'’._-]*/gu) ?? [];
  const pairs = words.slice(0, -1).map((w, i) => `${w} ${words[i + 1]}`);
  return [...pairs, ...words].filter((w) => w.length >= 3);
};

export function createMemory(input: OpsMemoryConfig): OpsMemory {
  const config = resolveConfig(input);
  const { store, llm } = config;
  let ready: Promise<void> | null = null;
  const init = () => (ready ??= store.migrate());

  async function subjectsInQuestion(question: string): Promise<SourceSubject[]> {
    const found = new Map<string, SourceSubject>();
    for (const name of candidateNames(question)) {
      for (const s of await store.findSubjects(name)) {
        // A name has to appear as a whole in the question: "Pine 2" must not match "Pine 21".
        const pattern = new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(s.name)}($|[^\\p{L}\\p{N}])`, 'iu');
        if (pattern.test(question)) found.set(`${s.type}:${s.id}`, s);
      }
      if (found.size >= 5) break;
    }
    return [...found.values()];
  }

  const api: OpsMemory = {
    config,
    init,

    async sync(options = {}) {
      await init();
      const connectors = options.connector
        ? config.connectors.filter((c) => c.name === options.connector)
        : config.connectors;
      if (!connectors.length) throw new Error(`ops-memory: no connector named "${options.connector}"`);
      const results: SyncResult[] = [];
      for (const connector of connectors) results.push(await syncConnector(config, connector, options));
      return results;
    },

    async profile(subject) {
      await init();
      const [found, active, resolved] = await Promise.all([
        store.getSubject(subject),
        store.listFacts({ subject, status: 'active' }),
        store.listFacts({ subject, status: 'resolved' })
      ]);
      return { subject: found, active, resolved };
    },

    async facts(query) {
      await init();
      return store.listFacts(query);
    },

    async search(text, options = {}) {
      await init();
      return store.searchFacts({ text, subject: options.subject, limit: options.limit ?? 20, status: 'all' });
    },

    async findSubjects(text) {
      await init();
      return store.findSubjects(text);
    },

    async recall(question, options = {}) {
      await init();
      const maxFacts = options.maxFacts ?? 40;
      if (options.subject) {
        const s = await store.getSubject(options.subject);
        const facts = await store.listFacts({ subject: options.subject, status: 'all', limit: maxFacts });
        return { facts, subjects: s ? [s] : [] };
      }
      const subjects = await subjectsInQuestion(question);
      const facts: Fact[] = [];
      for (const s of subjects) {
        facts.push(...(await store.listFacts({ subject: s, status: 'all', limit: Math.ceil(maxFacts / subjects.length) })));
      }
      if (!subjects.length) facts.push(...(await store.searchFacts({ text: question, status: 'all', limit: maxFacts })));
      return { facts, subjects };
    },

    async ask(question, options = {}) {
      const { facts, subjects } = await api.recall(question, options);
      if (!facts.length) return { answer: NO_FACTS_ANSWER, facts: [], subjects, usage: null };
      const { answer, usage } = await llm.answer({ question, facts, subjects });
      return { answer, facts, subjects, usage };
    },

    async status() {
      await init();
      const today = new Date();
      const [stats, spentTodayUsd, recentRuns, checkpoints] = await Promise.all([
        store.stats(),
        store.costSince(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()))),
        store.listRuns(10),
        Promise.all(
          config.connectors.map(async (c) => ({
            connector: c.name,
            at: (await store.getCheckpoint(c.name))?.toISOString() ?? null
          }))
        )
      ]);
      return { stats, checkpoints, spentTodayUsd, budgetPerDayUsd: config.budget.maxUsdPerDay, recentRuns };
    },

    async close() {
      await Promise.all(config.connectors.map((c) => c.close?.()));
      await store.close();
    }
  };
  return api;
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
