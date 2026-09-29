// The citations an ask answer carries: `msg 12`, `msg 40–42`, `msg 7-msg 8`,
// `msg -3` (negative numbers count back from the end of a session too long to
// read whole). One regex for both halves: the action lists the cited lines
// (citedLines in sessionAsk.ts), the web turns each span into a chip.
//
// A leaf with no imports, so the web bundle can load it.

const CITATION_RE = /\bmsgs? (-?\d+)(?:\s*[–-]\s*(?:msg )?(-?\d+))?/gi;

export interface CitationSpan {
  /** Where the citation sits in the answer, and its exact text. */
  start: number;
  end: number;
  text: string;
  from: number;
  /** Equal to `from` for a single message. */
  to: number;
}

export function citationSpans(answer: string): CitationSpan[] {
  const out: CitationSpan[] = [];
  for (const m of answer.matchAll(CITATION_RE)) {
    const from = Number(m[1]);
    out.push({ start: m.index!, end: m.index! + m[0].length, text: m[0], from, to: m[2] ? Number(m[2]) : from });
  }
  return out;
}

/** The lines one citation names: a range expands (capped at 51 lines), a range
 *  across an unread stretch (msg 900–-40) names its two ends only. */
export function spanLines(span: Pick<CitationSpan, "from" | "to">): number[] {
  const { from, to } = span;
  if (to < from) return [from, to];
  return Array.from({ length: Math.min(to, from + 50) - from + 1 }, (_, i) => from + i);
}
