import { buildEntityUrl, CODECAST_BASE_URL, isConvexId, parseEntityUrl } from "../entities";

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

// ── Commit attribution by line overlap ──
//
// A commit nobody stamped (a person committed what an agent wrote, or the
// agent committed through a command the trailer rewrite missed) can still be
// traced to its session by content: the commit's added lines against the
// lines sessions wrote. Lines are normalized (trimmed, whitespace runs
// collapsed, blank lines dropped) and deduped, so a reformat between edit and
// commit keeps the match. The normalized text is the set key itself; hashing
// it would only matter if the sets were stored.
//
// The gate is the one HumanLayer measured on 784 real commits. Any overlap at
// all was 61% false positives: `}`, `return {` and common imports appear in
// every session's edits. A claim needs either 10 matched lines, or 3 matched
// lines that make up at least a quarter of the commit's lines.

export const OVERLAP_FLOOR_LINES = 10;
export const OVERLAP_MIN_LINES = 3;
export const OVERLAP_MIN_FRACTION = 0.25;

// Bump when the attribution chain changes: its order, the normalization, or
// the overlap gate. v2 added the overlap tier behind trailer, commit, hash
// and subject.
export const BLAME_ALGORITHM_VERSION = 2;

// Lines one commit sends for the overlap match.
export const MAX_OVERLAP_LINES_PER_COMMIT = 400;

/** One line as the overlap match compares it, or null for a blank line. */
export function normalizeOverlapLine(line: string): string | null {
  const collapsed = line.trim().replace(/\s+/g, " ");
  return collapsed.length > 0 ? collapsed : null;
}

/** The distinct normalized lines across texts (each split on newlines). */
export function overlapLineSet(texts: Iterable<string>): Set<string> {
  const set = new Set<string>();
  for (const text of texts) {
    for (const raw of text.split("\n")) {
      const line = normalizeOverlapLine(raw);
      if (line !== null) set.add(line);
    }
  }
  return set;
}

export function passesOverlapGate(matched: number, total: number): boolean {
  return matched >= OVERLAP_FLOOR_LINES || (matched >= OVERLAP_MIN_LINES && total > 0 && matched / total >= OVERLAP_MIN_FRACTION);
}

export interface OverlapClaim {
  id: string;
  matched: number;
  total: number;
}

/**
 * The candidate whose written lines overlap the commit's lines most, when the
 * overlap clears the gate. An exact tie resolves by id so the answer is stable
 * across runs.
 */
export function claimByOverlap(
  commitLines: Iterable<string>,
  candidates: Iterable<{ id: string; lines: ReadonlySet<string> }>,
): OverlapClaim | null {
  const commit = overlapLineSet(commitLines);
  let best: OverlapClaim | null = null;
  for (const candidate of candidates) {
    let matched = 0;
    for (const line of commit) if (candidate.lines.has(line)) matched++;
    if (!best || matched > best.matched || (matched === best.matched && candidate.id < best.id)) {
      best = { id: candidate.id, matched, total: commit.size };
    }
  }
  return best && passesOverlapGate(best.matched, best.total) ? best : null;
}

/**
 * Each recent commit's lines in a blamed file, normalized and deduped: the
 * lines git blame gives a commit are the lines it added that still stand. Old
 * commits are skipped for the same reason contentLinesToMatch skips them.
 */
export function overlapLinesBySha(
  lines: Iterable<{ sha: string; text: string; authorMs?: number }>,
  nowMs: number,
): Map<string, string[]> {
  const sets = new Map<string, Set<string>>();
  for (const line of lines) {
    if (!line.authorMs || nowMs - line.authorMs > CONTENT_MATCH_MAX_AGE_MS) continue;
    const text = normalizeOverlapLine(line.text);
    if (text === null) continue;
    let set = sets.get(line.sha);
    if (!set) sets.set(line.sha, (set = new Set()));
    if (set.size < MAX_OVERLAP_LINES_PER_COMMIT) set.add(text);
  }
  return new Map([...sets].map(([sha, set]) => [sha, [...set]]));
}

// ── The Codecast-Session trailer ──
//
// A commit an agent makes carries the session that made it as a git trailer:
//
//   Codecast-Session: https://codecast.sh/conversation/<conversation id>
//
// The link travels in the message, so it survives rebases, squash merges and
// any git host, and `git log` alone leads back to the conversation. It names
// the FULL conversation id: short ids are prefixes that collide, and the
// trailer is only worth having if it resolves to exactly one session.

export const SESSION_TRAILER_KEY = "Codecast-Session";

/** The trailer value for a conversation: its canonical session link. */
export function sessionTrailerValue(conversationId: string, base: string = CODECAST_BASE_URL): string {
  return buildEntityUrl("session", conversationId, base)!;
}

const TRAILER_LINE = new RegExp(`^${SESSION_TRAILER_KEY}\\s*:\\s*(\\S+)\\s*$`, "i");
// Any git trailer line (`Key: value`), and a trailer's folded continuation.
const ANY_TRAILER_LINE = /^[A-Za-z0-9][A-Za-z0-9-]*\s*:\s*\S/;
// What follows one commit's message inside a GitHub squash merge: the next
// commit's bullet, or the separator before the co-author trailers.
const SQUASH_BOUNDARY = /^(\* |-{3,}\s*$)/;

function isTrailerBlock(paragraph: string): boolean {
  const lines = paragraph.split("\n");
  return ANY_TRAILER_LINE.test(lines[0] ?? "") && lines.every((line) => ANY_TRAILER_LINE.test(line) || /^[ \t]+\S/.test(line));
}

/**
 * The conversation id a commit message's Codecast-Session trailer names, or
 * null. Trailers are read where git and GitHub put them: the message's last
 * paragraph, and, inside a GitHub squash merge, each squashed commit's own
 * trailer block (a paragraph of nothing but `Key: value` lines that ends one
 * `* commit` bullet, right before the next bullet or the `---------` line
 * GitHub puts above the co-author trailers). A trailer quoted anywhere else in
 * the body (a commit about this very feature) names nothing. When several
 * trailers are present (an amend by a second session, a squash of several
 * commits) the last one wins: it is the session that wrote the newest work.
 * Anything but a full conversation id is refused.
 */
export function extractSessionTrailer(message: string | null | undefined): string | null {
  return splitSessionTrailer(message).session;
}

/**
 * A commit message with the Codecast-Session trailer lines that
 * extractSessionTrailer reads taken out (a paragraph left empty goes with
 * them), and the session they name, for a reader that shows the session as a
 * link of its own instead of a raw URL. A message without one comes back as is.
 */
export function splitSessionTrailer(message: string | null | undefined): { message: string; session: string | null } {
  if (!message) return { message: message ?? "", session: null };
  const paragraphs = message.replace(/\r\n/g, "\n").trimEnd().split(/\n[ \t]*\n/);
  let found: string | null = null;
  const kept = paragraphs.map((paragraph, i) => {
    const last = i === paragraphs.length - 1;
    if (!last && !(isTrailerBlock(paragraph) && SQUASH_BOUNDARY.test(paragraphs[i + 1] ?? ""))) return paragraph;
    return paragraph.split("\n").filter((line) => {
      const value = TRAILER_LINE.exec(line.trim())?.[1];
      if (!value) return true;
      const fromUrl = parseEntityUrl(value);
      const id = fromUrl ? (fromUrl.type === "session" ? fromUrl.id : null) : value;
      if (!id || !isConvexId(id)) return true;
      found = id;
      return false;
    }).join("\n");
  });
  if (!found) return { message, session: null };
  return { message: kept.filter((p) => p.trim() !== "").join("\n\n"), session: found };
}
