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
  /** A tombstone. Never grouped: "This message was deleted" folded under the
   *  header above reads as a continuation of that person's sentence rather than
   *  as its own event. */
  deleted?: boolean;
  /** A system row wearing message clothes (a huddle digest). Never grouped in
   *  either direction: it renders under its own header rather than its author's,
   *  and folding the next message under it would leave that message with no
   *  header at all. */
  standalone?: boolean;
};

export type TimelineRow<M extends TimelineMessage> =
  | { kind: "day"; key: string; label: string; at: number }
  | { kind: "new"; key: string; at: number }
  | { kind: "message"; key: string; message: M; grouped: boolean };

/** How close together two messages by one author must be to render as one group.
 *  Slack uses five minutes; long enough to hold a train of thought together,
 *  short enough that returning to a channel starts a fresh header. */
export const GROUP_WINDOW_MS = 5 * 60 * 1000;

export function startOfDay(ts: number): number {
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
 *   - either it or the message above is a standalone system row
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
      !prev.deleted &&
      !m.deleted &&
      !prev.standalone &&
      !m.standalone &&
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
  messages: {
    createdAt: number;
    authorId: string;
    mentionsViewer?: boolean;
    deletedAt?: number;
    /** Set when the message is a thread reply. */
    threadRootId?: string;
    /** A voice burst still being spoken (@codecast/shared/chat isLiveVoiceRow).
     *  It has not notified yet, so it is not a message to be behind on. */
    voiceLive?: boolean;
  }[],
  lastReadAt: number | undefined,
  viewerId: string,
): UnreadTally {
  let unread = 0;
  let mentions = 0;
  for (const m of messages) {
    if (m.deletedAt) continue;
    if (m.voiceLive) continue;
    if (m.authorId === viewerId) continue;
    if (lastReadAt !== undefined && m.createdAt <= lastReadAt) continue;
    // The server's rule, mirrored exactly: a thread reply does not tick the
    // channel's number (the channel view can never clear it), but a mention
    // counts wherever it lives — being named must never be invisible.
    if (m.threadRootId === undefined) unread++;
    if (m.mentionsViewer) mentions++;
  }
  return { unread, mentions };
}

/**
 * How loudly an arriving message may interrupt.
 *
 * Not a boolean, deliberately. A single yes/no forces one presentation on every
 * message, so the only way to stop a busy channel from strobing is to silence it
 * completely — which throws away the mention along with the chatter. A tier lets
 * the things that are actually about you stay loud while ordinary talk degrades
 * to a quiet card, and then to a badge.
 *
 *   "loud"   accent edge, sound, longer dwell. Someone is addressing you.
 *   "quiet"  plain card, no sound, short dwell. The room is talking.
 *   "silent" no toast at all. The unread badge is the whole signal.
 *
 * One implementation so web and mobile cannot drift apart.
 */
export type ChatToastTier = "loud" | "quiet" | "silent";

export type ToastDecisionInput = {
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
  /** The viewer has posted in this thread, so replies to it are addressed to
   *  them in every sense that matters. */
  viewerInThread?: boolean;
  /** The channel is a direct message: every line in it is addressed to the
   *  viewer by construction. */
  isDm?: boolean;
  /** An agent's answer to a question the viewer asked. Always loud: they are
   *  waiting for it. */
  answersViewer?: boolean;
  windowFocused: boolean;
  channelMuted?: boolean;
  /** Mirrors chat_reads.notify_level. */
  notifyLevel?: "all" | "mentions" | "none";
  /** Global do-not-disturb or an active snooze, which outranks everything. */
  doNotDisturb?: boolean;
  /** How many toasts this channel has already raised inside the recency window.
   *  The gate that stops three people typing from producing a toast every few
   *  seconds — after the cap the channel collapses to a badge until it settles. */
  recentToastsFromChannel?: number;
};

/** Quiet toasts allowed from one channel before it stops interrupting. Loud
 *  toasts are never rate limited: being named is not chatter. */
export const QUIET_TOAST_BURST_CAP = 3;

export function chatToastTier(input: ToastDecisionInput): ChatToastTier {
  const {
    authorId,
    viewerId,
    mentionsViewer,
    channelId,
    activeChannelId,
    activeThreadRootId,
    threadRootId,
    viewerInThread,
    isDm,
    answersViewer,
    windowFocused,
    channelMuted,
    notifyLevel = "all",
    doNotDisturb,
    recentToastsFromChannel = 0,
  } = input;

  // You have read what you just sent.
  if (authorId === viewerId) return "silent";
  if (doNotDisturb) return "silent";
  if (notifyLevel === "none") return "silent";

  // Already on screen: same channel, same thread context, window focused. This
  // outranks even a mention — telling someone about a line they are looking at
  // is the fastest way to teach them to ignore toasts.
  if (windowFocused && channelId === activeChannelId) {
    const sameContext = (threadRootId ?? undefined) === (activeThreadRootId ?? undefined);
    if (sameContext) return "silent";
  }

  // Addressed to you: named, answered, a reply on a thread you are part of —
  // or any line of a DM, which is addressed by construction.
  const addressed = !!mentionsViewer || !!answersViewer || (!!threadRootId && !!viewerInThread) || !!isDm;
  // A muted channel still surfaces these — muting a room is not the same as
  // asking not to be spoken to. EXCEPT a muted DM: there is no "mentions only"
  // reading of a room where everything mentions you, so its mute must actually
  // mute (the server's notifyLevelAllows draws the same line; notifyLevel
  // "none" already returned silent above).
  if (isDm && channelMuted) return "silent";
  if (addressed) return "loud";

  if (channelMuted || notifyLevel === "mentions") return "silent";
  // The room is busy. Let it be a badge until it settles.
  if (recentToastsFromChannel >= QUIET_TOAST_BURST_CAP) return "silent";
  return "quiet";
}

/** Convenience for callers that only need to know whether to render anything. */
export function shouldToastChatMessage(input: ToastDecisionInput): boolean {
  return chatToastTier(input) !== "silent";
}
