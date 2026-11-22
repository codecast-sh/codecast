// Read-side selectors over the chat slice's collections: a channel's
// timeline, a thread, reactions, read markers and the channel rail.
import { inActiveWorkspace } from "../lib/workspaceScope";
import { dmOtherIds, dmWatcher, isSettledLine, isThreadMuted, plainPreview } from "@codecast/shared/chat";
import { mirrorState } from "@codecast/convex/convex/lib/slackMirror";
import { isConvexId } from "../lib/entityLinks";
import { tallyUnread } from "../lib/chatTimeline";
import { foldReactions } from "../lib/chatViews";
import type { ChatChannelView, ChatReaction } from "../components/chat/chatTypes";
import type { ChatMessageRow, ChatNotifyLevel, ChatReactionRow, ChatRailRow, ChatReadRow, ChatSliceData } from "./chatSlice";

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

/** Whether the viewer muted this thread's replies (their read row for the
 *  thread's channel holds the list). */
export function selectThreadMuted(
  state: Pick<ChatSliceData, "chatReads">,
  channelId: string,
  rootId: string,
): boolean {
  for (const id in state.chatReads) {
    const row = state.chatReads[id];
    if (row?.channel_id === channelId) return isThreadMuted(row.muted_threads, rootId);
  }
  return false;
}

export type ChatRailChannel = ChatChannelView & {
  /** What the rail sorts by: the newest message, or the channel's creation. */
  sortAt: number;
  notifyLevel: ChatNotifyLevel;
  joined: boolean;
  lastReadAt?: number;
  lastMessagePreview?: string;
  /** The newest message was an agent's (the phone marks its preview). */
  lastMessageFromAgent?: boolean;
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
 * Everything a room shows comes from the messages this client HOLDS: the
 * preview, its time, the unread badge and the mention count. That is the
 * contract the rail makes: whatever it shows, opening the room already has,
 * because the room renders the same rows. A badge also clears the instant the
 * viewer reads, and a teammate's line that arrived while the room was open
 * counts at once.
 *
 * The server's rail row (chat.listChannels) says where each room has got to.
 * When its newest line is not held, the prefetcher (lib/chatPrefetch) fetches
 * the rows behind it, and the room moves on the rail when they land. Until
 * then the room shows what is held, and a room with nothing held shows no
 * preview and no badge.
 *
 * Memoized on the collection refs: the rail is always mounted, and these maps
 * change far less often than the store around them.
 */
/** Which rooms a rail shows. "team" is the active workspace's rooms; "community"
 *  is the public site's rooms (kind "community"), whatever team routes them
 *  and whether or not the viewer has a workspace at all. */
export type ChatRailScope = "team" | "community";

export function selectChatRail(
  state: ChatRailState,
  viewer: string,
  /** The active workspace, by lib/workspaceScope's ONE rule: a team id shows
   *  that team's channels; undefined is the PERSONAL workspace — and channels
   *  are team-tagged by construction, so personal shows none. Re-asserted at
   *  read time exactly like tasks/docs/plans, because the channel cache
   *  accumulates across team switches. Ignored in community scope. */
  teamId?: string | null,
  scope: ChatRailScope = "team",
  /** The server has answered listChannels in this page load, so its rail is
   *  the complete set of rooms and absence from it means the room is gone.
   *  False while only the cached rail is known, where absence means nothing. */
  railLive = false,
): ChatRailChannel[] {
  const key = [state.chatChannels, state.chatMessages, state.chatReads, state.chatRail, state.chatSlackLinks, viewer, teamId, scope, railLive];
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

  // One mirror per channel (the server refuses a second). The row carries the
  // Slack name for the tooltip and the state for the mark's colour.
  const slackByChannel = new Map<string, ChatChannelView["slack"]>();
  for (const id in state.chatSlackLinks ?? {}) {
    const link = state.chatSlackLinks[id];
    slackByChannel.set(String(link.chat_channel_id), {
      name: link.slack_channel_name ?? link.slack_channel_id,
      state: mirrorState(link),
    });
  }

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
    // The channel cache only ever grows, so it keeps rooms the server has
    // stopped listing: two direct message rooms that merged when one Slack
    // person turned out to be a teammate, or a room access was removed from.
    // The live rail is the complete set, so it decides. A stub whose server
    // row has not arrived yet is not in the rail and must survive.
    if (railLive && isConvexId(id) && !railByChannel.has(id)) continue;
    if (scope === "community") {
      if (channel.kind !== "community") continue;
    } else if (!inActiveWorkspace({ team_id: channel.team_id ? String(channel.team_id) : undefined }, teamId ? String(teamId) : undefined)) continue;
    const read = readByChannel.get(id);
    const rail = railByChannel.get(id);
    const loaded = messagesByChannel.get(id);
    const isDm = channel.kind === "dm";

    // The room as this client HOLDS it. The preview, its time, the unread
    // badge and the mention count all come from these rows, so whatever the
    // rail shows, opening the room shows too. The server's summary only says
    // where the room has got to; the prefetcher (lib/chatPrefetch) fetches the
    // rows behind it, and the rail moves when they land.
    let newest: ChatMessageRow | undefined;
    let shown: ChatMessageRow | undefined;
    let inbound: ChatMessageRow | undefined;
    for (const m of loaded ?? []) {
      if (!isSettledLine(m)) continue;
      if (!newest || byCreatedAsc(newest, m) < 0) newest = m;
      // The preview is a line the room's timeline shows: a root, or a reply
      // also sent to the channel. A reply alone lives in its thread.
      if ((!m.thread_root_id || m.broadcast) && (!shown || byCreatedAsc(shown, m) < 0)) shown = m;
      if (isDm && m.user_id !== viewer && (!inbound || byCreatedAsc(inbound, m) < 0)) inbound = m;
    }
    const held = !!loaded && loaded.length > 0;
    const tally = held ? tallyUnread(loaded!, read?.last_read_at, viewer, { isDm }) : { unread: 0, mentions: 0 };
    const unread = tally.unread;
    const mentions = tally.mentions;
    // Nothing held yet (a cold cache): the server's stamp orders the room, and
    // it shows no preview until its rows arrive.
    const sortAt = newest ? Math.max(newest.created_at, channel.created_at) : (rail?.sort_at ?? channel.created_at);
    // Held rows that reach the server's newest line while the server counts
    // past its cap: the badge says "N+".
    const reachesTip = !!rail?.last_message && !!state.chatMessages[rail.last_message._id];
    const unreadCapped = reachesTip && unread > 0 && !!rail?.unread_capped;

    const notifyLevel = read?.notify_level ?? rail?.notify_level ?? "mentions";
    // Who else is in the room: the dm_key names the set (works for stubs the
    // rail has never seen); the rail's roster covers private channels.
    let dmMemberIds: string[] | undefined;
    const dmWatching = isDm && dmWatcher(channel.dm_key, viewer);
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
      ...(dmWatching ? { dmWatching } : {}),
      memberIds: rail?.member_ids,
      agents: rail?.agents,
      topic: channel.topic,
      unreadCount: unread,
      mentionCount: mentions,
      muted: notifyLevel === "none",
      teamId: channel.team_id,
      slack: slackByChannel.get(id),
      sortAt,
      notifyLevel,
      joined: !!read || !!rail?.joined,
      lastReadAt: read?.last_read_at,
      lastMessagePreview: shown ? plainPreview(shown.content ?? "", 120) : undefined,
      lastMessageFromAgent: shown?.author_kind === "agent",
      lastInboundAt: held ? inbound?.created_at : rail?.last_inbound?.created_at,
      unreadCapped,
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
