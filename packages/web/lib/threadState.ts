// One reading of the pinned thread state for every surface that shows it: the
// panel above the composer and the inbox card. The wording of "how old is this,
// and how far has the thread moved since" is decided here once, so the card and
// the panel can never disagree about whether a state still counts as current.

import {
  threadStateFreshness,
  threadStateHeadline,
  type ThreadStateFields,
  type ThreadStateFreshness,
} from "@codecast/shared/contracts";

export interface ThreadStateView {
  /** Full text, as the agent wrote it. */
  text: string;
  /** First line, for one-line surfaces. */
  headline: string;
  freshness: ThreadStateFreshness;
  /** "4m" / "2h" / "3d", or null when the row predates the timestamp. */
  age: string | null;
  messagesSince: number | null;
  /** "4m ago · 12 messages since" — the panel's provenance line. */
  provenance: string;
}

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
    freshness,
    age,
    messagesSince,
    provenance: parts.join(" · "),
  };
}
