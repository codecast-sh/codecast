// Store rows → the view models the chat components take.
//
// The presentational layer (components/chat/*) speaks ChatMessageView and knows
// nothing about the store. This file is the one translation between the two, and
// it is pure so it can be tested without React, a store or Convex.
//
// Identity resolution follows lib/liveEntities' rule: derive at render from the
// live roster rather than storing a snapshot on the row. A chat message carries
// only `user_id`, so the author's name and face come from `teamMembers` every
// time — which is what makes a renamed teammate rename everywhere at once.

import { memberAvatarUrl, memberDisplayName } from "./liveEntities";
import type { ChatMessageRow, ChatReactionRow } from "../store/chatSlice";
import type { ChatAuthor, ChatMessageView, ChatReaction } from "../components/chat/chatTypes";
import { botHandle } from "@codecast/convex/convex/chatText";

export type ChatMember = {
  _id: string;
  name?: string;
  email?: string;
  image?: string;
  github_avatar_url?: string;
  github_username?: string;
  is_bot?: boolean;
};

const UNKNOWN: ChatAuthor = { id: "", name: "Someone" };

/** The app's one naming rule (lib/liveEntities), with chat's own placeholder for
 *  a member the roster has not loaded. Chat used to carry its own chain, which
 *  drifted from every other surface's. */
export function memberName(m: ChatMember | undefined): string {
  return memberDisplayName(m, "Someone");
}

function emailHandle(m: ChatMember): string | null {
  const local = m.email?.split("@")[0]?.toLowerCase();
  return local && /^[a-z0-9_-]+$/.test(local) ? local : null;
}

/** Every handle this member answers to, lowercased.
 *
 *  Mirrors chat.ts resolveMentions exactly — a GitHub handle or an email local
 *  part for a person, the slugged display name for a bot. Humans are never
 *  matched on their display name there, so they must not be highlighted on it
 *  here: a mention that lights up but notifies nobody is worse than plain text. */
export function memberHandles(m: ChatMember): string[] {
  if (m.is_bot) {
    const bot = botHandle(m.name);
    return bot ? [bot] : [];
  }
  const out: string[] = [];
  if (m.github_username) out.push(m.github_username.toLowerCase());
  const email = emailHandle(m);
  // A GitHub handle that matches the email local part is one handle, not two —
  // authorFor takes the first as the member's display handle.
  if (email && !out.includes(email)) out.push(email);
  return out;
}

export type HandleSets = { known: Set<string>; self: Set<string>; names: Map<string, string> };

/** The two sets ChatMessage hands the mention plugin: which @words resolve to a
 *  real member at all, and which of those are the viewer. */
export function buildHandleSets(members: ChatMember[], viewerId: string): HandleSets {
  const known = new Set<string>();
  const self = new Set<string>();
  // handle → display name, so the rendered chip can wear the person's name the
  // way a doc mention does, while the stored text stays the resolvable handle.
  const names = new Map<string, string>();
  for (const m of members) {
    for (const h of memberHandles(m)) {
      known.add(h);
      if (m._id === viewerId) self.add(h);
      const display = (m.name || "").trim();
      if (display) names.set(h, display);
    }
  }
  // @here addresses everyone including the viewer, so it reads as a self-mention.
  known.add("here");
  self.add("here");
  names.set("here", "here");
  return { known, self, names };
}

export function authorFor(
  userId: string,
  authorKind: "user" | "agent" | undefined,
  byId: Map<string, ChatMember>,
): ChatAuthor {
  const m = byId.get(userId);
  if (!m) return authorKind === "agent" ? { id: userId, name: "Agent", isAgent: true } : { ...UNKNOWN, id: userId };
  const isAgent = authorKind === "agent" || !!m.is_bot;
  return {
    id: userId,
    name: memberName(m),
    // A bot renders its own identity, never a photo — see CommentAvatar.
    avatarUrl: isAgent ? undefined : memberAvatarUrl(m),
    isAgent,
    handle: memberHandles(m)[0],
  };
}

export function mentionsViewer(row: ChatMessageRow, viewerId: string): boolean {
  if (row.mention_scope === "here") return true;
  return !!row.mentions?.some((id) => id === viewerId);
}

/** Per-root reply rollups, in one pass over the whole message map.
 *
 *  A rollup on a root message is the ONLY reason the channel needs to know its
 *  threads exist, so computing it here keeps selectChannelMessages a plain
 *  filter — and one pass beats one scan per visible root. */
export type ThreadRollup = {
  replyCount: number;
  lastReplyAt: number;
  /** Distinct repliers, oldest first — the faces on the thread link. */
  faces: string[];
};

export function threadRollups(messages: Iterable<ChatMessageRow>): Map<string, ThreadRollup> {
  const out = new Map<string, ThreadRollup>();
  for (const row of messages) {
    const root = row.thread_root_id;
    if (!root || row.deleted_at) continue;
    let entry = out.get(root);
    if (!entry) out.set(root, (entry = { replyCount: 0, lastReplyAt: 0, faces: [] }));
    entry.replyCount++;
    if (row.created_at > entry.lastReplyAt) entry.lastReplyAt = row.created_at;
    if (!entry.faces.includes(row.user_id)) entry.faces.push(row.user_id);
  }
  return out;
}

export type ViewContext = {
  members: Map<string, ChatMember>;
  viewerId: string;
  /** Reactions for one message, already folded. Passed in so the caller decides
   *  whether reaction state is even loaded. */
  reactionsFor?: (messageId: string) => ChatReaction[] | undefined;
  rollups?: Map<string, ThreadRollup>;
  /** "sent" | "pending" | "failed" for a row — store/chatSlice's chatSendState. */
  sendState?: (row: ChatMessageRow) => "sent" | "pending" | "failed";
};

export function toMessageView(row: ChatMessageRow, ctx: ViewContext): ChatMessageView {
  const rollup = ctx.rollups?.get(row._id);
  const state = ctx.sendState?.(row) ?? "sent";
  const reactions = ctx.reactionsFor?.(row._id);
  return {
    id: row._id,
    author: authorFor(row.user_id, row.author_kind, ctx.members),
    content: row.content,
    createdAt: row.created_at,
    editedAt: row.edited_at,
    deletedAt: row.deleted_at,
    mentionsMe: mentionsViewer(row, ctx.viewerId),
    reactions: reactions && reactions.length > 0 ? reactions : undefined,
    agentStatus: row.agent_status,
    replyCount: rollup?.replyCount,
    lastReplyAt: rollup?.lastReplyAt || undefined,
    replyFaces: rollup?.faces.slice(0, 4).map((id) => {
      const a = authorFor(id, undefined, ctx.members);
      return { id: a.id, name: a.name, avatarUrl: a.avatarUrl, isAgent: a.isAgent };
    }),
    pending: state === "pending",
    failed: state === "failed",
  };
}

export function toMessageViews(rows: ChatMessageRow[], ctx: ViewContext): ChatMessageView[] {
  return rows.map((row) => toMessageView(row, ctx));
}

/** Fold one message's reaction rows into pills. Same distinct-user counting as
 *  the store selector; kept here for callers that already hold the rows. */
export function foldReactions(
  rows: ChatReactionRow[],
  viewerId: string,
  nameOf?: (userId: string) => string | undefined,
): ChatReaction[] {
  const byEmoji = new Map<string, { users: Set<string>; first: number }>();
  for (const row of rows) {
    let entry = byEmoji.get(row.emoji);
    if (!entry) byEmoji.set(row.emoji, (entry = { users: new Set(), first: row.created_at }));
    entry.users.add(row.user_id);
    if (row.created_at < entry.first) entry.first = row.created_at;
  }
  return [...byEmoji.entries()]
    .sort((a, b) => a[1].first - b[1].first)
    .map(([emoji, entry]) => ({
      emoji,
      count: entry.users.size,
      mine: entry.users.has(viewerId),
      ...(nameOf ? { names: [...entry.users].map((u) => nameOf(u) ?? "Someone") } : {}),
    }));
}
