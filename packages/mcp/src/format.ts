import type { AskResult, Fact, SourceSubject, SubjectProfile } from '@ops-memory/core';

/** Plain-text renderings shared by the MCP tools and the CLI. */

export function formatFact(f: Fact, index?: number): string {
  const head = `${index != null ? `[F${index}] ` : ''}${f.kind}/${f.topic} · ${f.status} · confidence ${f.confidence} · seen ${f.firstSeen.slice(0, 10)} → ${f.lastSeen.slice(0, 10)}`;
  const quotes = f.evidence
    .slice(-3)
    .map((e) => `    "${e.quote}" (${e.source}, ${e.occurredAt.slice(0, 10)}${e.url ? `, ${e.url}` : ''})`)
    .join('\n');
  return `${head}\n  ${f.statement}${quotes ? `\n${quotes}` : ''}`;
}

export function formatFacts(facts: readonly Fact[]): string {
  return facts.length ? facts.map((f, i) => formatFact(f, i + 1)).join('\n\n') : 'No facts.';
}

export function formatProfile(p: SubjectProfile): string {
  const title = p.subject ? `${p.subject.type} "${p.subject.name}" (${p.subject.id})` : 'Unknown subject';
  const sections = [title];
  sections.push(`\nActive (${p.active.length})\n${formatFacts(p.active)}`);
  if (p.resolved.length) sections.push(`\nResolved (${p.resolved.length})\n${formatFacts(p.resolved)}`);
  return sections.join('\n');
}

export function formatSubjects(subjects: readonly SourceSubject[]): string {
  return subjects.length ? subjects.map((s) => `${s.type} "${s.name}" (${s.id})`).join('\n') : 'No matching subjects.';
}

export function formatAnswer(r: AskResult, withSources = true): string {
  if (!withSources || !r.facts.length) return r.answer;
  return `${r.answer}\n\nSources\n${formatFacts(r.facts)}`;
}
