// The agent dock's pure pieces: what a dot shows, what an entry is, and where
// the card goes after one is settled. Kept out of the component so the rules
// are testable without a window (dockModel.test.ts).
import type { InboxSession } from "../../store/inboxStore";
import type { QueueItem } from "../../lib/decisionQueue";

/** How long an answer, discard or kill waits before it commits. Esc inside
 *  it takes the gesture back; the agent never sees it. */
export const HOLD_MS = 2000;

export type DockDot = { id: string; state: "needs" | "working" | "done"; title: string };

/** ask: a poll, permission prompt or `cast decide` (the decision queue).
 *  waiting: parked on you with no structured ask. done: finished a turn.
 *  working: opened from its dot while it runs. */
export type DockEntry = {
  id: string;
  kind: "ask" | "waiting" | "done" | "working";
  session: InboxSession;
  item?: QueueItem;
};

/** The entry the card shows once `id` is settled: the one after it, or the
 *  one before when it was last, or nothing when it was the only one. Read
 *  BEFORE the commit, since the commit is what takes `id` out of the list. */
export function nextEntryId(entries: ReadonlyArray<{ id: string }>, id: string): string | null {
  const at = entries.findIndex((e) => e.id === id);
  if (at < 0) return entries[0]?.id ?? null;
  return entries[at + 1]?.id ?? entries[at - 1]?.id ?? null;
}
