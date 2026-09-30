// The Threads page's card models and the rules that do not need React: which
// chip a card belongs to, how each source becomes a card, how a chip filters
// and counts, and how the ?type= param resolves. lib/threadKinds.tsx attaches
// the renderers to these kinds; this half stays free of components so the
// rules are testable without the React tree behind them.

import type { LucideIcon } from "lucide-react";
import { CircleHelp, GitCommitHorizontal, Globe, Hash, ListChecks, MessageSquare, Terminal, Users } from "lucide-react";
import { parseCodeThreadRootKey } from "@codecast/shared/comments";
import type { ThreadInboxRow, ThreadKind, ThreadLastReply } from "../store/threadTypes";
import type { ChatRailChannel } from "../store/chatSlice";
import type { InboxSession, SessionDecisionItem } from "../store/inboxStore";

export type ThreadCardKind = ThreadKind | "dm" | "session" | "question";

/** The single-select chips. `all` is the default view and carries no ?type=. */
export type ChipKey = "all" | "chat" | "dm" | "comment" | "code" | "task" | "page" | "question";

export const CHIPS: Array<{ key: ChipKey; label: string }> = [
  { key: "all", label: "All" },
  { key: "chat", label: "Chat" },
  { key: "dm", label: "DMs" },
  { key: "comment", label: "Comments" },
  { key: "code", label: "Code" },
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
export const SWEEPABLE_CHIPS: ReadonlySet<ChipKey> = new Set(["comment", "code", "task", "page"]);

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
  /** Server: row.unread. dm: the rail count (0 when muted). session: 1. */
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
  code: {
    key: "code",
    label: "Code",
    icon: GitCommitHorizontal,
    tone: "green",
    chip: "code",
    countsTowardBadge: true,
    emptyCopy: "Comments on commits and pull requests you wrote, replied in or were named in land here.",
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
export const ALL_EMPTY_COPY = "Chat replies, session comments, code comments, task comments and page comments land here when they have something new for you.";

/** The collapsed card's count line, one shape for every kind: "3 replies",
 *  "1 comment", or "No messages yet" when there are none. */
export function summaryCount(n: number, noun: string, plural = `${noun}s`): string {
  if (n <= 0) return `No ${plural} yet`;
  return `${n} ${n === 1 ? noun : plural}`;
}

// ── Row sources ─────────────────────────────────────────────────────────────

/** The page a code thread is read on: the pull request when the row names
 *  one and the store knows its number, else the commit, with the thread's
 *  file so the page lands on it. */
export function codeThreadHref(row: ThreadInboxRow, prNumber?: number): string {
  const parsed = parseCodeThreadRootKey(row.root_key);
  const repository = row.repository ?? parsed.repository;
  const ref = row.ref ?? parsed.ref;
  const file = row.file_path ?? parsed.filePath;
  const query = file ? `?file=${encodeURIComponent(file)}` : "";
  if (row.pull_request_id && prNumber) return `/pr/${repository}/${prNumber}${query}`;
  return `/commit/${repository}/${ref}${query}`;
}

/** A thread the viewer answered: its newest reply is the viewer's own, typed
 *  by a person (an agent row carries the asker's id on some kinds, and an
 *  agent's answer is still news). Nothing awaits them, so whatever unread
 *  count the row still carries is stale and the card shows none. */
export function answeredByViewer(row: ThreadInboxRow, viewerId: string | undefined): boolean {
  const last = row.last_reply;
  if (!last || !viewerId) return false;
  return last.author_kind !== "agent" && String(last.user_id ?? "") === String(viewerId);
}

/** Server rows (chat, comment, task, page, code) as cards. `channelKindOf`
 *  answers a chat row's room kind so a thread in a DM files under DMs;
 *  `taskShortIdOf` gives the canonical /tasks/<short_id> link when the task
 *  row is cached; `viewerId` zeroes the unread of threads the viewer answered. */
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
    } else if (row.kind === "code") {
      href = codeThreadHref(row);
    } else {
      const taskId = String(row.task_id ?? row.root_key);
      href = `/tasks/${taskShortIdOf(taskId) ?? taskId}`;
    }
    out.push({
      id: row._id,
      kind: row.kind,
      chip,
      activityAt: row.last_activity_at,
      unread: answeredByViewer(row, viewerId) ? 0 : row.unread ?? 0,
      unreadCapped: !!row.unread_capped,
      href,
      source: row,
      teamId: row.team_id,
    });
  }
  return out;
}

/** DM rooms from the synced rail. Multi-person DMs are `dm` too. A muted room
 *  shows no unread, the same rule the rail applies. Rank keys to the
 *  counterpart's last message, so the viewer's own reply never moves a room.
 *  A room with nothing inbound since the viewer last spoke has nothing
 *  awaiting them: any count it still carries is stale. */
export function dmCards(rail: ChatRailChannel[]): ThreadCardModel[] {
  const out: ThreadCardModel[] = [];
  for (const c of rail) {
    if (c.kind !== "dm") continue;
    const awaiting = c.lastInboundAt !== undefined && c.sortAt <= c.lastInboundAt;
    out.push({
      id: `dm:${c.id}`,
      kind: "dm",
      chip: "dm",
      activityAt: c.lastInboundAt ?? c.sortAt,
      unread: c.muted || !awaiting ? 0 : (c.unreadCount ?? 0),
      unreadCapped: !!c.unreadCapped,
      href: `/chat/${c.id}`,
      source: c,
      teamId: c.teamId,
    });
  }
  return out;
}

/** Sessions waiting on the viewer as cards. The caller hands in the Inbox's
 *  own needs-input bucket (placeInboxRows forced to "mine"), never the raw
 *  cache. Each one is waiting on the viewer, so each is new: it sits above the
 *  marker, and answering it leaves it there for the visit. */
export function sessionCards(sessions: InboxSession[]): ThreadCardModel[] {
  return sessions.map((s) => ({
    id: `session:${s._id}`,
    kind: "session" as const,
    chip: "session" as const,
    activityAt: s.updated_at,
    unread: 1,
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

/** The cards one chip shows. Sessions appear only under All, and only when
 *  the toggle is on; every other chip is exact. A thread whose newest word is
 *  the viewer's own is listed too: it is part of the reader's history, and it
 *  sits among the seen threads. */
export function cardsForChip(cards: ThreadCardModel[], chip: ChipKey, includeSessions: boolean): ThreadCardModel[] {
  if (chip === "all") return cards.filter((c) => includeSessions || c.chip !== "session");
  return cards.filter((c) => c.chip === chip);
}

// ── The visit ───────────────────────────────────────────────────────────────
//
// The page is one stable list for as long as the reader stays: threads with
// something new on top, then a marker, then the threads already seen. Where
// a thread stands is decided the first time the visit sees it, and nothing
// the reader does moves it: reading it, answering it, or marking it done
// leaves it exactly where it was. Only news moves a thread: an unread thread
// the visit had not seen yet lands at the top of the new section, and a seen
// thread that gets new activity from someone else moves up to join it.

export type ThreadsVisit = {
  /** Rank of each thread in the visit; lower sorts first. */
  rank: Map<string, number>;
  /** Threads in the new section. */
  fresh: Set<string>;
  /** Each thread's unread boundary as the visit first saw it, so the "new"
   *  divider inside a body survives the thread being marked read. */
  readAt: Map<string, number>;
  /** The newest model of every thread the visit has shown: a thread that
   *  leaves the source mid visit (done, answered, retired) keeps its place. */
  last: Map<string, ThreadCardModel>;
  /** The next rank at the bottom, and the next above everything. */
  bottom: number;
  top: number;
};

export function newVisit(): ThreadsVisit {
  return { rank: new Map(), fresh: new Set(), readAt: new Map(), last: new Map(), bottom: 0, top: 0 };
}

/** The unread boundary of a card as it stands now. */
export function frozenReadAtOf(card: ThreadCardModel): number {
  if (card.kind === "dm") return (card.source as ChatRailChannel).lastReadAt ?? 0;
  if (card.kind === "session" || card.kind === "question") return 0;
  return (card.source as ThreadInboxRow).last_read_at ?? 0;
}

/** Fold the current cards (newest activity first) into the visit and return
 *  its two sections in visit order. Mutates `visit`. */
export function arrangeVisit(
  visit: ThreadsVisit,
  cards: ThreadCardModel[],
): { fresh: ThreadCardModel[]; seen: ThreadCardModel[] } {
  const firstPass = visit.rank.size === 0;
  const arrivals: ThreadCardModel[] = [];
  for (const card of cards) {
    const known = visit.rank.has(card.id);
    visit.last.set(card.id, card);
    if (!known) {
      // After the first pass, an unread arrival is news and lands on top; a
      // read one (an older page loading in) joins the bottom.
      if (!firstPass && card.unread > 0) arrivals.push(card);
      else visit.rank.set(card.id, visit.bottom++);
      if (card.unread > 0) visit.fresh.add(card.id);
      visit.readAt.set(card.id, frozenReadAtOf(card));
    } else if (card.unread > 0 && !visit.fresh.has(card.id)) {
      // A seen thread with news from someone else: up into the new section.
      visit.fresh.add(card.id);
      visit.readAt.set(card.id, frozenReadAtOf(card));
      visit.rank.set(card.id, --visit.top);
    }
  }
  // Arrivals keep their newest-first order among themselves, above the rest.
  for (let i = arrivals.length - 1; i >= 0; i--) visit.rank.set(arrivals[i].id, --visit.top);
  const all = [...visit.last.values()].sort((a, b) => visit.rank.get(a.id)! - visit.rank.get(b.id)!);
  return {
    fresh: all.filter((c) => visit.fresh.has(c.id)),
    seen: all.filter((c) => !visit.fresh.has(c.id)),
  };
}

// ── What a body shows ───────────────────────────────────────────────────────

/** With nothing new, a body shows this many of its newest items; with news,
 *  the new ones and one earlier for context. The rest sit behind a "show
 *  earlier" button above, so no body ever scrolls inside the page. */
export const READER_TAIL = 3;

/** How many of a body's items (oldest first, `times` their timestamps) fold
 *  away behind "show earlier", and where the news starts (-1 for none).
 *  `newSince` undefined means the body is not a reader: show everything. */
export function readerFold(times: number[], newSince: number | undefined): { hidden: number; firstNew: number } {
  const firstNew = newSince === undefined || newSince <= 0 ? -1 : times.findIndex((t) => t > newSince);
  if (newSince === undefined) return { hidden: 0, firstNew };
  const hidden = firstNew >= 0 ? Math.max(0, firstNew - 1) : Math.max(0, times.length - READER_TAIL);
  return { hidden, firstNew };
}

/** Newest activity first. One merge sort across every source. */
export function sortCards(cards: ThreadCardModel[]): ThreadCardModel[] {
  return [...cards].sort((a, b) => b.activityAt - a.activityAt);
}

/** How many cards carry unread, per chip and for the default view. Sessions
 *  never count: `all` equals the sidebar badge. */
export function unreadByChip(cards: ThreadCardModel[]): Record<ChipKey, number> {
  const out: Record<ChipKey, number> = { all: 0, chat: 0, dm: 0, comment: 0, code: 0, task: 0, page: 0, question: 0 };
  for (const c of cards) {
    const meta = THREAD_KIND_META[c.kind] as ThreadKindMeta | undefined;
    if (!meta) continue;
    // A chip's own count includes every unread card it lists; only
    // badge-counting kinds roll up into the default view's number (which is
    // what the sidebar shows).
    if (c.unread <= 0) continue;
    if (c.chip !== "session") out[c.chip]++;
    if (meta.countsTowardBadge) out.all++;
  }
  return out;
}

/** "Done" archives the follow: only the thread_reads-backed kinds have a row
 *  to archive. DM, session and question cards are projections of other state
 *  with their own lifecycles. */
export function isDismissible(card: ThreadCardModel): boolean {
  return card.kind === "chat" || card.kind === "comment" || card.kind === "code" || card.kind === "task" || card.kind === "page";
}

// ── The cursor ──────────────────────────────────────────────────────────────

/** Where a walk of `delta` threads lands from the cursor at `index` (-1: not
 *  on the list, so the first step lands on the first thread). */
export function walkIndex(length: number, index: number, delta: number): number {
  if (length === 0) return -1;
  if (index < 0) return delta > 0 ? 0 : length - 1;
  return Math.min(length - 1, Math.max(0, index + delta));
}
