/**
 * Text that reads well out loud. Screen text keeps citations and formatting; the spoken version
 * drops them, because "F 3 bracket" read by a speech engine helps nobody.
 */
export function toSpeech(text: string, maxChars = 600): string {
  const cleaned = text
    .replace(/\[F\d+\]/g, '') // citations
    .replace(/https?:\/\/\S+/g, '') // links
    .replace(/```[\s\S]*?```/g, '') // code blocks
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, '$1$2') // bold
    .replace(/(^|\s)[*_]([^*_]+)[*_](?=\s|$|[.,;:!?])/g, '$1$2') // italics
    .replace(/^\s{0,3}#{1,6}\s+/gm, '') // headings
    .replace(/^\s*[-*•]\s+/gm, '') // bullets
    .replace(/^\s*\d+\.\s+/gm, '') // numbered lists
    .replace(/\s+([.,;:!?])/g, '$1')
    .replace(/\n{2,}/g, '. ')
    .replace(/\s+/g, ' ')
    .replace(/\.\s*\./g, '.')
    .trim();
  if (cleaned.length <= maxChars) return cleaned;
  // Cut at the last sentence end that fits, so speech never stops mid-sentence.
  const head = cleaned.slice(0, maxChars);
  const end = Math.max(head.lastIndexOf('. '), head.lastIndexOf('? '), head.lastIndexOf('! '));
  return end > maxChars * 0.4 ? head.slice(0, end + 1) : `${head.replace(/\s+\S*$/, '')}…`;
}

/** Spoken-friendly date, e.g. "12 September". */
export const spokenDate = (iso: string): string =>
  new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', timeZone: 'UTC' });
