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

/**
 * Words that say nothing about a unit, dropped before keyword search so "hello there" or "what is
 * the …" does not match every fact containing "there" or "what". English and Vietnamese.
 */
const STOP_WORDS = new Set(
  (
    'a an the and or but if then so to of in on at by for from with about into over under is are was were be been ' +
    'being do does did have has had can could should would will shall may might must i me my we our you your he she ' +
    'it its they them their this that these those there here what which who whom whose when where why how any some ' +
    'all no not yes hello hi hey please thanks thank tell know show give get got need want like just also very more ' +
    'most much many anything something everything nothing unit units place property ' +
    'có không là của và hay hoặc thì mà với cho các những một này kia đó gì nào sao thế nào ở tại về trong ngoài ' +
    'bị được đã đang sẽ cần biết xin chào bạn tôi mình căn nhà phòng'
  ).split(/\s+/)
);

/** The words of a question worth searching for: no stop words, no very short words. */
export const searchWords = (question: string): string[] =>
  [...new Set(tokens(question))].filter((w) => w.length >= 3 && !STOP_WORDS.has(w));

/** Lowercase letter/digit runs: "228 Stone-Ridge (SC)" → ["228", "stone", "ridge", "sc"]. */
const tokens = (text: string): string[] => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

/**
 * The words of a question plus each run of two and three neighbouring words joined, so speech that
 * splits a name ("Stone Ridge") still meets a name written as one word ("Stoneridge").
 */
const questionTerms = (question: string): Set<string> => {
  const words = tokens(question);
  const terms = new Set(words);
  for (let i = 0; i < words.length; i++) {
    if (i + 1 < words.length) terms.add(words[i]! + words[i + 1]!);
    if (i + 2 < words.length) terms.add(words[i]! + words[i + 1]! + words[i + 2]!);
  }
  return terms;
};

/**
 * Ways a subject can be named: the whole name without bracketed notes, and each part of a name
 * written as "A / B". Each variant is the list of its tokens.
 */
const nameVariants = (name: string): string[][] => {
  const plain = name.replace(/\([^)]*\)/g, ' ');
  return [plain, ...plain.split('/')].map(tokens).filter((t) => t.length > 0);
};

/**
 * True when every token of some variant of the name is a term of the question. Numbers must match
 * exactly, so "Pine 2" is not found in a question about "Pine 21". Returns the size of the best
 * variant matched (more tokens = more specific), or 0.
 */
export const nameMatchScore = (name: string, terms: ReadonlySet<string>): number =>
  Math.max(0, ...nameVariants(name).filter((v) => v.every((t) => terms.has(t))).map((v) => v.length));

export function createMemory(input: OpsMemoryConfig): OpsMemory {
  const config = resolveConfig(input);
  const { store, llm } = config;
  let ready: Promise<void> | null = null;
  const init = () => (ready ??= store.migrate());

  async function subjectsInQuestion(question: string): Promise<SourceSubject[]> {
    const terms = questionTerms(question);
    const candidates = new Map<string, SourceSubject>();
    for (const term of terms) {
      if (term.length < 3) continue;
      for (const s of await store.findSubjects(term)) candidates.set(`${s.type}:${s.id}`, s);
    }
    const scored = [...candidates.values()]
      .map((s) => ({ s, score: nameMatchScore(s.name, terms) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score);
    // When one name contains another ("Pine 21" and "Pine"), keep the most specific matches only.
    const best = scored[0]?.score ?? 0;
    return scored.filter((x) => x.score === best).slice(0, 5).map((x) => x.s);
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
      if (!subjects.length) {
        const words = searchWords(question);
        if (words.length) facts.push(...(await store.searchFacts({ text: words.join(' '), status: 'all', limit: maxFacts })));
      }
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

