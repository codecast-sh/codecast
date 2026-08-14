// One reading of the pinned thread state for every surface that shows it: the
// panel above the composer and the inbox card. The wording of "how old is this,
// and how far has the thread moved since" is decided here once, so the card and
// the panel can never disagree about whether a state still counts as current.

import {
  threadStateFreshness,
  threadStateHeadline,
  threadStateCardLine,
  parseThreadStateStatus,
  THREAD_STATE_STATUS_LABEL,
  type ThreadStateFields,
  type ThreadStateFreshness,
  type ThreadStateStatus,
} from "@codecast/shared/contracts";

export interface ThreadStateView {
  /** Full text, as the agent wrote it. */
  text: string;
  /** First line — what the session is working on. */
  headline: string;
  /** What is HAPPENING: the Status:/Blocked: line when present, else the
   * headline. The inbox card's one slot. */
  cardLine: string;
  /** Declared tri-state, null on rows written before it existed. */
  status: ThreadStateStatus | null;
  freshness: ThreadStateFreshness;
  /** "4m" / "2h" / "3d", or null when the row predates the timestamp. */
  age: string | null;
  messagesSince: number | null;
  /** "4m ago · 12 messages since" — the panel's provenance line. */
  provenance: string;
}

/** Pin colour by freshness, shared by every one-line surface (inbox card,
 * compact subagent row, mobile row) so they can't drift apart. */
export const THREAD_STATE_PIN_CLASS: Record<ThreadStateFreshness, string> = {
  fresh: "text-sol-cyan/70",
  aging: "text-sol-yellow/70",
  stale: "text-sol-orange/70",
};

/** Everything a surface needs to mark a status: the chip on the panel, the dot
 * on the card, the tint on the row. One table so the three never disagree on
 * what color "blocked" is. Amber deliberately matches the needs-input bucket's
 * accent — both mean "ball in the human's court". */
export const THREAD_STATE_STATUS_META: Record<
  ThreadStateStatus,
  { label: string; dot: string; chip: string; bar: string; row: string }
> = {
  working: {
    label: THREAD_STATE_STATUS_LABEL.working,
    dot: "text-sol-cyan/80",
    chip: "bg-sol-cyan/10 text-sol-cyan/90 border-sol-cyan/30",
    bar: "border-l-sol-cyan/70",
    row: "",
  },
  blocked: {
    label: THREAD_STATE_STATUS_LABEL.blocked,
    dot: "text-sol-yellow/90",
    chip: "bg-sol-yellow/10 text-sol-yellow border-sol-yellow/30",
    bar: "border-l-sol-yellow/80",
    row: "border-l-2 border-l-sol-yellow/50 bg-sol-yellow/[0.04]",
  },
  done: {
    label: THREAD_STATE_STATUS_LABEL.done,
    dot: "text-sol-green/90",
    chip: "bg-sol-green/10 text-sol-green border-sol-green/30",
    bar: "border-l-sol-green/70",
    row: "border-l-2 border-l-sol-green/45 bg-sol-green/[0.03]",
  },
};

/** "4m" / "2h" / "3d" — the compact age used across the inbox chrome. */
export function compactAge(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/**
 * Returns null when the row carries no state, so callers can render the panel
 * or the card line with a single truthy check.
 */
export function threadStateView(
  fields: ThreadStateFields | null | undefined,
  liveMessageCount: number,
  now: number,
): ThreadStateView | null {
  const text = fields?.thread_state?.trim();
  if (!text) return null;

  const { freshness, messagesSince, ageMs } = threadStateFreshness(fields!, liveMessageCount, now);
  const age = ageMs == null ? null : compactAge(ageMs);

  const parts: string[] = [];
  if (age) parts.push(age === "just now" ? "just now" : `${age} ago`);
  if (messagesSince != null && messagesSince > 0) {
    parts.push(messagesSince === 1 ? "1 message since" : `${messagesSince} messages since`);
  }

  return {
    text,
    headline: threadStateHeadline(text),
    cardLine: threadStateCardLine(text),
    status: parseThreadStateStatus(fields?.thread_state_status),
    freshness,
    age,
    messagesSince,
    provenance: parts.join(" · "),
  };
}
