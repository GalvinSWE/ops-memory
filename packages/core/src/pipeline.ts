import type { ResolvedConfig } from './config.js';
import { newId, sha1 } from './ids.js';
import { mergeFact } from './merge.js';
import type { Connector, ProcessedEvent } from './plugins.js';
import { redact } from './redact.js';
import type { Fact, RunRecord, SourceEvent } from './types.js';
import { verifyExtracted } from './verify.js';

export interface SyncOptions {
  /** Only this connector. */
  connector?: string;
  /** Override `sync.maxEventsPerRun` for this run. */
  maxEvents?: number;
  /** Read and count events, but call no model and write no facts. */
  dryRun?: boolean;
}

export type SyncResult = RunRecord & { dryRun: boolean };

const startOfUtcDay = (d = new Date()): Date => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

/** Splits one subject's events into requests that fit both the event count and the text budget. */
export function batchEvents(events: readonly SourceEvent[], batchSize: number, maxChars: number): SourceEvent[][] {
  const batches: SourceEvent[][] = [];
  let current: SourceEvent[] = [];
  let chars = 0;
  for (const event of events) {
    const size = event.text.length;
    if (current.length && (current.length >= batchSize || chars + size > maxChars)) {
      batches.push(current);
      current = [];
      chars = 0;
    }
    // A single event longer than the budget is cut, not dropped: its start is usually the substance.
    current.push(size > maxChars ? { ...event, text: event.text.slice(0, maxChars) } : event);
    chars += Math.min(size, maxChars);
  }
  if (current.length) batches.push(current);
  return batches;
}

/** Runs `worker` over `items` with at most `limit` in flight; stops starting new ones once `stop()` is true. */
async function runLimited<T>(items: readonly T[], limit: number, stop: () => boolean, worker: (item: T) => Promise<void>) {
  let next = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length && !stop()) {
      const item = items[next++] as T;
      await worker(item);
    }
  });
  await Promise.all(lanes);
}

export async function syncConnector(config: ResolvedConfig, connector: Connector, options: SyncOptions = {}): Promise<SyncResult> {
  const { store, llm, log } = config;
  const run: SyncResult = {
    id: newId(),
    connector: connector.name,
    startedAt: new Date().toISOString(),
    finishedAt: '',
    status: 'completed',
    eventsSeen: 0,
    eventsProcessed: 0,
    factsExtracted: 0,
    factsRejected: 0,
    factsWritten: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    dryRun: !!options.dryRun
  };

  try {
    // 1. Subjects: ids and names only, so questions can name a unit.
    const subjects = [];
    for await (const s of connector.listSubjects(config.subjects)) subjects.push(s);
    if (!options.dryRun) await store.upsertSubjects(subjects);
    const subjectByKey = new Map(subjects.map((s) => [`${s.type}:${s.id}`, s]));
    log(`[${connector.name}] ${subjects.length} subjects`);

    // 2. Events since the checkpoint, oldest first.
    const checkpoint = await store.getCheckpoint(connector.name);
    const since = checkpoint ?? new Date(Date.now() - config.sync.backfillDays * 86_400_000);
    const limit = options.maxEvents ?? config.sync.maxEventsPerRun;
    const raw: SourceEvent[] = [];
    for await (const e of connector.listEvents({ since, sources: config.sources, subjectTypes: config.subjects, limit })) {
      if (!e.text?.trim()) continue;
      raw.push(e);
      if (raw.length >= limit) break;
    }
    run.eventsSeen = raw.length;

    // 3. Skip what was already read and has not changed.
    const hashes = raw.map((e) => ({ id: e.id, hash: sha1(e.text) }));
    const fresh = new Set((await store.filterNewEvents(connector.name, hashes)).map((e) => e.id));
    const hashById = new Map(hashes.map((h) => [h.id, h.hash]));
    const events = raw
      .filter((e) => fresh.has(e.id))
      .map((e) => ({ ...e, text: redact(e.text, config.privacy) }));
    log(`[${connector.name}] ${raw.length} events since ${since.toISOString()}, ${events.length} new`);

    if (options.dryRun || !events.length) {
      if (!options.dryRun && raw.length) await store.setCheckpoint(connector.name, new Date(raw[raw.length - 1]!.occurredAt));
      run.eventsProcessed = 0;
      return finish(run);
    }

    // 4. One request per batch of one subject's events.
    const bySubject = new Map<string, SourceEvent[]>();
    for (const e of events) {
      const key = `${e.subject.type}:${e.subject.id}`;
      (bySubject.get(key) ?? bySubject.set(key, []).get(key)!).push(e);
    }
    const work = [...bySubject.entries()].flatMap(([key, list]) =>
      batchEvents(list, config.sync.batchSize, config.sync.maxBatchChars).map((batch) => ({ key, batch }))
    );

    const enabledKinds = new Set(config.factKinds.map((k) => k.name));
    const kindByName = new Map(config.factKinds.map((k) => [k.name, k]));
    const spentBefore = await store.costSince(startOfUtcDay());
    const overBudget = () => spentBefore + run.costUsd >= config.budget.maxUsdPerDay;
    if (overBudget()) {
      log(`[${connector.name}] daily budget of $${config.budget.maxUsdPerDay} already used; nothing extracted`);
      run.status = 'budget_exhausted';
      return finish(run);
    }

    // Facts for one subject are written by one lane at a time: batches of a subject run in order.
    const lanesBySubject = new Map<string, Promise<void>>();

    await runLimited(work, config.sync.concurrency, overBudget, async ({ key, batch }) => {
      const previous = lanesBySubject.get(key) ?? Promise.resolve();
      const current = previous.then(async () => {
        if (overBudget()) return;
        const subject = subjectByKey.get(key) ?? batch[0]!.subject;
        const result = await llm.extract({ subject, kinds: config.factKinds, events: batch });
        run.inputTokens += result.usage.inputTokens;
        run.outputTokens += result.usage.outputTokens;
        run.costUsd += result.usage.costUsd;
        run.factsExtracted += result.facts.length;

        const { accepted, rejected } = verifyExtracted(result.facts, batch, enabledKinds);
        run.factsRejected += rejected.length;
        for (const r of rejected) log(`[${connector.name}] rejected (${r.reason}): ${r.fact.kind}/${r.fact.topic}`);

        const eventById = new Map(batch.map((e) => [e.id, e]));
        const pending = new Map<string, Fact>();
        const now = new Date().toISOString();
        // Oldest evidence first, so "fixed" after "broken" ends resolved and not the other way round.
        accepted.sort((a, b) => eventById.get(a.eventId)!.occurredAt.localeCompare(eventById.get(b.eventId)!.occurredAt));
        for (const extracted of accepted) {
          const event = eventById.get(extracted.eventId)!;
          const draft = mergeFact({
            subject: event.subject,
            extracted,
            event,
            connector: connector.name,
            kind: kindByName.get(extracted.kind),
            existing: null,
            now
          });
          const existing = pending.get(draft.id) ?? (await store.getFact(draft.id));
          const merged = existing
            ? mergeFact({ subject: event.subject, extracted, event, connector: connector.name, kind: kindByName.get(extracted.kind), existing, now })
            : draft;
          pending.set(merged.id, merged);
        }
        await store.upsertFacts([...pending.values()]);
        run.factsWritten += pending.size;
        await store.markEventsProcessed(
          connector.name,
          batch.map((e) => ({ id: e.id, hash: hashById.get(e.id)! }) satisfies ProcessedEvent)
        );
        run.eventsProcessed += batch.length;
        log(`[${connector.name}] ${key}: ${batch.length} events → ${accepted.length} facts (${rejected.length} rejected)`);
      });
      lanesBySubject.set(key, current);
      await current;
    });

    if (overBudget() && run.eventsProcessed < events.length) {
      run.status = 'budget_exhausted';
      log(`[${connector.name}] stopped at the daily budget of $${config.budget.maxUsdPerDay}; the next run continues`);
    } else if (raw.length) {
      // Only move the checkpoint once everything up to it was read; skipped events are re-offered next run.
      await store.setCheckpoint(connector.name, new Date(raw[raw.length - 1]!.occurredAt));
    }
    return finish(run);
  } catch (error) {
    run.status = 'failed';
    run.error = error instanceof Error ? error.message : String(error);
    log(`[${connector.name}] failed: ${run.error}`);
    return finish(run);
  }

  async function finish(r: SyncResult): Promise<SyncResult> {
    r.finishedAt = new Date().toISOString();
    r.costUsd = Math.round(r.costUsd * 1e6) / 1e6;
    if (!r.dryRun) await store.recordRun(r);
    return r;
  }
}
