// Pure timeline maths for the chat surface: grouping, day separators, the unread
// rule, and unread counts.
//
// Deliberately pure and dependency free so both platforms share one
// implementation and one set of tests. That matters more than usual here:
// packages/mobile has no CI and its tsconfig excludes test files, so logic that
// lives inside a screen component is effectively untested on mobile. Logic that
// lives here is not.

import { isSettledLine } from "./agent";
import { mentionUserIds, type ChatMentionRef } from "./mentions";

export type TimelineMessage = {
  id: string;
  authorId: string;
  /** The identity a run of messages groups under. Defaults to `authorId`;
   *  differs when one stored author speaks for several people: every line
   *  mirrored in from Slack is written by the workspace's one bridge user, so
   *  grouping on the row's author folded Samvit's reply under Aivery's and
   *  drew it without a name or a face. See `authorGroupKey`. */
  groupKey?: string;
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

/** The grouping identity of a rendered author: the real Slack person (or app)
 *  behind a bridge-authored line, the session behind a line a session typed
 *  (stored under its human's user id, so the human's own line and the
 *  session's answer would otherwise fold into one), the user id otherwise.
 *  Web and mobile both feed this to `TimelineMessage.groupKey`, so the rule
 *  lives once. A Slack app has no user id on its lines; its name is the next
 *  best key. */
export function authorGroupKey(author: {
  id: string;
  name: string;
  slack?: { userId?: string } | null;
  session?: { id: string } | null;
}): string {
  if (author.slack) return `slack:${author.slack.userId ?? author.name}`;
  if (author.session) return `session:${author.session.id}`;
  return author.id;
}

/** A line's grouping identity: its author, and the session it was written
 *  beside (chat_messages.context_session_id). A line from another session
 *  starts a new group, so its header can name that session. */
export function lineGroupKey(
  author: Parameters<typeof authorGroupKey>[0],
  contextSessionId?: string | null,
): string {
  const key = authorGroupKey(author);
  return contextSessionId ? `${key}|${contextSessionId}` : key;
}

/** The same identity read off a stored row, for rollups computed before the
 *  row is a rendered author (the server's thread summary, the web's local
 *  reply rollup): the Slack person behind a bridge-authored line, the session
 *  behind a session-typed one, else the user id. Agrees with `authorGroupKey`
 *  by construction. */
export function threadFaceKey(row: {
  user_id: unknown;
  external?: { user?: string } | null;
  external_author?: { name: string } | null;
  origin?: string;
  origin_session_id?: string;
  author_kind?: string;
}): string {
  if (row.external_author) return `slack:${row.external?.user ?? row.external_author.name}`;
  if (row.origin === "agent" && row.origin_session_id && row.author_kind !== "agent") return `session:${row.origin_session_id}`;
  return String(row.user_id);
}

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
 *   - a different author wrote it (by `groupKey`, the rendered identity)
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
      (prev.groupKey ?? prev.authorId) === (m.groupKey ?? m.authorId) &&
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
  /** Channel-level lines after the read mark that the viewer did not write. */
  unread: number;
  /** How many lines mention the viewer, wherever they live. This is the count
   *  allowed to shout. */
  mentions: number;
};

/** A chat row as the server stores it and every client caches it: the fields
 *  the unread rule reads. */
export type UnreadRow = {
  user_id: string;
  created_at: number;
  deleted_at?: number;
  thread_root_id?: string;
  /** A reply also sent to the channel: it shows in the channel view. */
  broadcast?: boolean;
  author_kind?: string;
  agent_status?: string;
  mentions?: ReadonlyArray<ChatMentionRef>;
  mention_scope?: string;
  voice?: { status?: string } | null;
  external?: { synced_at?: number } | null;
};

/**
 * The unread rule, for the server's rail (convex chat.ts) and for every
 * client's own tally over the rows it holds. One implementation: when the two
 * counted differently, a badge the server raised opened onto nothing new, or a
 * badge the client raised for a row nobody can see never cleared.
 *
 * A line counts only when a person can see it and it is news: not a
 * tombstone, not a silent or still-thinking agent row, not a voice burst still
 * being spoken (it has not notified), not Slack history landing late (it was
 * read where it was written). The viewer's own lines never count, and their
 * newest one reads everything before it (posting is reading), unless an agent
 * posted it under their id.
 *
 * A thread reply does not tick the channel's number: the channel view never
 * shows it, so reading the channel could not clear it. A broadcast reply does
 * show there, so it counts. A mention counts wherever it lives, because being
 * named must never be invisible; in a DM every line is addressed to the viewer.
 */
export function tallyUnread(
  rows: ReadonlyArray<UnreadRow>,
  lastReadAt: number | undefined,
  viewerId: string,
  opts: { isDm?: boolean } = {},
): UnreadTally {
  let ownAt = 0;
  for (const m of rows) {
    if (m.user_id === viewerId && isPersonLine(m) && m.created_at > ownAt) ownAt = m.created_at;
  }
  let unread = 0;
  let mentions = 0;
  for (const m of rows) {
    if (m.user_id === viewerId) continue;
    if (lastReadAt !== undefined && m.created_at <= lastReadAt) continue;
    if (m.created_at < ownAt) continue;
    if (!isUnreadNews(m)) continue;
    if (m.thread_root_id === undefined || m.broadcast === true) unread++;
    if (opts.isDm || m.mention_scope === "here" || mentionUserIds(m.mentions).includes(viewerId)) mentions++;
  }
  return { unread, mentions };
}

const isPersonLine = (m: UnreadRow) => !m.author_kind || m.author_kind === "user";

/** A line a person can see that told them something new. */
function isUnreadNews(m: UnreadRow): boolean {
  return isSettledLine(m) && !isHistoryLine(m);
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
  /** The line is history landing late — a Slack import bringing over a
   *  channel's past. Nobody just said it, so nothing interrupts for it. */
  history?: boolean;
  /** How many toasts this channel has already raised inside the recency window.
   *  The gate that stops three people typing from producing a toast every few
   *  seconds — after the cap the channel collapses to a badge until it settles. */
  recentToastsFromChannel?: number;
};

/** Whether a mirrored-in line is history rather than something just said: it
 *  reached us long after its own time (a Slack import keeps Slack's stamp on
 *  each line and lands the whole past in minutes). A live mirrored line is
 *  seconds behind its stamp; anything a good while behind is the import.
 *  Web and mobile ask this the same way, so an old line toasts on neither. */
export const HISTORY_LAG_MS = 5 * 60 * 1000;
export function isHistoryLine(row: { created_at: number; external?: { synced_at?: number } | null }): boolean {
  const synced = row.external?.synced_at;
  return synced !== undefined && synced - row.created_at > HISTORY_LAG_MS;
}

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
    history,
    recentToastsFromChannel = 0,
  } = input;

  // You have read what you just sent.
  if (authorId === viewerId) return "silent";
  if (history) return "silent";
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
