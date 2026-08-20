// The Threads page's card models and the rules that do not need React: which
// chip a card belongs to, how each source becomes a card, how a chip filters
// and counts, and how the ?type= param resolves. lib/threadKinds.tsx attaches
// the renderers to these kinds; this half stays free of components so the
// rules are testable without the React tree behind them.

import type { LucideIcon } from "lucide-react";
import { Hash, ListChecks, MessageSquare, Terminal, Users } from "lucide-react";
import type { ThreadInboxRow, ThreadKind } from "../store/threadTypes";
import type { ChatRailChannel } from "../store/chatSlice";
import type { InboxSession } from "../store/inboxStore";

export type ThreadCardKind = ThreadKind | "dm" | "session";

/** The single-select chips. `all` is the default view and carries no ?type=. */
export type ChipKey = "all" | "chat" | "dm" | "comment" | "task";

export const CHIPS: Array<{ key: ChipKey; label: string }> = [
  { key: "all", label: "All" },
  { key: "chat", label: "Chat" },
  { key: "dm", label: "DMs" },
  { key: "comment", label: "Comments" },
  { key: "task", label: "Tasks" },
];

/** Chips that exist only when the team has chat on. */
const CHAT_CHIPS: ReadonlySet<ChipKey> = new Set(["chat", "dm"]);

/** ?type= → chip. Unknown values, and chat chips on a team with chat off,
 *  fall back to the default view. */
export function chipFromSearch(type: string | null | undefined, chatOn: boolean): ChipKey {
  if (!type) return "all";
  const hit = CHIPS.find((c) => c.key === type);
  if (!hit || hit.key === "all") return "all";
  if (!chatOn && CHAT_CHIPS.has(hit.key)) return "all";
  return hit.key;
}

/** The chips to show: every chip, minus the chat ones when chat is off. */
export function visibleChips(chatOn: boolean): Array<{ key: ChipKey; label: string }> {
  return chatOn ? CHIPS : CHIPS.filter((c) => !CHAT_CHIPS.has(c.key));
}

/** One card model, whatever the source. */
export type ThreadCardModel = {
  /** Server kinds: row._id. dm: `dm:${channelId}`. session: `session:${sessionId}`. */
  id: string;
  kind: ThreadCardKind;
  /** Which chip lists the card. A chat thread in a DM room files under DMs so
   *  one conversation never splits across chips; the card keeps its chat kind. */
  chip: Exclude<ChipKey, "all"> | "session";
  /** Server: last_activity_at. dm: the rail's sortAt. session: updated_at. */
  activityAt: number;
  /** Server: row.unread. dm: the rail count (0 when muted). session: 0 or 1. */
  unread: number;
  unreadCapped?: boolean;
  /** Open-in-place link. */
  href: string;
  /** Kind-specific source: row | rail channel | session row. Renderers narrow on kind. */
  source: ThreadInboxRow | ChatRailChannel | InboxSession;
  teamId?: string;
};

/* One tone per kind, and no tone is cyan: cyan is the page's unread accent
 * (border, badge, chip count, sidebar pill), so a kind tile in cyan would say
 * "new" on a thread that has nothing new. */
export type ThreadKindTone = "blue" | "violet" | "magenta" | "orange" | "green";

/** The React-free half of a kind's spec. */
export type ThreadKindMeta = {
  key: ThreadCardKind;
  /** Chip label: "Chat" | "DMs" | "Comments" | "Tasks" | "Sessions". */
  label: string;
  icon: LucideIcon;
  tone: ThreadKindTone;
  /** Which chip a card of this kind belongs to by default. */
  chip: Exclude<ChipKey, "all"> | "session";
  /** chat, dm, comment, task: true. session: false — its number is the Inbox's. */
  countsTowardBadge: boolean;
  emptyCopy: string;
};

export const THREAD_KIND_META: Record<ThreadCardKind, ThreadKindMeta> = {
  chat: {
    key: "chat",
    label: "Chat",
    icon: Hash,
    tone: "blue",
    chip: "chat",
    countsTowardBadge: true,
    emptyCopy: "Reply to a message, or get a reply on yours, and the thread lands here.",
  },
  dm: {
    key: "dm",
    label: "DMs",
    icon: Users,
    tone: "violet",
    chip: "dm",
    countsTowardBadge: true,
    emptyCopy: "Start one with New message.",
  },
  comment: {
    key: "comment",
    label: "Comments",
    icon: MessageSquare,
    tone: "magenta",
    chip: "comment",
    countsTowardBadge: true,
    emptyCopy: "Comments on sessions you own or have replied in land here.",
  },
  task: {
    key: "task",
    label: "Tasks",
    icon: ListChecks,
    tone: "orange",
    chip: "task",
    countsTowardBadge: true,
    emptyCopy: "Comments on tasks you created or are assigned land here.",
  },
  session: {
    key: "session",
    label: "Sessions",
    icon: Terminal,
    tone: "green",
    chip: "session",
    countsTowardBadge: false,
    emptyCopy: "Start one from the CLI or the composer and it shows here.",
  },
};

/** The default view's empty copy: the three ways a thread reaches this page. */
export const ALL_EMPTY_COPY = "Chat replies, session comments and task comments all land here.";

/** The collapsed card's count line, one shape for every kind: "3 replies",
 *  "1 comment", or "No messages yet" when there are none. */
export function summaryCount(n: number, noun: string, plural = `${noun}s`): string {
  if (n <= 0) return `No ${plural} yet`;
  return `${n} ${n === 1 ? noun : plural}`;
}

// ── Row sources ─────────────────────────────────────────────────────────────

/** Server rows (chat, comment, task) as cards. `channelKindOf` answers a chat
 *  row's room kind so a thread in a DM files under DMs; `taskShortIdOf` gives
 *  the canonical /tasks/<short_id> link when the task row is cached. */
export function serverCards(
  rows: ThreadInboxRow[],
  channelKindOf: (channelId: string) => string | undefined,
  taskShortIdOf: (taskId: string) => string | undefined,
): ThreadCardModel[] {
  const out: ThreadCardModel[] = [];
  for (const row of rows) {
    let chip: ThreadCardModel["chip"] = THREAD_KIND_META[row.kind].chip;
    let href: string;
    if (row.kind === "chat") {
      const channelId = String(row.channel_id ?? "");
      if (channelKindOf(channelId) === "dm") chip = "dm";
      href = `/chat/${channelId}?m=${row.root_key}`;
    } else if (row.kind === "comment") {
      href = `/conversation/${row.conversation_id ?? row.root_key.split(":")[0]}`;
    } else {
      const taskId = String(row.task_id ?? row.root_key);
      href = `/tasks/${taskShortIdOf(taskId) ?? taskId}`;
    }
    out.push({
      id: row._id,
      kind: row.kind,
      chip,
      activityAt: row.last_activity_at,
      unread: row.unread ?? 0,
      unreadCapped: !!row.unread_capped,
      href,
      source: row,
      teamId: row.team_id,
    });
  }
  return out;
}

/** DM rooms from the synced rail. Multi-person DMs are `dm` too. A muted room
 *  shows no unread, the same rule the rail applies. */
export function dmCards(rail: ChatRailChannel[]): ThreadCardModel[] {
  const out: ThreadCardModel[] = [];
  for (const c of rail) {
    if (c.kind !== "dm") continue;
    out.push({
      id: `dm:${c.id}`,
      kind: "dm",
      chip: "dm",
      activityAt: c.sortAt,
      unread: c.muted ? 0 : (c.unreadCount ?? 0),
      unreadCapped: !!c.unreadCapped,
      href: `/chat/${c.id}`,
      source: c,
      teamId: c.teamId,
    });
  }
  return out;
}

/** A session is unread when it has been opened before and has grown since.
 *  A never-opened session shows no badge: its number is the Inbox's. */
export function sessionUnread(
  session: Pick<InboxSession, "message_count">,
  seenCount: number | undefined,
): number {
  return seenCount !== undefined && (session.message_count ?? 0) > seenCount ? 1 : 0;
}

/** Inbox sessions as cards. The caller hands in the Inbox's own membership
 *  (categorizeSessions over filterInboxScope), never the raw cache. */
export function sessionCards(
  sessions: InboxSession[],
  seenCounts: Record<string, number>,
): ThreadCardModel[] {
  return sessions.map((s) => ({
    id: `session:${s._id}`,
    kind: "session" as const,
    chip: "session" as const,
    activityAt: s.updated_at,
    unread: sessionUnread(s, seenCounts[s._id]),
    href: `/conversation/${s._id}`,
    source: s,
    teamId: (s as { team_id?: string | null }).team_id ?? undefined,
  }));
}

// ── Views ───────────────────────────────────────────────────────────────────

/** The cards one chip shows. Sessions appear only under All, and only when
 *  the toggle is on; every other chip is exact. */
export function cardsForChip(cards: ThreadCardModel[], chip: ChipKey, includeSessions: boolean): ThreadCardModel[] {
  if (chip === "all") return includeSessions ? cards : cards.filter((c) => c.chip !== "session");
  return cards.filter((c) => c.chip === chip);
}

/** Newest activity first. One merge sort across every source. */
export function sortCards(cards: ThreadCardModel[]): ThreadCardModel[] {
  return [...cards].sort((a, b) => b.activityAt - a.activityAt);
}

/** How many cards carry unread, per chip and for the default view. Sessions
 *  never count: `all` equals the sidebar badge. */
export function unreadByChip(cards: ThreadCardModel[]): Record<ChipKey, number> {
  const out: Record<ChipKey, number> = { all: 0, chat: 0, dm: 0, comment: 0, task: 0 };
  for (const c of cards) {
    if (c.unread <= 0 || !THREAD_KIND_META[c.kind].countsTowardBadge) continue;
    out.all++;
    if (c.chip !== "session") out[c.chip]++;
  }
  return out;
}

/** The unread boundary as it stands when a card is expanded. Frozen by the
 *  page so marking read cannot erase it mid-read. */
export function frozenReadAtOf(card: ThreadCardModel): number {
  if (card.kind === "dm") return (card.source as ChatRailChannel).lastReadAt ?? 0;
  if (card.kind === "session") return 0;
  return (card.source as ThreadInboxRow).last_read_at ?? 0;
}
