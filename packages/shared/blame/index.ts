// The pure half of session blame, shared by the CLI (`cast blame`), the
// server resolver (convex/blame.ts) and the web viewer.
//
// A blamed line reaches its session two ways. Its commit sha names the session
// that ran the commit. Its text, found verbatim in an edit a session made,
// names the session that wrote it, which is the better answer when one
// session commits work that others typed. This module decides which lines are
// worth sending for the text match; the matching itself runs on the server.

// Lines shorter than this (trimmed) — `}`, `});`, `end` — appear in too many
// edits to attribute safely; leave them unresolved.
export const MIN_LINE_MATCH_LEN = 8;

// Only commits this recent get content-matched to an authoring session — the
// server matches against a window of the file's newest edit rows, so older
// lines can't match anyway and would just bloat the request.
export const CONTENT_MATCH_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

// An authoring edit precedes its commit by the agent's round trip; a claiming
// edit may be at most this much newer than the commit it is matched to.
export const COMMIT_DEADLINE_SLACK_MS = 10 * 60 * 1000;

export const MAX_CONTENT_LINES = 400;

export interface ContentLine {
  t: string;
  // Deadline (ms): newest edit timestamp allowed to claim the line. Committed
  // lines pass commit-time + slack so the authoring edit (which precedes its
  // commit) matches but later rewrites can't steal the line. Uncommitted
  // lines carry none.
  d?: number;
}

export interface BlamedLine {
  text: string;
  // Author time of the line's commit in ms, or undefined for an uncommitted line.
  authorMs?: number;
  uncommitted?: boolean;
}

/**
 * The lines worth asking the server to match by text: long enough to be
 * distinctive, from a commit recent enough to still have edit rows, deduped
 * by trimmed text with the most permissive deadline kept.
 */
export function contentLinesToMatch(lines: Iterable<BlamedLine>, nowMs: number): ContentLine[] {
  const byText = new Map<string, ContentLine>();
  for (const line of lines) {
    const trimmed = line.text.trim();
    if (trimmed.length < MIN_LINE_MATCH_LEN) continue;
    let deadline: number | undefined;
    if (!line.uncommitted) {
      if (!line.authorMs) continue;
      if (nowMs - line.authorMs > CONTENT_MATCH_MAX_AGE_MS) continue;
      deadline = line.authorMs + COMMIT_DEADLINE_SLACK_MS;
    }
    const existing = byText.get(trimmed);
    if (!existing || (existing.d !== undefined && (deadline === undefined || deadline > existing.d))) {
      byText.set(trimmed, { t: trimmed, d: deadline });
    }
    if (byText.size >= MAX_CONTENT_LINES) break;
  }
  return [...byText.values()];
}
