// Pure timeline maths for the chat surface: grouping, day separators, the unread
// rule, and unread counts.
//
// Deliberately pure and dependency free so both platforms share one
// implementation and one set of tests. That matters more than usual here:
// packages/mobile has no CI and its tsconfig excludes test files, so logic that
// lives inside a screen component is effectively untested on mobile. Logic that
// lives here is not.

export type TimelineMessage = {
  id: string;
  authorId: string;
  createdAt: number;
  /** An agent placeholder still waiting on its answer. Never grouped, because it
   *  is about to change height and grouping it makes the list jump. */
  pendingAgent?: boolean;
};

export type TimelineRow<M extends TimelineMessage> =
  | { kind: "day"; key: string; label: string; at: number }
  | { kind: "new"; key: string; at: number }
  | { kind: "message"; key: string; message: M; grouped: boolean };

/** How close together two messages by one author must be to render as one group.
 *  Slack uses five minutes; long enough to hold a train of thought together,
 *  short enough that returning to a channel starts a fresh header. */
export const GROUP_WINDOW_MS = 5 * 60 * 1000;

function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** "Today" / "Yesterday" / "Tuesday, 4 March". Weekday alone would be ambiguous
 *  past a week, and a bare date reads as colder than it needs to. */
export function dayLabel(ts: number, now: number): string {
  const day = startOfDay(ts);
  const today = startOfDay(now);
  if (day === today) return "Today";
  if (day === today - 86_400_000) return "Yesterday";
  const d = new Date(ts);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return d.toLocaleDateString(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

export type BuildTimelineOptions = {
  now: number;
  /** Everything at or before this instant has been read. The unread rule is
   *  drawn before the first message after it. */
  lastReadAt?: number;
  /** The viewer, so their own messages never trigger the unread rule — you have
   *  read what you just wrote. */
  viewerId?: string;
  /** Suppress day separators (the thread panel is short and dense enough that
   *  they add noise rather than orientation). */
  withoutDays?: boolean;
};

/**
 * Fold a sorted-ascending message list into render rows.
 *
 * Grouping rules, in the order they are applied — a message starts a new group
 * when any of these is true:
 *   - it is the first message of a day (the separator already broke the run)
 *   - the unread rule falls immediately before it (same reason)
 *   - a different author wrote it
 *   - more than GROUP_WINDOW_MS separates it from the previous one
 *   - either it or the message above is an agent placeholder mid-answer
 */
export function buildChatTimeline<M extends TimelineMessage>(
  messages: M[],
  opts: BuildTimelineOptions,
): TimelineRow<M>[] {
  const rows: TimelineRow<M>[] = [];
  if (messages.length === 0) return rows;

  const { now, lastReadAt, viewerId, withoutDays } = opts;

  let lastDay = 0;
  let newRuleDrawn = false;
  let prev: M | undefined;

  for (const m of messages) {
    let breaksGroup = false;

    if (!withoutDays) {
      const day = startOfDay(m.createdAt);
      if (day !== lastDay) {
        rows.push({ kind: "day", key: `day-${day}`, label: dayLabel(m.createdAt, now), at: day });
        lastDay = day;
        breaksGroup = true;
      }
    }

    // The unread rule is drawn once, before the first message the viewer has not
    // read. Their own messages cannot trigger it: sending is reading.
    if (
      !newRuleDrawn &&
      lastReadAt !== undefined &&
      m.createdAt > lastReadAt &&
      m.authorId !== viewerId
    ) {
      rows.push({ kind: "new", key: `new-${m.id}`, at: m.createdAt });
      newRuleDrawn = true;
      breaksGroup = true;
    }

    const grouped =
      !breaksGroup &&
      !!prev &&
      prev.authorId === m.authorId &&
      !prev.pendingAgent &&
      !m.pendingAgent &&
      m.createdAt - prev.createdAt <= GROUP_WINDOW_MS;

    rows.push({ kind: "message", key: m.id, message: m, grouped });
    prev = m;
  }

  return rows;
}

// ── Unread counts ───────────────────────────────────────────────────────────

export type UnreadTally = {
  /** Messages after lastReadAt that the viewer did not write. */
  unread: number;
  /** How many of those mention the viewer. This is the count allowed to shout. */
  mentions: number;
};

export function tallyUnread(
  messages: { createdAt: number; authorId: string; mentionsViewer?: boolean; deletedAt?: number }[],
  lastReadAt: number | undefined,
  viewerId: string,
): UnreadTally {
  let unread = 0;
  let mentions = 0;
  for (const m of messages) {
    if (m.deletedAt) continue;
    if (m.authorId === viewerId) continue;
    if (lastReadAt !== undefined && m.createdAt <= lastReadAt) continue;
    unread++;
    if (m.mentionsViewer) mentions++;
  }
  return { unread, mentions };
}

/**
 * Whether an arriving message should raise an in-app toast.
 *
 * The product rule, in one place so web and mobile cannot drift: toasts are
 * deliberately more eager than notifications, because a toast costs the reader
 * nothing once it has been glanced at. What it must never do is tell you about
 * something already on your screen, or about your own typing.
 */
export function shouldToastChatMessage(input: {
  authorId: string;
  viewerId: string;
  mentionsViewer?: boolean;
  channelId: string;
  /** The channel the viewer is looking at right now, if any. */
  activeChannelId?: string;
  /** The thread the viewer has open, if any. */
  activeThreadRootId?: string;
  /** The thread this message belongs to, if any. */
  threadRootId?: string;
  windowFocused: boolean;
  channelMuted?: boolean;
  /** "all" toasts every message, "mentions" only those naming you, "none" is
   *  silent. Mirrors chat_reads.notify_level. */
  notifyLevel?: "all" | "mentions" | "none";
  /** A global do-not-disturb, which outranks everything except nothing. */
  doNotDisturb?: boolean;
}): boolean {
  const {
    authorId,
    viewerId,
    mentionsViewer,
    channelId,
    activeChannelId,
    activeThreadRootId,
    threadRootId,
    windowFocused,
    channelMuted,
    notifyLevel = "all",
    doNotDisturb,
  } = input;

  // You have read what you just sent.
  if (authorId === viewerId) return false;
  if (doNotDisturb) return false;
  if (notifyLevel === "none") return false;
  // A muted channel still surfaces a direct mention — muting a room is not the
  // same as asking not to be spoken to.
  if ((channelMuted || notifyLevel === "mentions") && !mentionsViewer) return false;

  // Already on screen: same channel, same thread context, window focused.
  if (windowFocused && channelId === activeChannelId) {
    const sameContext = (threadRootId ?? undefined) === (activeThreadRootId ?? undefined);
    if (sameContext) return false;
  }

  return true;
}
