import type { ComponentType } from "react";
import { useInboxStore } from "../store/inboxStore";
import { selectChannelReadMarker, type ChatRailChannel } from "../store/chatSlice";
import type { ThreadInboxRow } from "../store/threadTypes";
import type { InboxSession } from "../store/inboxStore";
import {
  THREAD_KIND_META,
  type ThreadCardKind,
  type ThreadCardModel,
  type ThreadKindMeta,
} from "./threadCards";
import { ChatExpanded, ChatGlyph, ChatLabel, ChatRoot } from "../components/threads/kinds/ChatThreadKind";
import { DmExpanded, DmGlyph, DmLabel, DmRoot } from "../components/threads/kinds/DmKind";
import { CommentExpanded, CommentLabel, CommentRoot } from "../components/threads/kinds/CommentKind";
import { TaskExpanded, TaskLabel, TaskRoot } from "../components/threads/kinds/TaskKind";
import { SessionExpanded, SessionLabel, SessionRoot } from "../components/threads/kinds/SessionKind";

// The Threads page's kind registry: one spec per card kind, each saying how a
// card reads, expands, and marks itself read. The page and the generic
// ThreadCard know nothing kind-specific — they look the kind up here. The
// React-free half (chips, card models, derivation, filtering) lives in
// lib/threadCards.ts and is re-exported below.

export * from "./threadCards";

export type ThreadKindSpec = ThreadKindMeta & {
  /** The glyph inside the head's tinted kind tile, when the kind wants one of
   *  its own — only the chat and DM kinds do, because a room's lock or hash
   *  still carries meaning. Absent: the kind's own icon, which is what keeps
   *  the tiles scannable by kind. */
  Glyph?: ComponentType<{ card: ThreadCardModel }>;
  /** The card head's object label: room / session / task name. */
  Label: ComponentType<{ card: ThreadCardModel }>;
  /** The collapsed body (and the part of the body that stays when expanded). */
  Root: ComponentType<{ card: ThreadCardModel; expanded: boolean }>;
  /** In-place thread + composer. Mounts only for the one open card. */
  Expanded: ComponentType<{ card: ThreadCardModel; present: boolean; frozenReadAt: number }>;
  /** Mark one card read, the kind's own way. */
  markRead(card: ThreadCardModel): void;
};

function markServerRead(card: ThreadCardModel): void {
  const row = card.source as ThreadInboxRow;
  useInboxStore.getState().markThreadRead(row.kind, row.root_key);
}

function markDmRead(card: ThreadCardModel): void {
  const channel = card.source as ChatRailChannel;
  const state = useInboxStore.getState();
  const marker = selectChannelReadMarker(state as any, channel.id);
  state.markChannelRead(channel.id, marker?._id);
}

function markSessionSeen(card: ThreadCardModel): void {
  useInboxStore.getState().markSessionSeen((card.source as InboxSession)._id);
}

export const THREAD_KIND_SPECS: Record<ThreadCardKind, ThreadKindSpec> = {
  chat: { ...THREAD_KIND_META.chat, Glyph: ChatGlyph, Label: ChatLabel, Root: ChatRoot, Expanded: ChatExpanded, markRead: markServerRead },
  dm: { ...THREAD_KIND_META.dm, Glyph: DmGlyph, Label: DmLabel, Root: DmRoot, Expanded: DmExpanded, markRead: markDmRead },
  comment: { ...THREAD_KIND_META.comment, Label: CommentLabel, Root: CommentRoot, Expanded: CommentExpanded, markRead: markServerRead },
  task: { ...THREAD_KIND_META.task, Label: TaskLabel, Root: TaskRoot, Expanded: TaskExpanded, markRead: markServerRead },
  session: { ...THREAD_KIND_META.session, Label: SessionLabel, Root: SessionRoot, Expanded: SessionExpanded, markRead: markSessionSeen },
};

/** Mark every unread card of a view read. Server kinds go through the one
 *  scoped sweep (`markAllThreadsRead`, which also covers rows the page has not
 *  paged in); DM rooms and chat threads filed under DMs are marked one by one
 *  from the cards on screen; sessions never. */
export function markViewRead(
  cards: ThreadCardModel[],
  chip: "all" | "chat" | "dm" | "comment" | "task",
  teamId: string | undefined,
): void {
  const st = useInboxStore.getState();
  if (chip === "dm") {
    for (const c of cards) if (c.unread > 0 && (c.kind === "dm" || c.kind === "chat")) THREAD_KIND_SPECS[c.kind].markRead(c);
    return;
  }
  st.markAllThreadsRead(teamId, chip === "all" ? undefined : chip);
  if (chip === "all") {
    for (const c of cards) if (c.unread > 0 && c.kind === "dm") THREAD_KIND_SPECS.dm.markRead(c);
  }
}
