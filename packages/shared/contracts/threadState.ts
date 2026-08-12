// The pinned thread state: the agent's own standing answer to "where does this
// thread stand right now?", written with `cast state` and rendered pinned above
// the composer and truncated on the inbox card.
//
// Everything here is shared by the three layers that must agree on it: the CLI
// (which normalizes the text before sending it), the Convex mutation (which
// stores it), and the web (which renders it and shows how stale it is). PURE
// isomorphic data — no Node or DOM APIs.

/** Longest state we store. Past this the text stops being a glance and becomes
 * reading, which is what the transcript is for. The CLI truncates rather than
 * rejecting, so a long write still lands. */
export const THREAD_STATE_MAX_CHARS = 1200;

/** Messages written since the state was set, past which the UI stops presenting
 * it as current. The first step dims it, the second calls it stale. Counted in
 * transcript messages — tool calls included — so a single busy agent turn is a
 * few tens of them. The thresholds sit well above that: a state should survive
 * the turn that wrote it and a couple after, and only look doubtful once the
 * thread has genuinely run past it. */
export const THREAD_STATE_AGING_MSGS = 60;
export const THREAD_STATE_STALE_MSGS = 200;

/** Time is the weaker signal — a thread parked overnight on a CI run has not
 * changed, so the clock only takes over when the thread is quiet for long. */
export const THREAD_STATE_AGING_MS = 12 * 60 * 60 * 1000;
export const THREAD_STATE_STALE_MS = 48 * 60 * 60 * 1000;

export type ThreadStateFreshness = "fresh" | "aging" | "stale";

export interface ThreadStateFields {
  thread_state?: string | null;
  thread_state_at?: number | null;
  thread_state_msg_count?: number | null;
}

/**
 * Trim, collapse runs of blank lines, and cap the length. Returns "" for text
 * that is empty once trimmed — callers treat that as a clear.
 */
export function normalizeThreadState(input: string): string {
  const lines = input.replace(/\r\n/g, "\n").split("\n").map((line) => line.trimEnd());
  // Drop the indentation the whole block shares — a heredoc written inside an
  // indented shell block carries it accidentally — while keeping the RELATIVE
  // indentation that makes nested bullets read as nested.
  const indents = lines
    .filter((line) => line.trim().length > 0)
    .map((line) => line.length - line.trimStart().length);
  const common = indents.length ? Math.min(...indents) : 0;
  const collapsed = lines
    .map((line) => line.slice(common))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (collapsed.length <= THREAD_STATE_MAX_CHARS) return collapsed;
  return collapsed.slice(0, THREAD_STATE_MAX_CHARS - 1).trimEnd() + "…";
}

/**
 * The one line that stands in for the whole state on an inbox card. Takes the
 * first non-empty line, drops a leading bullet, and drops a leading "Status:"
 * label — on a card the label is noise, since the line IS the status.
 */
export function threadStateHeadline(text: string): string {
  const line = text
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line) return "";
  return line
    .replace(/^[-*•]\s*/, "")
    .replace(/^(Status|State):\s*/i, "")
    .trim();
}

/**
 * How much the thread has moved since the state was written. `messagesSince` is
 * null when we can't tell (an older row stored no count), which the UI renders
 * as "no counter" rather than "0" — claiming freshness we can't prove is the
 * one failure this whole feature cannot afford.
 */
export function threadStateFreshness(
  fields: ThreadStateFields,
  liveMessageCount: number,
  now: number,
): { freshness: ThreadStateFreshness; messagesSince: number | null; ageMs: number | null } {
  const writtenAt = fields.thread_state_at ?? null;
  const writtenCount = fields.thread_state_msg_count ?? null;
  const ageMs = writtenAt == null ? null : Math.max(0, now - writtenAt);
  const messagesSince =
    writtenCount == null ? null : Math.max(0, liveMessageCount - writtenCount);

  let freshness: ThreadStateFreshness = "fresh";
  if (messagesSince != null && messagesSince >= THREAD_STATE_STALE_MSGS) freshness = "stale";
  else if (ageMs != null && ageMs >= THREAD_STATE_STALE_MS) freshness = "stale";
  else if (messagesSince != null && messagesSince >= THREAD_STATE_AGING_MSGS) freshness = "aging";
  else if (ageMs != null && ageMs >= THREAD_STATE_AGING_MS) freshness = "aging";

  return { freshness, messagesSince, ageMs };
}

/** True when the row carries a usable pinned state. */
export function hasThreadState(fields: ThreadStateFields | null | undefined): boolean {
  return !!fields?.thread_state && fields.thread_state.trim().length > 0;
}
