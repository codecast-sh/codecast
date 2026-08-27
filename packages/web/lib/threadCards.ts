// The Threads page's card models and the rules that do not need React: which
// chip a card belongs to, how each source becomes a card, how a chip filters
// and counts, and how the ?type= param resolves. lib/threadKinds.tsx attaches
// the renderers to these kinds; this half stays free of components so the
// rules are testable without the React tree behind them.

import type { LucideIcon } from "lucide-react";
import { CircleHelp, Globe, Hash, ListChecks, MessageSquare, Terminal, Users } from "lucide-react";
import type { ThreadCardOpenEntry, ThreadInboxRow, ThreadKind } from "../store/threadTypes";
import type { ChatRailChannel } from "../store/chatSlice";
import type { InboxSession, SessionDecisionItem } from "../store/inboxStore";

export type ThreadCardKind = ThreadKind | "dm" | "session" | "question";

/** The single-select chips. `all` is the default view and carries no ?type=. */
export type ChipKey = "all" | "chat" | "dm" | "comment" | "task" | "page" | "question";

export const CHIPS: Array<{ key: ChipKey; label: string }> = [
  { key: "all", label: "All" },
  { key: "chat", label: "Chat" },
  { key: "dm", label: "DMs" },
  { key: "comment", label: "Comments" },
  { key: "task", label: "Tasks" },
  { key: "page", label: "Pages" },
  { key: "question", label: "Questions" },
];

/** Chips that exist only when the team has chat on. */
const CHAT_CHIPS: ReadonlySet<ChipKey> = new Set(["chat", "dm"]);

/** Chips whose cards the server mark-all-read sweep may clear. Chat is NOT
 *  here: a chat thread can live in a DM room and file under the DMs chip, so
 *  a kind-scoped server sweep would erase threads the reader never saw —
 *  those chips mark their visible cards one by one instead. */
export const SWEEPABLE_CHIPS: ReadonlySet<ChipKey> = new Set(["comment", "task", "page"]);

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
  /** Server: last_activity_at. dm: the counterpart's last message — the
   *  viewer's own sends never move it. session: updated_at. Drives the All
   *  view's rank, the shown age, and the open map's expiry. */
  activityAt: number;
  /** dm only: the rail's own stamp (sortAt, either direction). The DMs chip —
   *  a browsing surface — ranks by this; everything else reads activityAt. */
  browseAt?: number;
  /** Nothing awaits the viewer: the newest message is their own (or, for a
   *  DM, the counterpart has never spoken). A dm card stays listed under the
   *  DMs chip; every other browse-only card is absent from every view. */
  browseOnly?: boolean;
  /** Server: row.unread. dm: the rail count (0 when muted). session: 0 or 1. */
  unread: number;
  unreadCapped?: boolean;
  /** Open-in-place link. */
  href: string;
  /** Kind-specific source: row | rail channel | session row | decision row.
   *  Renderers narrow on kind. */
  source: ThreadInboxRow | ChatRailChannel | InboxSession | SessionDecisionItem;
  teamId?: string;
};

/* One tone per kind, and no tone is cyan: cyan is the page's unread accent
 * (border, badge, chip count, sidebar pill), so a kind tile in cyan would say
 * "new" on a thread that has nothing new. */
export type ThreadKindTone = "blue" | "violet" | "magenta" | "orange" | "green" | "yellow" | "red";

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
  page: {
    key: "page",
    label: "Pages",
    icon: Globe,
    tone: "yellow",
    chip: "page",
    countsTowardBadge: true,
    emptyCopy: "Comments on pages you published land here.",
  },
  question: {
    key: "question",
    label: "Questions",
    icon: CircleHelp,
    tone: "red",
    chip: "question",
    // Pending questions already badge the sidebar's Questions row; counting
    // them here too would say the same thing twice.
    countsTowardBadge: false,
    emptyCopy: "When an agent queues a decision for you, it lands here.",
  },
};

/** The default view's empty copy: the ways a thread reaches this page. */
export const ALL_EMPTY_COPY = "Chat replies, session comments, task comments and page comments land here when they have something new for you.";

/** The collapsed card's count line, one shape for every kind: "3 replies",
 *  "1 comment", or "No messages yet" when there are none. */
export function summaryCount(n: number, noun: string, plural = `${noun}s`): string {
  if (n <= 0) return `No ${plural} yet`;
  return `${n} ${n === 1 ? noun : plural}`;
}

// ── Row sources ─────────────────────────────────────────────────────────────

/** A thread the viewer answered: its newest reply is the viewer's own, typed
 *  by a person (an agent row carries the asker's id on some kinds, and an
 *  agent's answer is still news). Nothing awaits them, so the card retires
 *  until someone else replies. */
export function answeredByViewer(row: ThreadInboxRow, viewerId: string | undefined): boolean {
  const last = row.last_reply;
  if (!last || !viewerId) return false;
  return last.author_kind !== "agent" && String(last.user_id ?? "") === String(viewerId);
}

/** Server rows (chat, comment, task, page) as cards. `channelKindOf` answers a
 *  chat row's room kind so a thread in a DM files under DMs; `taskShortIdOf`
 *  gives the canonical /tasks/<short_id> link when the task row is cached;
 *  `viewerId` retires the threads the viewer answered (answeredByViewer). */
export function serverCards(
  rows: ThreadInboxRow[],
  channelKindOf: (channelId: string) => string | undefined,
  taskShortIdOf: (taskId: string) => string | undefined,
  pageSlugOf: (artifactId: string) => string | undefined = () => undefined,
  viewerId?: string,
): ThreadCardModel[] {
  const out: ThreadCardModel[] = [];
  for (const row of rows) {
    // A kind this bundle does not know (a newer server, or a rollback) is
    // skipped, never a crash: one unknown row must not take down the page.
    const meta = THREAD_KIND_META[row.kind] as ThreadKindMeta | undefined;
    if (!meta) continue;
    let chip: ThreadCardModel["chip"] = meta.chip;
    let href: string;
    if (row.kind === "chat") {
      const channelId = String(row.channel_id ?? "");
      if (channelKindOf(channelId) === "dm") chip = "dm";
      href = `/chat/${channelId}?m=${row.root_key}`;
    } else if (row.kind === "comment") {
      href = `/conversation/${row.conversation_id ?? row.root_key.split(":")[0]}`;
    } else if (row.kind === "page") {
      const slug = pageSlugOf(row.root_key);
      href = slug ? `/a/${slug}` : `/a`;
    } else {
      const taskId = String(row.task_id ?? row.root_key);
      href = `/tasks/${taskShortIdOf(taskId) ?? taskId}`;
    }
    out.push({
      id: row._id,
      kind: row.kind,
      chip,
      activityAt: row.last_activity_at,
      browseOnly: answeredByViewer(row, viewerId),
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
 *  shows no unread, the same rule the rail applies. Presence and rank in the
 *  All view key to the counterpart's last message: a room they have never
 *  spoken in is browse-only, and so is a room the viewer has ANSWERED — their
 *  own reply is the newest message, so nothing awaits them. Replying retires
 *  the card from All; the next inbound brings it back, ranked by that
 *  message. The DMs chip stays the full rail either way. */
export function dmCards(rail: ChatRailChannel[]): ThreadCardModel[] {
  const out: ThreadCardModel[] = [];
  for (const c of rail) {
    if (c.kind !== "dm") continue;
    const inboundAt = c.lastInboundAt;
    // sortAt is the room's newest message, either direction; newer than the
    // last inbound means the viewer spoke last.
    const answered = inboundAt !== undefined && c.sortAt > inboundAt;
    out.push({
      id: `dm:${c.id}`,
      kind: "dm",
      chip: "dm",
      activityAt: inboundAt ?? c.sortAt,
      browseAt: c.sortAt,
      browseOnly: inboundAt === undefined || answered,
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

/** Pending decisions (cast decide / AskUserQuestion) as cards. Answered and
 *  dismissed rows drop off — their history stays on the Questions page. The
 *  status IS the read mark, so a pending card always shows as unread. */
export function questionCards(decisions: SessionDecisionItem[]): ThreadCardModel[] {
  const out: ThreadCardModel[] = [];
  for (const d of decisions) {
    if (d.status !== "pending") continue;
    out.push({
      id: `question:${d._id}`,
      kind: "question",
      chip: "question",
      activityAt: d.created_at,
      unread: 1,
      href: `/questions`,
      source: d,
      teamId: undefined,
    });
  }
  return out;
}

// ── Views ───────────────────────────────────────────────────────────────────

/** Whether a chip lists a card. The DMs chip is the one browsing surface: it
 *  keeps browse-only rooms. Every other view drops a card nothing awaits on. */
function listedUnder(c: ThreadCardModel, chip: ChipKey): boolean {
  return chip === "dm" || !c.browseOnly;
}

/** The cards one chip shows. Sessions appear only under All, and only when
 *  the toggle is on; browse-only DM rooms appear only under their own chip;
 *  every other chip is exact. */
export function cardsForChip(cards: ThreadCardModel[], chip: ChipKey, includeSessions: boolean): ThreadCardModel[] {
  if (chip === "all") return cards.filter((c) => listedUnder(c, chip) && (includeSessions || c.chip !== "session"));
  return cards.filter((c) => c.chip === chip && listedUnder(c, chip));
}

/** The default view is an inbox: a card earns its place by carrying unread.
 *  `held` is the visit's memory — a card admitted once stays until the page
 *  is left, so a card marking itself read under the reader never vanishes
 *  mid-read. Sessions are exempt: the Sessions switch asks for them by name,
 *  and their unread has its own meaning (grown since last open). */
export function unreadOnlyCards(cards: ThreadCardModel[], held: Set<string>): ThreadCardModel[] {
  const out: ThreadCardModel[] = [];
  for (const c of cards) {
    if (c.unread > 0) held.add(c.id);
    if (c.unread > 0 || held.has(c.id) || c.chip === "session") out.push(c);
  }
  return out;
}

/** Newest activity first. One merge sort across every source. The DMs chip is
 *  the browsing exception: it ranks by the rail's own stamp (browseAt), so a
 *  room the viewer just wrote to floats there — and only there. */
export function sortCards(cards: ThreadCardModel[], chip: ChipKey = "all"): ThreadCardModel[] {
  const at = chip === "dm"
    ? (c: ThreadCardModel) => c.browseAt ?? c.activityAt
    : (c: ThreadCardModel) => c.activityAt;
  return [...cards].sort((a, b) => at(b) - at(a));
}

/** How many cards carry unread, per chip and for the default view. Sessions
 *  never count: `all` equals the sidebar badge. */
export function unreadByChip(cards: ThreadCardModel[]): Record<ChipKey, number> {
  const out: Record<ChipKey, number> = { all: 0, chat: 0, dm: 0, comment: 0, task: 0, page: 0, question: 0 };
  for (const c of cards) {
    const meta = THREAD_KIND_META[c.kind] as ThreadKindMeta | undefined;
    if (!meta) continue;
    // A chip's own count includes every unread card it lists; only
    // badge-counting kinds roll up into the default view's number (which is
    // what the sidebar shows).
    if (c.unread <= 0) continue;
    if (c.chip !== "session" && listedUnder(c, c.chip)) out[c.chip]++;
    // A browse-only card is not in the All view, so it must not tick the
    // default view's number either.
    if (meta.countsTowardBadge && !c.browseOnly) out.all++;
  }
  return out;
}

/** The unread boundary as it stands when a card is expanded. Frozen by the
 *  page so marking read cannot erase it mid-read. */
export function frozenReadAtOf(card: ThreadCardModel): number {
  if (card.kind === "dm") return (card.source as ChatRailChannel).lastReadAt ?? 0;
  if (card.kind === "session" || card.kind === "question") return 0;
  return (card.source as ThreadInboxRow).last_read_at ?? 0;
}

// ── Open by default ─────────────────────────────────────────────────────────

/** The default: every card renders expanded, composer and all, so the page
 *  reads and answers in place. The user's collapse is the only way down. */
export function defaultOpenEntry(card: ThreadCardModel): ThreadCardOpenEntry {
  return { expanded: true, by: "auto", at: card.activityAt, frozenReadAt: frozenReadAtOf(card) };
}

/** A collapsed entry expires when NEWER unread lands: the reader closed the
 *  card on what it held then, not on what arrived since. Reading nothing new
 *  (unread from the same activity) keeps the collapse. */
export function openEntryExpired(card: ThreadCardModel, entry: ThreadCardOpenEntry): boolean {
  return !entry.expanded && card.unread > 0 && card.activityAt > entry.at;
}

/** What a card's open state IS, given its stored entry. `firstSight` is true
 *  the first time this page visit renders the card: a fresh visit re-derives
 *  `auto` entries (so a card read last visit collapses again) but honors the
 *  user's own choices. Expanded entries are never re-derived mid-visit — a
 *  card marking itself read under the reader must not collapse under them. */
export function resolveOpenEntry(
  card: ThreadCardModel,
  entry: ThreadCardOpenEntry | undefined,
  firstSight: boolean,
): ThreadCardOpenEntry {
  if (!entry) return defaultOpenEntry(card);
  if (firstSight && entry.by === "auto") return defaultOpenEntry(card);
  if (openEntryExpired(card, entry)) return defaultOpenEntry(card);
  return entry;
}

/** The user's toggle. Collapsing stamps the card's current activity so only
 *  newer unread reopens it; expanding freezes the unread boundary now. */
export function toggledOpenEntry(card: ThreadCardModel, current: ThreadCardOpenEntry): ThreadCardOpenEntry {
  return current.expanded
    ? { expanded: false, by: "user", at: card.activityAt, frozenReadAt: current.frozenReadAt }
    : { expanded: true, by: "user", at: card.activityAt, frozenReadAt: frozenReadAtOf(card) };
}
