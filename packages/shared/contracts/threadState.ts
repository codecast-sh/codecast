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

/** The declared state of the work, set by the agent alongside the text — the
 * agent's answer to "who acts next?": still moving, waiting on the human,
 * finished, or parked on a machine wake. Declared rather than parsed from the
 * prose — "Blocked: nothing" would defeat any keyword heuristic.
 *
 * "done" and "dormant" are SETTLE VERDICTS: when the turn that declared them
 * ends, the daemon settles the agent's status to the same word (instead of
 * plain idle), and the inbox files the session under Done / Dormant instead of
 * Needs Input. The verdict covers exactly that one settle. */
export type ThreadStateStatus = "working" | "blocked" | "done" | "dormant";

/** Human label for each status, shared so the panel chip, the inbox card and
 * the CLI print the same words. */
export const THREAD_STATE_STATUS_LABEL: Record<ThreadStateStatus, string> = {
  working: "In progress",
  blocked: "Needs input",
  done: "Complete",
  dormant: "Dormant",
};

/** Map loose spellings (CLI flag input, older rows) onto the enum. Returns null
 * for anything unrecognized so callers can reject or fall back explicitly. */
export function parseThreadStateStatus(input: string | null | undefined): ThreadStateStatus | null {
  const word = (input ?? "").trim().toLowerCase().replace(/[_\s]+/g, "-");
  if (["working", "in-progress", "progress", "wip", "active"].includes(word)) return "working";
  if (["blocked", "needs-input", "input", "waiting", "stuck"].includes(word)) return "blocked";
  if (["done", "complete", "completed", "finished", "delivered"].includes(word)) return "done";
  if (["dormant", "parked", "asleep", "sleeping", "waiting-on"].includes(word)) return "dormant";
  return null;
}

export interface ThreadStateFields {
  thread_state?: string | null;
  thread_state_at?: number | null;
  thread_state_msg_count?: number | null;
  thread_state_status?: string | null;
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
 * first non-empty line, drops a leading bullet, and drops a leading label
 * ("Status:", "Goal:") — on a card the label is noise, since the line IS the
 * status. The convention puts what the session is working on here unlabeled.
 */
export function threadStateHeadline(text: string): string {
  const line = text
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line) return "";
  return line
    .replace(/^[-*•]\s*/, "")
    .replace(/^(Status|State|Goal):\s*/i, "")
    .trim();
}

/**
 * The line the inbox card shows: what is HAPPENING, not what the thread is
 * about. Prefers the content of a `Status:` (or `Blocked:`) labeled line —
 * that is the part that changes as the work moves — and falls back to the
 * headline when the state has no such line. The full text stays in the
 * tooltip/panel, so this only decides which line earns the card's one slot.
 */
export function threadStateCardLine(text: string): string {
  for (const raw of text.split("\n")) {
    const line = raw.trim().replace(/^[-*•]\s*/, "");
    const m = line.match(/^(Status|Blocked):\s*(.+)$/i);
    if (m) return m[2].trim();
  }
  return threadStateHeadline(text);
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
