// Team chat: the local-first store layer.
//
// Everything the chat surface renders comes from here, and every gesture paints
// from the draft before any round trip — the same law the rest of the store
// obeys. The four synced collections mirror the four chat tables, and each one
// syncs as a DELTA overlay: opening #design must never prune the page of
// #general the user just read, and a thread's replies must stay reachable while
// only the channel's roots are in view. One flat `chatMessages` map, keyed by
// row id and carrying `channel_id` / `thread_root_id`, gives both — a channel is
// a filter, a thread is a filter, and neither disturbs the other.
//
// WHY THESE COLLECTIONS ARE NOT `localFirst`
//
// Pending FIELD protection reconciles by exact equality: the local value clears
// only when the server echoes it back identically. That works for `comments`,
// whose optimistic writes are strings the server stores verbatim. It cannot work
// for chat, whose interesting fields are SERVER CLOCK stamps — `deleted_at`,
// `edited_at`, `updated_at` — which the backend deliberately derives itself (see
// chat.ts's header: identity and time are never caller arguments). An optimistic
// `deleted_at: Date.now()` would never equal the server's, so its pending entry
// would never retire and would mask the real row forever, one immortal entry per
// delete. So chat opts out of auto-pending entirely and reconciles the way the
// data actually behaves: the delta overlay replaces a row wholesale on echo, an
// optimistic send is superseded by `client_id` (the altKey), and the two REAL
// removals — discarding a failed send, taking a reaction back — plant their
// exclude tombstone explicitly, which is also what authorizes the IDB diff to
// delete the row from disk.
//
// WHERE A FAILED SEND COMES FROM
//
// Nothing here decides that a send failed. The dispatch/outbox machinery does:
// `dispatchChatSend` is an ordinary action, so its args are journaled to the
// durable outbox and re-driven on reconnect, on tab focus and at boot, and when
// delivery finally gives up the middleware calls the dispatch error hook, which
// calls `markChatSendFailed` with the client id carried in those same args (see
// hooks/useEnsureDispatch.ts). A retry re-dispatches the SAME client id, which
// chat.sendMessage dedupes on — so a message that actually landed can never
// double-post, however many times the user presses retry.

import { threadRowId, type PageCommentRow, type PageThreadRow, type ThreadInboxRow, type ThreadKind } from "./threadTypes";
import { inActiveWorkspace } from "../lib/workspaceScope";
import { dmKeyFor, dmOtherIds, isLiveVoiceRow, type ChatVoiceStatus } from "@codecast/shared/chat";
import { normalizeChannelName } from "@codecast/convex/convex/chatText";
import { action, asyncAction, sync } from "./mutativeMiddleware";
import type { PendingEntry } from "./syncProtocol";
import { isConvexId } from "../lib/entityLinks";
import { tallyUnread } from "../lib/chatTimeline";
import { foldReactions } from "../lib/chatViews";
import type { ChatChannelView, ChatReaction } from "../components/chat/chatTypes";

// ── Row shapes ──────────────────────────────────────────────────────────────
//
// Mirrors of the convex tables, with the id fields widened to string (an
// optimistic row is keyed by a stub id until the server row supersedes it) and
// two local-only fields on a message.

export type ChatNotifyLevel = "all" | "mentions" | "none";
export type ChatAgentStatus = "thinking" | "streaming" | "done" | "error";

export type ChatAttachment = {
  storage_id: string;
  name?: string;
  mime?: string;
  width?: number;
  height?: number;
};

export type ChatChannelRow = {
  _id: string;
  team_id?: string;
  name: string;
  /** Absent = public. Private channels and DMs gate on membership server-side;
   *  the client only shapes the surface (icon, naming, what the menu offers). */
  kind?: "public" | "private" | "dm";
  /** ACCESS stamp (workspaceKey-shaped); the client never branches on it. */
  workspace?: string;
  /** `<teamId>:<sorted member ids>` — a DM's identity, and the client's source
   *  for naming the room (the other side's names, resolved at render). */
  dm_key?: string;
  topic?: string;
  is_default?: boolean;
  created_by?: string;
  created_at: number;
  updated_at: number;
  archived_at?: number | null;
  client_id?: string;
};

export type ChatMessageRow = {
  _id: string;
  team_id?: string;
  channel_id: string;
  thread_root_id?: string;
  broadcast?: boolean;
  user_id: string;
  author_kind?: "user" | "agent";
  content: string;
  mentions?: string[];
  mention_scope?: "here";
  attachments?: ChatAttachment[];
  // Push-to-talk. Present only on a walkie burst; the recording itself rides
  // `attachments` like any other file, so playback is an attachment concern.
  voice?: { status: ChatVoiceStatus; duration_ms?: number; room_key?: string; transcribing?: boolean };
  // A huddle digest row: the summary is `content`, this names the transcript
  // the reader can unfold under it.
  call?: { transcript_id: string };
  client_id?: string;
  origin?: "agent";
  // The session that typed an origin:"agent" line, plus the server's send-time
  // snapshot of its title/agent. Render prefers the LIVE session row when the
  // viewer can see it (lib/chatViews sessionAuthorFor); the snapshot is the
  // fallback for viewers without access to the session.
  origin_session_id?: string;
  origin_session_title?: string;
  origin_agent_type?: string;
  created_at: number;
  updated_at: number;
  edited_at?: number;
  deleted_at?: number;
  agent_status?: ChatAgentStatus;
  agent_anchor_id?: string;
  anchor_follow?: boolean;
  fork_conversation_id?: string;
  // Local only. Set when delivery gave up, cleared when the user retries, and
  // gone for good the moment the server row supersedes the stub.
  _failedAt?: number;
  _failReason?: string;
};

export type ChatReadRow = {
  _id: string;
  user_id?: string;
  channel_id: string;
  team_id?: string;
  last_read_at: number;
  last_read_message_id?: string;
  notify_level: ChatNotifyLevel;
  joined_at?: number;
  updated_at: number;
};

export type ChatReactionRow = {
  _id: string;
  message_id: string;
  channel_id?: string;
  user_id: string;
  emoji: string;
  created_at: number;
};

/** One row of chat.listChannels' `rail` — the server's own unread numbers.
 *  Kept because they are the only honest count for a channel whose messages
 *  this client has never loaded (see selectChatRail). */
/** The server's per-root thread rollup (listMessages.threads) — a derived
 *  snapshot, cached transiently and OVERLAID at render (lib/liveEntities'
 *  rule): the local rows win whenever they are fresher, so an optimistic reply
 *  bumps the count instantly and the snapshot fills in for threads this client
 *  has never opened. */
export type ChatThreadSummaryRow = {
  /** Equals root_id — syncTable collections key by _id. */
  _id: string;
  root_id: string;
  reply_count: number;
  reply_capped?: boolean;
  last_reply_at: number;
  reply_user_ids: string[];
  agent_status?: "thinking" | "streaming" | "error";
};

export type ChatRailRow = {
  channel_id: string;
  last_message?: {
    _id: string;
    user_id: string;
    author_kind?: "user" | "agent";
    created_at: number;
    preview: string;
  } | null;
  /** DM rooms only: the newest message from the other person (null when the
   *  viewer alone has spoken). Absent on channels. */
  last_inbound?: { _id: string; created_at: number } | null;
  sort_at: number;
  unread: number;
  unread_capped?: boolean;
  unread_mentions: number;
  notify_level: ChatNotifyLevel;
  joined: boolean;
  /** Roster of a private room or DM — derived by the server, absent on public
   *  channels (their audience is the team). */
  member_ids?: string[];
};

// ── Stub ids ────────────────────────────────────────────────────────────────
//
// A local row the server has never seen. Not a Convex id, so the generic patch
// collector skips it, `isConvexId` tells the two apart everywhere, and the
// altKey supersede rekeys it onto the real row when the echo lands.

export const CHAT_CHANNEL_STUB_PREFIX = "chatstub-";
export const CHAT_MESSAGE_STUB_PREFIX = "chatmsgstub-";
export const CHAT_READ_STUB_PREFIX = "chatreadstub-";
export const CHAT_REACTION_STUB_PREFIX = "chatreactstub-";

function randomSuffix(): string {
  return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}

export function newChatMessageClientId(): string {
  return `${CHAT_MESSAGE_STUB_PREFIX}${randomSuffix()}`;
}

export function newChatChannelClientId(): string {
  return `${CHAT_CHANNEL_STUB_PREFIX}${randomSuffix()}`;
}

/** The one reaction row this viewer can own for (message, emoji). Deterministic
 *  so a double-tap finds and removes its own optimistic row rather than adding
 *  a second one. */
export function chatReactionStubId(messageId: string, emoji: string): string {
  return `${CHAT_REACTION_STUB_PREFIX}${messageId}-${emoji}`;
}

/** How a message row should render while it is on its way out.
 *   "sent"    — the server has it.
 *   "pending" — optimistic, still riding the outbox.
 *   "failed"  — delivery gave up; the row is the only copy of what was typed. */
export function chatSendState(row: Pick<ChatMessageRow, "_id" | "_failedAt">): "sent" | "pending" | "failed" {
  if (row._failedAt) return "failed";
  return isConvexId(row._id) ? "sent" : "pending";
}

// ── State + action surface ──────────────────────────────────────────────────

export type ChatSliceData = {
  chatChannels: Record<string, ChatChannelRow>;
  chatMessages: Record<string, ChatMessageRow>;
  chatReactions: Record<string, ChatReactionRow>;
  chatReads: Record<string, ChatReadRow>;
  chatRail: ChatRailRow[];
  chatThreadSummaries: Record<string, ChatThreadSummaryRow>;
  /** The Threads inbox (threads.listMine): one row per thread the viewer is
   *  in, every kind. Keyed by threadRowId. */
  threadInbox: Record<string, ThreadInboxRow>;
  /** The server's workspace-wide count of threads with unseen replies — the
   *  badge for a client that has never opened the Threads page. */
  threadUnread: number;
  /** Published pages with their newest comments (threads.listMine payload),
   *  keyed by artifact id — the page kind's root_key. */
  pageThreads: Record<string, PageThreadRow>;
};

export type ChatSendOptions = {
  threadRootId?: string;
  /** Slack's "also send to #channel": the reply stays in its thread and shows
   *  in the channel timeline too. Only meaningful with threadRootId. */
  broadcast?: boolean;
  attachments?: ChatAttachment[];
  /** Set by an agent session posting through the web client. Only ever takes
   *  privilege away (chat.ts refuses to wake an anchor for a machine's line). */
  origin?: "agent";
};

export type ChatSliceActions = {
  /** Paints the message and hands back its client id — the row id the list
   *  renders, the retry handle, and the server's dedupe key. */
  sendChatMessage: (channelId: string, content: string, opts?: ChatSendOptions) => string;
  /** The durable half of a send. Called by sendChatMessage and by retry; never
   *  call it directly — the client id has to exist first. */
  dispatchChatSend: (channelId: string, content: string, clientId: string, opts?: ChatSendOptions) => void;
  retryChatSend: (rowId: string) => void;
  markChatSendFailed: (rowId: string, reason?: string) => void;
  discardChatSend: (rowId: string) => void;

  /** Push-to-talk, sender side. The burst's bubble is painted the instant the
   *  key goes down — a walkie burst is a message like any other and must not
   *  wait for a mutation to appear in its own DM. The row carries
   *  `client_id === its stub id`, so the server's row supersedes it through the
   *  same altKey path a typed send uses.
   *
   *  Unlike a send this is optimism ONLY: the burst mutations are live gestures
   *  (chat.startVoiceBurst and friends), not durable outbox work — an audio
   *  stream that failed to reach the server cannot be replayed an hour later,
   *  and the engine cancels the burst instead. */
  beginVoiceBurstRow: (channelId: string, clientId: string, roomKey?: string) => void;
  /** Advance the burst's own bubble: the transcript while it runs, then the
   *  landed shape. Addressed by BOTH ids because the server row can supersede
   *  the stub mid-burst (the sender is looking at the channel), and after that
   *  rekey the stub id names nothing. */
  updateVoiceBurstRow: (
    ids: { clientId: string; messageId?: string | null },
    patch: {
      content?: string;
      status?: ChatVoiceStatus;
      durationMs?: number;
      attachments?: ChatAttachment[];
    },
  ) => void;
  /** Take the bubble back. Distinct from discardChatSend, which refuses a row
   *  the server holds: a cancelled burst really is deleted server-side (or
   *  tombstoned, when a reply already points at it), so removing it here is
   *  the truth rather than forgetting. */
  dropVoiceBurstRow: (ids: { clientId: string; messageId?: string | null }) => void;

  /** Edits a sent message, or rewrites one that never left — a failed send is
   *  edited by editing what will be sent, under the same client id. */
  editChatMessage: (messageId: string, content: string) => void;
  dispatchChatEdit: (messageId: string, content: string) => void;
  /** Tombstones a sent message. A message the server never accepted has nothing
   *  to tombstone, so discarding it is the delete. */
  deleteChatMessage: (messageId: string) => void;
  dispatchChatDelete: (messageId: string) => void;
  toggleChatReaction: (messageId: string, emoji: string) => void;
  markChannelRead: (channelId: string, lastMessageId?: string) => void;
  /** Clears one thread's unread the moment it is opened; the mutation moves the
   *  server mark to the thread's newest activity. */
  markThreadRead: (kind: ThreadKind, rootKey: string) => void;
  /** The card's "done": archives the caller's follow — the row leaves the
   *  inbox now (threads.dismiss deletes the server row); the next qualifying
   *  reply files a fresh one. */
  dismissThread: (kind: ThreadKind, rootKey: string) => void;
  /** The Threads page's one sweep. Scoped to the workspace like the page
   *  itself; `kind` narrows it to one chip. */
  markAllThreadsRead: (teamId?: string | null, kind?: ThreadKind | "all") => void;
  /** Reply on a published page's discussion (the page kind's composer). The
   *  caller mints the client id (newPageCommentClientId) because the dispatch
   *  effect reads it from this one argument object. */
  addPageComment: (o: { artifactId: string; text: string; parentId?: string; clientId: string }) => void;
  /** Drop local rows a fresh listMine page no longer returns (revoked access). */
  pruneThreadInbox: (keepIds: string[], teamId: string | undefined | null, floorActivityAt: number) => void;
  setChannelNotifyLevel: (channelId: string, level: ChatNotifyLevel) => void;
  /** Rename or re-topic a channel. Optimistic: the rail and header rename the
   *  moment you confirm; the server enforces creator-or-admin and reconciles. */
  updateChatChannel: (channelId: string, fields: { name?: string; topic?: string }) => void;
  /** Archive (or restore) a channel. Optimistic: the row leaves the rail at
   *  once. Restore writes null, the tombstone a delta sync can see. */
  archiveChatChannel: (channelId: string, archived: boolean) => void;
  /** Grow a private room. The roster is server-derived (the rail's member_ids),
   *  so there is no local row to write — the echo carries the new face. */
  addChatChannelMembers: (channelId: string, memberIds: string[]) => void;
  /** Remove someone (creator/admin), or yourself (leaving). Leaving also drops
   *  the room locally at once — waiting for the echo would leave you looking at
   *  a room you just walked out of. */
  removeChatChannelMember: (channelId: string, userId: string) => void;
  /** Returns the stub channel id, so the rail can select the new channel in the
   *  same tick. The altKey supersede moves it onto the real id on echo. */
  createChatChannel: (name: string, opts?: ChatCreateChannelOptions) => string;
  dispatchCreateChatChannel: (
    clientId: string,
    name: string,
    opts?: ChatCreateChannelOptions,
  ) => Promise<any>;
  /** Open (or find) the DM with these teammates. Local-first: a room the store
   *  already holds returns its real id in the same tick; a new one returns a
   *  stub that the altKey supersede rekeys on echo. */
  openDmChannel: (memberIds: string[], teamId?: string) => string;
  dispatchOpenDm: (clientId: string, memberIds: string[], teamId?: string) => Promise<any>;
};

export type ChatCreateChannelOptions = {
  topic?: string;
  teamId?: string;
  /** "private" gates the room on a member list. */
  kind?: "private";
  /** Initial roster for a private room, besides the creator. */
  memberIds?: string[];
};

export type ChatSliceState = ChatSliceData & ChatSliceActions;

// The middleware wraps an asyncAction so its CALLER receives the server result as
// a promise; the function BODY returns nothing. The slice is written against the
// body's signature, the store interface against the caller's.
type ChatSliceImpl = ChatSliceData &
  Omit<ChatSliceActions, "dispatchCreateChatChannel" | "dispatchOpenDm"> & {
    dispatchCreateChatChannel: (
      clientId: string,
      name: string,
      opts?: ChatCreateChannelOptions,
    ) => void;
    dispatchOpenDm: (clientId: string, memberIds: string[], teamId?: string) => void;
  };

// What a chat action may touch on the draft. Deliberately narrow: chat writes
// its own collections, reads the signed-in user for authorship, and plants its
// own exclude tombstones.
type ChatDraft = ChatSliceData & {
  currentUser: { _id?: string } | null;
  pending: Record<string, PendingEntry>;
};

function viewerId(draft: ChatDraft): string {
  return draft.currentUser?._id ?? "";
}

function findReadRow(draft: ChatDraft, channelId: string): ChatReadRow | undefined {
  for (const id in draft.chatReads) {
    if (draft.chatReads[id]?.channel_id === channelId) return draft.chatReads[id];
  }
  return undefined;
}

/** Upsert this viewer's read row for a channel. A missing row is meaningful
 *  server-side ("never opened"), so the optimistic write creates it the same way
 *  the server does — the first read or post joins the channel. */
function upsertRead(
  draft: ChatDraft,
  channelId: string,
  patch: Partial<ChatReadRow>,
): void {
  const now = Date.now();
  const existing = findReadRow(draft, channelId);
  if (existing) {
    Object.assign(existing, patch, { updated_at: now });
    return;
  }
  const stubId = `${CHAT_READ_STUB_PREFIX}${channelId}`;
  draft.chatReads[stubId] = {
    _id: stubId,
    user_id: viewerId(draft),
    channel_id: channelId,
    last_read_at: 0,
    // Mirrors the server's create-time default (chat.ts upsertRead): Slack's
    // "mentions & DMs", with "all" as the per-channel opt-in.
    notify_level: "mentions",
    joined_at: now,
    updated_at: now,
    ...patch,
  };
}

/** The store's deletion contract. A row removed locally leaves IDB only when an
 *  exclude tombstone says the removal was deliberate (see writePatchesToIDB), and
 *  the tombstone also stops a sync push that predates the delete from re-adding
 *  the row. These collections generate no automatic pending entries, so the two
 *  gestures that really remove something plant theirs here, by hand. */
function excludeRow(draft: ChatDraft, collection: string, id: string): void {
  draft.pending[`${collection}:${id}`] = { type: "exclude", ts: Date.now() };
}

export function createChatSlice(set: any, get: any): ChatSliceImpl {
  return {
    chatChannels: {},
    chatMessages: {},
    chatReactions: {},
    chatReads: {},
    chatRail: [],
    chatThreadSummaries: {},
    threadInbox: {},
    threadUnread: 0,
    pageThreads: {},

    // ── Sending ─────────────────────────────────────────────────────────────

    sendChatMessage: (channelId: string, content: string, opts?: ChatSendOptions) => {
      const clientId = newChatMessageClientId();
      get().dispatchChatSend(channelId, content, clientId, opts);
      return clientId;
    },

    // The optimistic row is written HERE rather than in the wrapper so paint and
    // durable enqueue happen in one action: a reload between the two would
    // otherwise leave a message on screen with nothing to deliver it, or a
    // delivery with nothing on screen.
    dispatchChatSend: action(function (
      this: ChatDraft,
      channelId: string,
      content: string,
      clientId: string,
      opts?: ChatSendOptions,
    ) {
      const existing = this.chatMessages[clientId];
      if (existing) {
        // A retry, or an edit of something that never left. Same row, same client
        // id — the list keeps its place instead of the message jumping to the end,
        // and chat.sendMessage still dedupes anything that did land.
        existing.content = content;
        delete existing._failedAt;
        delete existing._failReason;
        delete this.pending[`chatMessages:${clientId}`];
        return;
      }
      const now = Date.now();
      this.chatMessages[clientId] = {
        _id: clientId,
        client_id: clientId,
        channel_id: channelId,
        thread_root_id: opts?.threadRootId,
        broadcast: opts?.threadRootId && opts?.broadcast ? true : undefined,
        user_id: viewerId(this),
        author_kind: "user",
        content,
        attachments: opts?.attachments,
        origin: opts?.origin,
        created_at: now,
        updated_at: now,
      };
      // Posting is reading, exactly as the server treats it.
      upsertRead(this, channelId, { last_read_at: now });
    }),

    retryChatSend: (rowId: string) => {
      const row = get().chatMessages[rowId] as ChatMessageRow | undefined;
      if (!row || isConvexId(row._id)) return;
      get().dispatchChatSend(row.channel_id, row.content, rowId, {
        threadRootId: row.thread_root_id,
        broadcast: row.broadcast,
        attachments: row.attachments,
        origin: row.origin,
      });
    },

    // Called by the dispatch error hook, not by a component: the store learns a
    // send failed the same way every other durable write does.
    markChatSendFailed: sync(function (this: ChatDraft, rowId: string, reason?: string) {
      const row = this.chatMessages[rowId];
      if (!row || isConvexId(row._id)) return;
      row._failedAt = Date.now();
      if (reason) row._failReason = reason;
    }),

    // The other half of a visible failure: throwing the message away. Only a row
    // the server never accepted can be discarded this way — anything it holds is
    // deleted, not forgotten.
    //
    // What this does NOT promise: the outbox owns delivery, and a chat send is
    // never given up on, so a send that failed transiently and later succeeds
    // will land. When it does, the message comes back as the ordinary sent
    // message it now is, with a real delete available. That is the honest
    // outcome — the alternative is a line that is gone from the sender's screen
    // and present on everyone else's.
    discardChatSend: sync(function (this: ChatDraft, rowId: string) {
      const row = this.chatMessages[rowId];
      if (!row || isConvexId(row._id)) return;
      delete this.chatMessages[rowId];
      excludeRow(this, "chatMessages", rowId);
    }),

    // ── Push to talk ────────────────────────────────────────────────────────

    beginVoiceBurstRow: sync(function (
      this: ChatDraft,
      channelId: string,
      clientId: string,
      roomKey?: string,
    ) {
      if (this.chatMessages[clientId]) return;
      const now = Date.now();
      this.chatMessages[clientId] = {
        _id: clientId,
        client_id: clientId,
        channel_id: channelId,
        user_id: viewerId(this),
        author_kind: "user",
        content: "",
        voice: { status: "live", room_key: roomKey },
        created_at: now,
        updated_at: now,
      };
      // Talking is reading, exactly as the server treats posting.
      upsertRead(this, channelId, { last_read_at: now });
    }),

    updateVoiceBurstRow: sync(function (
      this: ChatDraft,
      ids: { clientId: string; messageId?: string | null },
      patch: {
        content?: string;
        status?: ChatVoiceStatus;
        durationMs?: number;
        attachments?: ChatAttachment[];
      },
    ) {
      const row =
        (ids.messageId ? this.chatMessages[ids.messageId] : undefined) ??
        this.chatMessages[ids.clientId];
      if (!row) return;
      if (patch.content !== undefined) row.content = patch.content;
      if (patch.attachments !== undefined) row.attachments = patch.attachments;
      if (patch.status !== undefined || patch.durationMs !== undefined) {
        row.voice = {
          status: patch.status ?? row.voice?.status ?? "live",
          duration_ms: patch.durationMs ?? row.voice?.duration_ms,
          room_key: row.voice?.room_key,
        };
      }
      row.updated_at = Date.now();
    }),

    dropVoiceBurstRow: sync(function (
      this: ChatDraft,
      ids: { clientId: string; messageId?: string | null },
    ) {
      for (const id of [ids.messageId, ids.clientId]) {
        if (!id || !this.chatMessages[id]) continue;
        delete this.chatMessages[id];
        excludeRow(this, "chatMessages", id);
      }
    }),

    // ── Editing and deleting ────────────────────────────────────────────────

    // A message still riding the outbox has no server row to edit, and rewriting
    // the local row would not be enough — the parked send carries the ORIGINAL
    // text. Re-driving the send with the new content under the same client id is
    // both halves at once, and is what makes "edit or discard" a real answer to a
    // failed send.
    editChatMessage: (messageId: string, content: string) => {
      const row = get().chatMessages[messageId] as ChatMessageRow | undefined;
      if (!row || row.deleted_at) return;
      if (isConvexId(messageId)) get().dispatchChatEdit(messageId, content);
      else {
        get().dispatchChatSend(row.channel_id, content, messageId, {
          threadRootId: row.thread_root_id,
          broadcast: row.broadcast,
          attachments: row.attachments,
          origin: row.origin,
        });
      }
    },

    // `content` is the only field written optimistically. `edited_at` is a server
    // clock stamp: painting a local guess would put a value in the row that the
    // echo then corrects, for a marker that is a second away anyway.
    dispatchChatEdit: action(function (this: ChatDraft, messageId: string, content: string) {
      const row = this.chatMessages[messageId];
      if (row) row.content = content;
    }),

    deleteChatMessage: (messageId: string) => {
      if (isConvexId(messageId)) get().dispatchChatDelete(messageId);
      else get().discardChatSend(messageId);
    },

    // A tombstone, not a removal: replies keep their root, so a thread does not
    // lose its shape. Mirrors what chat.deleteMessage writes.
    dispatchChatDelete: action(function (this: ChatDraft, messageId: string) {
      const row = this.chatMessages[messageId];
      if (!row) return;
      row.deleted_at = Date.now();
      row.content = "";
      row.attachments = undefined;
      row.mentions = undefined;
      row.mention_scope = undefined;
    }),

    // ── Reactions ───────────────────────────────────────────────────────────
    //
    // A reaction is a row, not a field on the message, so a toggle is an insert
    // or a delete and two people reacting at once cannot overwrite each other.
    // The optimistic insert is keyed deterministically by (message, emoji) for
    // this viewer; selectChatReactions counts distinct users, so the stub and its
    // server twin read as one reaction during the window they overlap.
    toggleChatReaction: action(function (this: ChatDraft, messageId: string, emoji: string) {
      // Nothing to react to until the message itself exists server-side.
      if (!isConvexId(messageId)) return;
      const me = viewerId(this);
      const stubId = chatReactionStubId(messageId, emoji);
      let mine: ChatReactionRow | undefined;
      for (const id in this.chatReactions) {
        const row = this.chatReactions[id];
        if (row.message_id === messageId && row.user_id === me && row.emoji === emoji) {
          mine = row;
          break;
        }
      }
      if (mine) {
        const id = mine._id;
        delete this.chatReactions[id];
        excludeRow(this, "chatReactions", id);
        return;
      }
      delete this.pending[`chatReactions:${stubId}`];
      this.chatReactions[stubId] = {
        _id: stubId,
        message_id: messageId,
        channel_id: this.chatMessages[messageId]?.channel_id,
        user_id: me,
        emoji,
        created_at: Date.now(),
      };
    }),

    // ── Read state ──────────────────────────────────────────────────────────

    // Passing the message id makes the local stamp EXACTLY what the server will
    // write (chat.markRead clamps to that message's created_at), so the badge
    // that clears here does not flicker back when the echo lands.
    markChannelRead: action(function (this: ChatDraft, channelId: string, lastMessageId?: string) {
      const marker = lastMessageId ? this.chatMessages[lastMessageId] : undefined;
      const readAt = marker ? Math.min(marker.created_at, Date.now()) : Date.now();
      const existing = findReadRow(this, channelId);
      // Never move the mark backwards: a stale "reached bottom" from a list that
      // has since grown would re-unread what the viewer already saw.
      if (existing && existing.last_read_at >= readAt) return;
      upsertRead(this, channelId, {
        last_read_at: readAt,
        ...(lastMessageId && isConvexId(lastMessageId) ? { last_read_message_id: lastMessageId } : {}),
      });
    }),

    // The local paint mirrors what the mutation writes — the mark moves to the
    // thread's newest activity and the unread numbers drop to zero — so the
    // echo confirms rather than corrects. Numbers reconcile by value, which is
    // why this derived row may be patched optimistically where an object field
    // could not be (see lib/liveEntities' rule).
    markThreadRead: action(function (this: ChatDraft, kind: ThreadKind, rootKey: string) {
      const row = this.threadInbox[threadRowId(kind, rootKey)];
      if (!row) return;
      if (row.unread > 0 && this.threadUnread > 0) this.threadUnread -= 1;
      row.last_read_at = Math.max(row.last_read_at, row.last_activity_at);
      row.unread = 0;
      row.unread_capped = false;
      row.updated_at = Date.now();
    }),

    // The exclude tombstone is what keeps the card gone: the live listMine
    // subscription can push a page that predates the server delete, and a
    // plain local delete would let that push re-add the row.
    dismissThread: action(function (this: ChatDraft, kind: ThreadKind, rootKey: string) {
      const id = threadRowId(kind, rootKey);
      const row = this.threadInbox[id];
      if (!row) return;
      if (row.unread > 0 && this.threadUnread > 0) this.threadUnread -= 1;
      delete this.threadInbox[id];
      excludeRow(this, "threadInbox", id);
    }),

    // Workspace match is by VALUE with absence normalized: a personal row has
    // no team_id, and the personal workspace has no active team. The same
    // rule useThreadInbox applies when it lists the page.
    // The wire shape is explicit: `kind` is a real kind for a scoped sweep and
    // the literal "all" for the unscoped one. A missing kind is the LEGACY
    // one-argument call, which always meant chat only — absence must not
    // widen a sweep an old bundle asked for.
    markAllThreadsRead: action(function (this: ChatDraft, teamId?: string | null, kind?: ThreadKind | "all") {
      const scope: ThreadKind | undefined = kind === "all" ? undefined : (kind ?? "chat");
      for (const id in this.threadInbox) {
        const row = this.threadInbox[id];
        // Page rows follow the owner into every workspace (threadRowInWorkspace).
        if (row.kind !== "page" && String(row.team_id ?? "") !== String(teamId ?? "")) continue;
        if (scope && row.kind !== scope) continue;
        if (row.unread > 0 && this.threadUnread > 0) this.threadUnread -= 1;
        row.last_read_at = Math.max(row.last_read_at, row.last_activity_at);
        row.unread = 0;
        row.unread_capped = false;
        row.updated_at = Date.now();
      }
      if (!scope) this.threadUnread = 0;
    }),

    // Reconciles the local rows with a fresh first page: a row the server no
    // longer returns inside the page's activity window has been revoked
    // (left room, lost team, purged root) and must leave the client too —
    // listMine can only drop rows silently, and a delta overlay never
    // deletes. Rows older than the page's window are untouched.
    pruneThreadInbox: sync(function (this: ChatDraft, keepIds: string[], teamId: string | undefined | null, floorActivityAt: number) {
      const keep = new Set(keepIds);
      for (const id in this.threadInbox) {
        const row = this.threadInbox[id];
        if (String(row.team_id ?? "") !== String(teamId ?? "")) continue;
        // Carried personal page rows ride the first page on a bounded take,
        // so their absence is not a revocation.
        if (row.kind === "page") continue;
        if (row.last_activity_at < floorActivityAt) continue;
        if (keep.has(id)) continue;
        delete this.threadInbox[id];
      }
    }),

    // A reply on a published page's discussion, from the Threads page. The
    // stub lands in the page's embedded comment list immediately; the server
    // row (artifacts.submitComments via the addPageComment side effect) echoes
    // the client_id and supersedes it in the next listMine push.
    addPageComment: action(function (this: ChatDraft, o: { artifactId: string; text: string; parentId?: string; clientId: string }) {
      const page = this.pageThreads[o.artifactId];
      const text = o.text.trim();
      if (!page || !text) return;
      const me = (this as any).currentUser as { _id?: string; name?: string; github_avatar_url?: string } | undefined;
      const stub: PageCommentRow = {
        _id: `pagecmtstub-${o.clientId}`,
        artifact_id: o.artifactId,
        author_name: me?.name ?? "You",
        author_user_id: me?._id ? String(me._id) : undefined,
        author_avatar: me?.github_avatar_url,
        parent_comment_id: o.parentId,
        client_id: o.clientId,
        text,
        version: 0,
        status: "open",
        created_at: Date.now(),
      };
      page.comments = [...page.comments, stub];
      page.updated_at = stub.created_at;
      const row = this.threadInbox[threadRowId("page", o.artifactId)];
      if (row) {
        row.last_activity_at = stub.created_at;
        row.last_read_at = stub.created_at;
        row.updated_at = stub.created_at;
      }
    }),

    updateChatChannel: action(function (this: ChatDraft, channelId: string, fields: { name?: string; topic?: string }) {
      const channel = this.chatChannels[channelId];
      if (!channel) return;
      // The SERVER's slug rule, so the paint equals the echo. A name that
      // normalizes to nothing is no rename at all.
      if (fields.name !== undefined) {
        const name = normalizeChannelName(fields.name);
        if (name) channel.name = name;
      }
      if (fields.topic !== undefined) channel.topic = fields.topic;
      channel.updated_at = Date.now();
      return { channelId, fields };
    }),

    archiveChatChannel: action(function (this: ChatDraft, channelId: string, archived: boolean) {
      const channel = this.chatChannels[channelId];
      if (!channel) return;
      channel.archived_at = archived ? Date.now() : null;
      channel.updated_at = Date.now();
      return { channelId, archived };
    }),

    addChatChannelMembers: action(function (this: ChatDraft, channelId: string, memberIds: string[]) {
      // Nothing local: the roster lives on the server-derived rail row. The
      // action exists for its dispatch.
      return { channelId, memberIds };
    }),

    removeChatChannelMember: action(function (this: ChatDraft, channelId: string, userId: string) {
      if (userId === viewerId(this)) {
        // Leaving: the room disappears for you now. The server deletes the
        // membership + read rows; locally the channel row goes so the rail and
        // any open tab stop showing a room you cannot re-enter.
        delete this.chatChannels[channelId];
        for (const id in this.chatReads) {
          if (this.chatReads[id]?.channel_id === channelId) delete this.chatReads[id];
        }
      }
      return { channelId, userId };
    }),

    setChannelNotifyLevel: action(function (this: ChatDraft, channelId: string, level: ChatNotifyLevel) {
      upsertRead(this, channelId, { notify_level: level });
    }),

    // ── Channels ────────────────────────────────────────────────────────────

    createChatChannel: (name: string, opts?: ChatCreateChannelOptions) => {
      const clientId = newChatChannelClientId();
      void (get().dispatchCreateChatChannel(clientId, name, opts) as Promise<any>).catch(() => {
        // Delivery is the outbox's problem: the entry is journaled and re-driven.
        // Swallowing here only stops an unhandled rejection.
      });
      return clientId;
    },

    // asyncAction, so a caller that needs the REAL id (a deep link, a follow-up
    // write) can await it. The rail does not: it selects the stub and the altKey
    // supersede carries the selection across. chat.createChannel is idempotent on
    // client_id, so a replayed create returns the same row instead of a twin.
    dispatchCreateChatChannel: asyncAction(function (
      this: ChatDraft,
      clientId: string,
      name: string,
      opts?: ChatCreateChannelOptions,
    ) {
      const now = Date.now();
      this.chatChannels[clientId] = {
        _id: clientId,
        client_id: clientId,
        // chatText's rule, not a local copy: the stub must carry the exact name
        // the server row will arrive with, or the rail renames on echo.
        name: normalizeChannelName(name),
        kind: opts?.kind,
        topic: opts?.topic,
        team_id: opts?.teamId,
        created_by: viewerId(this),
        created_at: now,
        updated_at: now,
      };
      // Creating a channel joins it — the same thing the server does.
      upsertRead(this, clientId, { last_read_at: now, notify_level: "mentions" });
    }),

    // teamId defaults to the workspace the window is looking at — every caller
    // wants that, and one default beats the same read in three surfaces.
    openDmChannel: (memberIds: string[], teamIdArg?: string) => {
      const state = get();
      const uiTeam = (state as any).clientState?.ui?.active_team_id;
      const teamId = teamIdArg ?? (uiTeam ? String(uiTeam) : undefined);
      const viewer = (state as any).currentUser?._id ?? "";
      const dmKey = dmKeyFor(teamId ?? "", [viewer, ...memberIds]);
      // The room may already be here — same tick, real id, no server wait.
      for (const id in state.chatChannels) {
        if (state.chatChannels[id]?.dm_key === dmKey) return id;
      }
      const clientId = newChatChannelClientId();
      void (get().dispatchOpenDm(clientId, memberIds, teamId) as Promise<any>).catch(() => {
        // Delivery is the outbox's problem; see createChatChannel.
      });
      return clientId;
    },

    dispatchOpenDm: asyncAction(function (
      this: ChatDraft,
      clientId: string,
      memberIds: string[],
      teamId?: string,
    ) {
      const now = Date.now();
      const viewer = viewerId(this);
      this.chatChannels[clientId] = {
        _id: clientId,
        client_id: clientId,
        // A DM has no name; every surface derives one from dm_key at render.
        name: "",
        kind: "dm",
        dm_key: dmKeyFor(teamId ?? "", [viewer, ...memberIds]),
        team_id: teamId,
        created_by: viewer,
        created_at: now,
        updated_at: now,
      };
      upsertRead(this, clientId, { last_read_at: now, notify_level: "mentions" });
    }),
  };
}

// ── Sync configuration ──────────────────────────────────────────────────────

/** Spread into SYNC_REGISTRY. Every collection is a delta overlay so one
 *  channel's page never prunes another's, and the two collections with an
 *  optimistic create carry the altKey that supersedes their stub. */
/** Client id for an optimistic page comment (the server dedupes on it). */
export function newPageCommentClientId(): string {
  return `pagecmt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export const CHAT_SYNC_REGISTRY = {
  // The stub carries client_id === its own stub id; the server row arrives with
  // the same client_id and rekeys the stub onto the real _id.
  chatChannels: { isDelta: true, altKey: "client_id" },
  chatMessages: {
    isDelta: true,
    altKey: "client_id",
    // Retire the tombstone of a discarded send that delivered anyway. Its stub is
    // gone, so the altKey rekey never sees it and the entry would sit in the
    // persisted pending map forever. Clearing it is also what lets the delivered
    // message render as the ordinary sent message it now is — see
    // discardChatSend for why that is the honest outcome.
    transform: (draft: any, _table: any, incoming: ChatMessageRow[]) => {
      for (const row of incoming) {
        const clientId = row?.client_id;
        if (clientId && draft.pending[`chatMessages:${clientId}`]) {
          delete draft.pending[`chatMessages:${clientId}`];
        }
      }
    },
  },
  // One row per (viewer, channel), so the channel is the natural key — the same
  // shape bucketAssignments uses for its per-conversation row.
  chatReads: { isDelta: true, altKey: "channel_id" },
  // Server thread rollups (listMessages.threads): a derived snapshot cache,
  // transient — overlaid at render, the local rows winning when fresher.
  // Delta: each page contributes its roots without pruning other channels'.
  chatThreadSummaries: { isDelta: true },
  // No client_id column server-side: a reaction has no identity beyond
  // (message, user, emoji). chatReactionSyncOpts supersedes on that instead.
  chatReactions: { isDelta: true },
  chatRail: { kind: "list" as const },
};

/**
 * Sync options for a reaction push whose payload is the COMPLETE server set for
 * a known group of messages — which is what chat.listMessages and chat.getThread
 * return alongside their page.
 *
 * Three things happen that a plain delta cannot do:
 *   - a row absent from the page is a real removal (someone took their reaction
 *     back), so it is pruned rather than kept forever;
 *   - the exclude tombstone from this viewer's own optimistic un-react has done
 *     its job once the server agrees, so it is retired instead of accumulating
 *     one dead entry per reaction ever removed;
 *   - an optimistic stub whose real row has arrived is dropped, which is the
 *     supersede a client_id altKey would do if the table had one.
 */
export function chatReactionSyncOpts(messageIds: Iterable<string>) {
  const scope = new Set<string>();
  for (const id of messageIds) scope.add(String(id));
  return {
    isDelta: true,
    pruneAbsentScope: (row: any) => scope.has(String(row?.message_id)),
    transform: (draft: any, table: Record<string, ChatReactionRow>, incoming: ChatReactionRow[]) => {
      const confirmed = new Set<string>();
      for (const row of incoming) {
        confirmed.add(`${row.message_id}\x1f${row.user_id}\x1f${row.emoji}`);
      }
      for (const id of Object.keys(table)) {
        const row = table[id];
        if (!row || !scope.has(String(row.message_id))) continue;
        if (isConvexId(id)) continue;
        // A stub whose server twin is in this authoritative page.
        if (confirmed.has(`${row.message_id}\x1f${row.user_id}\x1f${row.emoji}`)) {
          delete table[id];
          delete draft.pending[`chatReactions:${id}`];
        }
      }
      // Retire tombstones the server has now confirmed. The row is already out of
      // `table` (pruned above, or never re-added), and prev no longer holds it, so
      // nothing can bring it back.
      const prefix = "chatReactions:";
      for (const key of Object.keys(draft.pending)) {
        if (!key.startsWith(prefix)) continue;
        const id = key.slice(prefix.length);
        if (id.includes(":")) continue; // a field entry, not a record tombstone
        if (table[id]) continue;
        delete draft.pending[key];
      }
    },
  };
}

// ── Selectors ───────────────────────────────────────────────────────────────

const EMPTY_MESSAGES: ChatMessageRow[] = [];

function byCreatedAsc(a: ChatMessageRow, b: ChatMessageRow): number {
  return a.created_at - b.created_at || (a._id < b._id ? -1 : a._id > b._id ? 1 : 0);
}

/** A channel's timeline: roots only, oldest first. Thread replies live in the
 *  thread panel, so folding them into the channel would show every reply twice. */
export function selectChannelMessages(
  state: Pick<ChatSliceData, "chatMessages">,
  channelId: string,
): ChatMessageRow[] {
  if (!channelId) return EMPTY_MESSAGES;
  const out: ChatMessageRow[] = [];
  for (const id in state.chatMessages) {
    const row = state.chatMessages[id];
    if (row.channel_id !== channelId) continue;
    // A reply stays in its thread panel — unless it was also sent to the
    // channel (Slack's broadcast), in which case it appears in both.
    if (row.thread_root_id && !row.broadcast) continue;
    out.push(row);
  }
  return out.sort(byCreatedAsc);
}

/** A thread's replies, oldest first. The root is read by id — it is a channel
 *  row, and putting it in both halves is how a root ends up rendered twice. */
export function selectThreadReplies(
  state: Pick<ChatSliceData, "chatMessages">,
  rootId: string,
): ChatMessageRow[] {
  if (!rootId) return EMPTY_MESSAGES;
  const out: ChatMessageRow[] = [];
  for (const id in state.chatMessages) {
    const row = state.chatMessages[id];
    if (row.thread_root_id === rootId) out.push(row);
  }
  return out.sort(byCreatedAsc);
}

/** Everyone's reactions to one message, folded into the pills the message row
 *  renders. The counting rule lives in ONE place — lib/chatViews' foldReactions,
 *  which the sync layer already calls with rows it holds. This selector is the
 *  entry point for a caller that has the whole map instead: it filters, then
 *  delegates. Two copies of "count distinct users" is how a stub and its server
 *  twin end up counted twice on one surface and once on the other. */
export function selectChatReactions(
  state: Pick<ChatSliceData, "chatReactions">,
  messageId: string,
  viewer: string,
  nameOf?: (userId: string) => string | undefined,
): ChatReaction[] {
  const rows: ChatReactionRow[] = [];
  for (const id in state.chatReactions) {
    const row = state.chatReactions[id];
    if (row.message_id === messageId) rows.push(row);
  }
  return foldReactions(rows, viewer, nameOf);
}

/** The newest message in a channel, REPLIES INCLUDED — the read marker.
 *
 *  The transcript shows roots only, so the newest row on screen is not the
 *  newest thing in the room. The rail's unread tally counts every row with this
 *  channel_id, replies among them, so a marker taken from the newest root can
 *  never clear a badge raised by a thread reply. Both halves have to count the
 *  same set; this is that set. */
export function selectChannelReadMarker(
  state: Pick<ChatSliceData, "chatMessages">,
  channelId: string,
): ChatMessageRow | undefined {
  let newest: ChatMessageRow | undefined;
  for (const id in state.chatMessages) {
    const row = state.chatMessages[id];
    if (row.channel_id !== channelId) continue;
    if (!newest || byCreatedAsc(newest, row) < 0) newest = row;
  }
  return newest;
}

export type ChatRailChannel = ChatChannelView & {
  /** What the rail sorts by: the newest message, or the channel's creation. */
  sortAt: number;
  notifyLevel: ChatNotifyLevel;
  joined: boolean;
  lastReadAt?: number;
  lastMessagePreview?: string;
  /** When the other person in a DM last spoke; undefined when they never have
   *  (or this is not a DM). A surface that keys presence to inbound activity
   *  reads this, never sortAt. */
  lastInboundAt?: number;
  unreadCapped?: boolean;
  /** The server's rail summary attests this room has NO messages. Distinct
   *  from "no rail row" (channel the client has never synced — genuinely
   *  unknown): a known-empty room renders its empty state instantly instead
   *  of a skeleton while the messages subscription answers. */
  knownEmpty?: boolean;
};

type ChatRailState = ChatSliceData;

let railCacheKey: unknown[] = [];
let railCacheValue: ChatRailChannel[] = [];

/**
 * The channel rail: unarchived channels, newest activity first, each with the
 * two numbers the rail is allowed to show.
 *
 * The counts come from `tallyUnread` over the messages this client actually
 * holds — that is what makes a badge clear the instant the viewer reads, and
 * what counts a teammate's line that arrived while the channel was open. Mixing
 * the two any other way (a max, a sum) would invent a number neither side
 * believes.
 *
 * BUT the local page is only allowed to answer when it REACHES THE NEWEST
 * MESSAGE. chatMessages is persisted and hydrates from IndexedDB at boot, while
 * only the open channel is subscribed — so after a reload every channel visited
 * before holds a stale page, and tallying it would return 0 while the server
 * says 12. The page reaches the tip when it holds the rail's own newest message,
 * or when its newest row is at least as new as the rail's sort stamp (an
 * optimistic send the rail has not caught up with). Otherwise the server's
 * number stands — except when this viewer's read mark is already at or past
 * that newest activity, which means nothing the server knows about is unread and
 * the badge must clear without waiting for a round trip.
 *
 * Memoized on the collection refs: the rail is always mounted, and these maps
 * change far less often than the store around them.
 */
export function selectChatRail(
  state: ChatRailState,
  viewer: string,
  /** The active workspace, by lib/workspaceScope's ONE rule: a team id shows
   *  that team's channels; undefined is the PERSONAL workspace — and channels
   *  are team-tagged by construction, so personal shows none. Re-asserted at
   *  read time exactly like tasks/docs/plans, because the channel cache
   *  accumulates across team switches. */
  teamId?: string | null,
): ChatRailChannel[] {
  const key = [state.chatChannels, state.chatMessages, state.chatReads, state.chatRail, viewer, teamId];
  if (key.length === railCacheKey.length && key.every((v, i) => v === railCacheKey[i])) {
    return railCacheValue;
  }

  const readByChannel = new Map<string, ChatReadRow>();
  for (const id in state.chatReads) {
    const row = state.chatReads[id];
    const prev = readByChannel.get(row.channel_id);
    // A hydrated stub can outlive its server row for one sync; the newer stamp
    // is the one the viewer last acted on.
    if (!prev || prev.updated_at <= row.updated_at) readByChannel.set(row.channel_id, row);
  }

  const railByChannel = new Map<string, ChatRailRow>();
  for (const row of state.chatRail ?? []) railByChannel.set(String(row.channel_id), row);

  const messagesByChannel = new Map<string, ChatMessageRow[]>();
  for (const id in state.chatMessages) {
    const row = state.chatMessages[id];
    const list = messagesByChannel.get(row.channel_id);
    if (list) list.push(row);
    else messagesByChannel.set(row.channel_id, [row]);
  }

  const out: ChatRailChannel[] = [];
  for (const id in state.chatChannels) {
    const channel = state.chatChannels[id];
    if (channel.archived_at) continue;
    if (!inActiveWorkspace({ team_id: channel.team_id ? String(channel.team_id) : undefined }, teamId ? String(teamId) : undefined)) continue;
    const read = readByChannel.get(id);
    const rail = railByChannel.get(id);
    const loaded = messagesByChannel.get(id);
    const isDm = channel.kind === "dm";

    let unread = rail?.unread ?? 0;
    let mentions = rail?.unread_mentions ?? 0;
    let sortAt = rail?.sort_at ?? channel.created_at;

    // Does the page we hold reach the newest message the server knows about?
    let newestLocal = 0;
    for (const m of loaded ?? []) if (m.created_at > newestLocal) newestLocal = m.created_at;
    const railTipId = rail?.last_message?._id;
    const reachesTip =
      !rail ||
      (railTipId ? !!state.chatMessages[railTipId] : true) ||
      newestLocal >= (rail.sort_at ?? 0);

    if (!reachesTip && read && read.last_read_at >= (rail?.sort_at ?? 0)) {
      // The mark is past everything the server has. Nothing is unread, whatever
      // the last rail push said.
      unread = 0;
      mentions = 0;
    }

    if (loaded && loaded.length > 0 && reachesTip) {
      const tally = tallyUnread(
        loaded.map((m) => ({
          createdAt: m.created_at,
          authorId: m.user_id,
          // In a DM every line is addressed to the viewer — the local tally
          // mirrors the server's rail rule exactly.
          mentionsViewer:
            isDm || m.mention_scope === "here" || !!m.mentions?.includes(viewer),
          deletedAt: m.deleted_at,
          // Engages the server-mirrored rule: replies do not tick the channel
          // number; mentions count wherever they live.
          threadRootId: m.thread_root_id,
          // A teammate mid-burst is heard, not missed: the badge waits for the
          // release, exactly as the rail's count does.
          voiceLive: isLiveVoiceRow(m),
        })),
        read?.last_read_at,
        viewer,
      );
      unread = tally.unread;
      mentions = tally.mentions;
      for (const m of loaded) if (m.created_at > sortAt) sortAt = m.created_at;
    }

    const notifyLevel = read?.notify_level ?? rail?.notify_level ?? "mentions";
    // Who else is in the room: the dm_key names the set (works for stubs the
    // rail has never seen); the rail's roster covers private channels.
    let dmMemberIds: string[] | undefined;
    if (isDm) {
      const fromKey = channel.dm_key ? dmOtherIds(channel.dm_key, viewer) : undefined;
      dmMemberIds = fromKey ?? rail?.member_ids?.filter((uid) => uid !== viewer);
    }
    out.push({
      id,
      name: channel.name,
      kind: channel.kind,
      isPrivate: channel.kind === "private",
      dmMemberIds,
      memberIds: rail?.member_ids,
      topic: channel.topic,
      unreadCount: unread,
      mentionCount: mentions,
      muted: notifyLevel === "none",
      teamId: channel.team_id,
      sortAt,
      notifyLevel,
      joined: !!read || !!rail?.joined,
      lastReadAt: read?.last_read_at,
      lastMessagePreview: rail?.last_message?.preview,
      lastInboundAt: rail?.last_inbound?.created_at,
      unreadCapped: loaded && loaded.length > 0 && reachesTip ? false : rail?.unread_capped,
      // The rail row and the channel row arrive in the same listChannels
      // payload, so a freshly created DM is attested empty in the same sync
      // batch that supersedes its stub — no gap for a skeleton to flash in.
      knownEmpty: !!rail && !rail.last_message,
    });
  }

  out.sort((a, b) => b.sortAt - a.sortAt || a.name.localeCompare(b.name));
  railCacheKey = key;
  railCacheValue = out;
  return out;
}

/** Test seam: the rail memo is module-level, so a test that rebuilds the same
 *  object shapes would otherwise read a previous run's answer. */
export function _resetChatRailMemo(): void {
  railCacheKey = [];
  railCacheValue = [];
}
