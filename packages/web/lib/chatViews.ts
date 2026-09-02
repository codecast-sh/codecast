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
import { compareMembersByPresence } from "../components/presence/memberPresence";
import type { ChatMessageRow, ChatReactionRow } from "../store/chatSlice";
import type { ChatAuthor, ChatChannelView, ChatMessageView, ChatReaction } from "../components/chat/chatTypes";
import { botHandle } from "@codecast/convex/convex/chatText";
import { chatRoomKey } from "@codecast/shared/contracts";
import { dmOtherIds } from "@codecast/shared/chat";

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

/** What a room is called where a name is shown.
 *
 *  A channel is its slug. A DM is the OTHER side's names, resolved live from
 *  the roster (liveEntities' rule), so a renamed teammate renames the room —
 *  "Sam" alone for a 1:1, "Sam, Jason" for a group. A DM whose roster hasn't
 *  loaded yet is honestly a "Direct message", never a blank. */
export function channelDisplayName(
  view: { name: string; kind?: string; dmMemberIds?: string[] },
  members: ChatMember[] | undefined,
): string {
  if (view.kind !== "dm") return view.name;
  const ids = view.dmMemberIds ?? [];
  if (ids.length === 0) return "Direct message";
  const byId = new Map((members ?? []).map((m) => [String(m._id), m]));
  const names = ids.map((id) => {
    const m = byId.get(String(id)) ?? knownAgentMember(String(id));
    // First name only past a 1:1 — three full names don't fit a rail row.
    const full = memberName(m);
    return ids.length > 1 ? full.split(/\s+/)[0] : full;
  });
  return names.join(", ");
}

/** The huddle room of a chat view. A DM or group thread huddles in the room
 *  of its member set (the viewer plus `dmMemberIds`, which is known even for a
 *  stub the rail has never seen); a channel in its own standing room. One
 *  rule for the rail chip, the header button and the occupancy sync, so the
 *  three can never point at different keys for the same conversation. */
export function chatViewRoomKey(
  view: { id: string; kind?: string; dmMemberIds?: string[]; memberIds?: string[] },
  viewerId: string,
  teammates?: { _id: string }[],
): string {
  return chatRoomKey({
    id: view.id,
    kind: view.kind,
    otherIds: view.dmMemberIds,
    viewerId,
    memberIds: view.kind === "dm" ? undefined : view.memberIds,
    teammateIds: teammates?.map((m) => String(m._id)),
  });
}

/** The same key from RAW store rows (a chat_channels row + its rail row),
 *  for feeders that run below the view layer (useCallSync). Derives the
 *  roster exactly the way chatSlice builds dmMemberIds — dm_key first, rail
 *  member rows as the fallback — so the occupancy the sync fetches and the
 *  key a chip subscribes to can never disagree. */
export function channelRowRoomKey(
  channel: { _id: string; kind?: string; dm_key?: string },
  rail: { member_ids?: string[] } | undefined,
  viewerId: string,
  teammates?: { _id: string }[],
): string {
  const fromKey = channel.dm_key ? dmOtherIds(channel.dm_key, viewerId) : undefined;
  const otherIds =
    fromKey ?? rail?.member_ids?.filter((uid) => String(uid) !== String(viewerId));
  return chatRoomKey({
    id: String(channel._id),
    kind: channel.kind,
    otherIds,
    viewerId,
    teammateIds: teammates?.map((m) => String(m._id)),
  });
}

/** The avatar-bearing side of a 1:1 DM, for surfaces that show a face. */
/** What a rail row says when the pointer rests on it: the name it wears, the
 *  topic under it (a channel's), and the one state worth a word — mentions,
 *  unread, muted, a live huddle. The wide rail shows the name; the narrow
 *  rail shows only a tile, so this is the whole row's voice there. */
export function railRowTip(
  c: ChatChannelView,
  members: ChatMember[],
  extra: { live?: boolean } = {},
): { title: string; detail?: string; state?: string } {
  const name = channelDisplayName(c, members);
  const title = c.kind === "dm" ? name : `#${name}`;
  const detail = c.kind === "dm" ? undefined : c.topic || undefined;
  const mentions = c.mentionCount ?? 0;
  const unread = c.unreadCount ?? 0;
  const state = extra.live
    ? "Huddle live"
    : mentions > 0
      ? `${mentions} mention${mentions === 1 ? "" : "s"}`
      : unread > 0
        ? `${unread} unread`
        : c.muted
          ? "Muted"
          : undefined;
  return { title, detail, state };
}

export function dmCounterpart(
  view: { kind?: string; dmMemberIds?: string[] },
  members: ChatMember[] | undefined,
): ChatMember | undefined {
  if (view.kind !== "dm" || (view.dmMemberIds ?? []).length !== 1) return undefined;
  const id = String(view.dmMemberIds![0]);
  return (members ?? []).find((m) => String(m._id) === id) ?? knownAgentMember(id);
}

// Agent identities the team ROSTER does not carry — a personal anchor's bot is
// nobody's teammate, yet it opens DM rooms with its owner and must be named
// there. The anchors feeder registers every anchor bot the viewer can see;
// the naming helpers fall back to this when the roster misses an id. Lookup
// only: these never become mention targets or picker rows.
const knownAgents = new Map<string, ChatMember>();
export function registerKnownAgentMembers(list: ChatMember[]): void {
  knownAgents.clear();
  for (const m of list) knownAgents.set(String(m._id), m);
}
export function knownAgentMember(id: string): ChatMember | undefined {
  return knownAgents.get(id);
}

/** The app's one naming rule (lib/liveEntities), with chat's own placeholder for
 *  a member the roster has not loaded. Chat used to carry its own chain, which
 *  drifted from every other surface's. */
export function memberName(m: ChatMember | undefined): string {
  return memberDisplayName(m, "Someone");
}

/** Teammates the DM section offers before any conversation exists.
 *
 *  A DM list that only shows rooms already opened makes the first message the
 *  hardest one: the section is empty exactly when messaging someone would be
 *  most useful. So the rail seeds it with everyone reachable — humans on the
 *  team without an open 1:1 — and clicking one opens the room local-first.
 *  Bots are excluded because openDm refuses them; the viewer because a DM with
 *  yourself is a notes app this product doesn't have. Presence-sorted: the
 *  people most likely to answer float to the top. Shared by the chat rail and
 *  the app sidebar so the two DM sections can never disagree. */
export function suggestedDmMembers(
  channels: { kind?: string; dmMemberIds?: string[] }[],
  members: ChatMember[] | undefined,
  viewerId: string,
  cap = 8,
): ChatMember[] {
  const open = new Set<string>();
  for (const c of channels) {
    if (c.kind !== "dm") continue;
    const ids = c.dmMemberIds ?? [];
    if (ids.length === 1) open.add(String(ids[0]));
  }
  return (members ?? [])
    .filter((m) => !m.is_bot && String(m._id) !== String(viewerId) && !open.has(String(m._id)))
    .sort(compareMembersByPresence)
    .slice(0, cap);
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

/** The session persona for a line a codecast session typed (origin "agent").
 *
 *  Follows the same live-derivation rule as everything above: when the viewer
 *  can see the session, its CURRENT title and agent come from the store via
 *  `ctx.sessionFor`, so a renamed session renames its chat lines. The server's
 *  send-time snapshot on the row is the fallback for viewers without access.
 *  The human the session ran as stays visible as the `via` credit — the words
 *  are machine-typed but the authority is still that person's. */
export function sessionAuthorFor(row: ChatMessageRow, ctx: ViewContext): ChatAuthor | null {
  // An anchor reply (author_kind "agent") already has its own identity.
  if (row.origin !== "agent" || !row.origin_session_id || row.author_kind === "agent") return null;
  const live = ctx.sessionFor?.(row.origin_session_id);
  const human = ctx.members.get(row.user_id);
  const title = live?.title || row.origin_session_title;
  return {
    id: row.user_id,
    name: title || "Agent session",
    isAgent: true,
    session: {
      id: row.origin_session_id,
      agentType: live?.agentType || row.origin_agent_type || "claude_code",
      via: human ? memberName(human) : undefined,
    },
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
  /** The server's per-root rollups (a derived snapshot). Merged per root by
   *  recency: local rows include the optimistic reply typed a moment ago, the
   *  snapshot covers threads this client never opened — whichever saw the
   *  thread LAST is the one telling the truth right now. */
  summaries?: Record<string, {
    reply_count: number;
    last_reply_at: number;
    reply_user_ids: string[];
    agent_status?: "thinking" | "streaming" | "error";
  }>;
  /** "sent" | "pending" | "failed" for a row — store/chatSlice's chatSendState. */
  sendState?: (row: ChatMessageRow) => "sent" | "pending" | "failed";
  /** Live lookup for a session that typed a line (sessionAuthorFor). Absent
   *  where the caller has no session store — the row's snapshot still renders. */
  sessionFor?: (sessionId: string) => { title?: string; agentType?: string } | undefined;
};

export function toMessageView(row: ChatMessageRow, ctx: ViewContext): ChatMessageView {
  const local = ctx.rollups?.get(row._id);
  const summary = ctx.summaries?.[row._id];
  // Whichever source saw the thread last wins the affordance.
  const useSummary = !!summary && (!local || summary.last_reply_at > local.lastReplyAt);
  const replyCount = useSummary ? summary!.reply_count : local?.replyCount;
  const lastReplyAt = useSummary ? summary!.last_reply_at : local?.lastReplyAt;
  const faceIds = useSummary ? summary!.reply_user_ids : local?.faces;
  const state = ctx.sendState?.(row) ?? "sent";
  const reactions = ctx.reactionsFor?.(row._id);
  return {
    id: row._id,
    author: sessionAuthorFor(row, ctx) ?? authorFor(row.user_id, row.author_kind, ctx.members),
    threadRootId: row.thread_root_id,
    content: row.content,
    createdAt: row.created_at,
    editedAt: row.edited_at,
    deletedAt: row.deleted_at,
    mentionsMe: mentionsViewer(row, ctx.viewerId),
    attachments: row.attachments?.length ? row.attachments : undefined,
    // A canceled burst carries `deleted_at` too, so it never reaches the voice
    // bubble — the deleted branch above it answers first. toMessageViews drops
    // it before that, unless somebody replied to it.
    // AUDIO ALONE IS A VOICE NOTE. `voice` is what a walkie burst carries, and
    // keying the bubble on it alone meant a row holding a recording and nothing
    // else fell through to the attachment grid, which puts every storage id in
    // an <img>: a broken thumbnail where a voice note should be, with no way to
    // play it. What a row IS, is decided by what is on it.
    //
    // SOLE, and with nothing typed. A voice bubble replaces the whole body —
    // the markdown and the attachment grid both — so inferring one for a row
    // that also carries an image made the image silently disappear, and a row
    // that also carries typed text rendered that text as if it were speech.
    // Those rows are ordinary messages that happen to have a recording on them,
    // and they keep their body; ChatMessage's grid plays the audio rather than
    // trying to draw it.
    voice: row.voice
      ? {
          status: row.voice.status,
          durationMs: row.voice.duration_ms,
          roomKey: row.voice.room_key,
          transcribing: row.voice.transcribing,
        }
      : row.attachments?.length === 1 &&
          row.attachments[0].mime?.startsWith("audio/") &&
          !row.content.trim()
        ? { status: "done" as const, inferred: true }
        : undefined,
    call: row.call ? { transcriptId: row.call.transcript_id } : undefined,
    reactions: reactions && reactions.length > 0 ? reactions : undefined,
    agentStatus: row.agent_status,
    replyCount: replyCount || undefined,
    lastReplyAt: lastReplyAt || undefined,
    replyFaces: faceIds?.slice(0, 4).map((id) => {
      const a = authorFor(id, undefined, ctx.members);
      return { id: a.id, name: a.name, avatarUrl: a.avatarUrl, isAgent: a.isAgent };
    }),
    threadAgentStatus: useSummary ? summary!.agent_status : undefined,
    pending: state === "pending",
    failed: state === "failed",
  };
}

export function toMessageViews(rows: ChatMessageRow[], ctx: ViewContext): ChatMessageView[] {
  return rows
    .map((row) => toMessageView(row, ctx))
    // A canceled burst is a key somebody brushed: nothing was said, so there is
    // nothing to show. The server keeps the row as a tombstone rather than
    // deleting it — a hard delete cannot travel through a delta overlay, and
    // watchers holding the live row would pulse forever — but a tombstone is a
    // message to the CLIENT, not a line in the conversation. Rendering it would
    // put "This message was deleted" in the DM every time a hand brushed a key.
    //
    // Unless something already points at it. A reply needs its root to have
    // somewhere to hang, and there the tombstone is doing the ordinary job any
    // deleted message's does.
    .filter((view) => view.voice?.status !== "canceled" || !!view.replyCount);
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
