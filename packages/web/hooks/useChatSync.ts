// Chat's sync layer: Convex queries in, store collections out.
//
// Same shape as every other feed in the app (useSyncBuckets, useConversationComments):
// useQuery → useConvexSync → syncTable. Two things are chat-specific.
//
// PAGING. The newest window of a channel is a LIVE subscription; older pages are
// one-shot `convex.query()` calls overlaid as deltas — the same split
// reconcileCrawl uses, and for the same reason: one live subscription per
// history page is how a busy team saturates the backend. History does not
// change, so a subscription on it buys nothing.
//
// WAKE SIGNATURES. chatMessages and chatReactions carry a `transform`, which
// bypasses syncTable's no-change early return — so every push hands back a new
// collection ref even when nothing changed. An always-mounted reader subscribed
// to the raw map would re-render on all of it. Every reader below therefore
// subscribes to a SIGNATURE of the fields it renders (store/wakeSig.ts) and
// reads the raw collection in the body.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useIsSyncHost } from "./useSyncRole";
import { useConvex } from "convex/react";
import { useRouter } from "next/navigation";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import {
  useInboxStore,
  useTrackedStore,
  selectChatRail,
  selectChannelMessages,
  selectThreadReplies,
  chatReactionSyncOpts,
  chatSendState,
  type ChatMessageRow,
  type ChatChannelRow,
  type ChatReactionRow,
  type ChatReadRow,
  type ChatRailRow,
  type ChatRailChannel,
} from "../store/inboxStore";
import { makeCollectionSig } from "../store/wakeSig";
import { memberListSig } from "./useTeamRoster";
import { useConvexSync } from "./useConvexSync";
import { useQueryNoThrow } from "./useQueryNoThrow";
import { useTeamFeature } from "../lib/teamFeatures";
import { markChatRailLive } from "../lib/chatLive";
import { isConvexId } from "../lib/entityLinks";
import {
  buildHandleSets,
  foldReactions,
  memberName,
  threadRollups,
  toMessageViews,
  type ChatMember,
  type HandleSets,
} from "../lib/chatViews";
import type { ChatMessageView } from "../components/chat/chatTypes";
import { prefetchStorageImageUrls } from "./useStorageImageUrl";

const api = _api as any;

/** Warm the image cache (id→URL mapping AND bytes) for every image attachment
 *  in a batch of ingested messages — so the history a channel just loaded
 *  paints its images from local cache, online or off. Audio stays out: a
 *  recording resolves its URL when its play button mounts. */
function prefetchAttachmentImages(convex: ReturnType<typeof useConvex>, messages: ChatMessageRow[]): void {
  const ids: string[] = [];
  for (const m of messages) {
    for (const a of m.attachments ?? []) {
      if (a.storage_id && !a.mime?.startsWith("audio/")) ids.push(a.storage_id);
    }
  }
  if (ids.length) prefetchStorageImageUrls(convex, ids);
}

/** One live page. Deliberately at the server's own default so a cold open costs
 *  one round trip and lands on a full screen of history. */
const PAGE_SIZE = 50;

// ── Signatures ──────────────────────────────────────────────────────────────

/** Cheap content digest. Included so a same-length edit still wakes the reader;
 *  the raw string is not, because a channel of 8k-character messages would
 *  rebuild a 400KB signature on every push. */
function hash(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return h;
}

/** Everything a TRANSCRIPT renders, message text included. Only the chat page's
 *  own readers subscribe to this.
 *
 *  `voice` and `attachments` are in here because a walkie burst finalizes by
 *  changing ONLY those: status live -> done, the duration, and the recording
 *  arriving as an attachment. The words stream into `content` while the key is
 *  still down, so at release the content hash usually does not move — leaving
 *  them out hashed a finished burst identically to a live one and left the
 *  sender's own bubble pulsing "talking…" until a reload.
 *
 *  `voice.transcribing` is in here for the same reason, one step later. When the
 *  live recognizer heard nothing, the sender's own optimistic row has ALREADY
 *  flipped status to done and written the duration, so the server echo that
 *  turns transcribing on changes that one field and nothing else. Without it in
 *  the hash the echo is a no-op, the bubble never repaints, and "getting the
 *  words" — the whole point of the state — is unreachable on the screen that
 *  needs it most. Verified live: the flag reached the store and the bubble
 *  still read "no words" until the words themselves landed. */
export const messagesSig = makeCollectionSig<ChatMessageRow>(
  (m) =>
    `${m._id}|${m.channel_id}|${m.thread_root_id ?? ""}|${m.user_id}|${m.author_kind ?? ""}` +
    `|${m.created_at}|${m.edited_at ?? 0}|${m.deleted_at ?? 0}|${m.agent_status ?? ""}` +
    `|${m._failedAt ?? 0}|${m.mention_scope ?? ""}|${(m.mentions ?? []).join(",")}` +
    `|${m.content.length}:${hash(m.content)}` +
    `|${m.voice ? `${m.voice.status}:${m.voice.duration_ms ?? 0}:${m.voice.room_key ?? ""}:${m.voice.transcribing ? 1 : 0}` : ""}` +
    `|${(m.attachments ?? []).map((a) => a.storage_id).join(",")}`,
);

/** What the RAIL counts, and nothing else.
 *
 *  The rail's readers — the sidebar row and the tab title badge — are mounted on
 *  every page of the app, and neither renders a single character of message
 *  text. Folding the content hash into their wake signature made an agent
 *  streaming an answer into a channel nobody is looking at re-render both of
 *  them per chunk and re-tally every message in the store. Subscribe to the
 *  fields you branch on: that is the whole rule (see CLAUDE.md).
 *
 *  `voice.status` IS a field the rail branches on: tallyUnread skips live
 *  voice rows (the badge waits for the release), so a burst that finalizes by
 *  flipping only voice.status changes the unread count. Leaving it out froze
 *  the badge until unrelated activity touched the channel. Status only — the
 *  rail renders neither the duration nor the recording. */
export const railMessagesSig = makeCollectionSig<ChatMessageRow>(
  (m) =>
    `${m._id}|${m.channel_id}|${m.user_id}|${m.created_at}|${m.deleted_at ?? 0}` +
    `|${m.mention_scope ?? ""}|${(m.mentions ?? []).join(",")}|${m.voice?.status ?? ""}`,
);

/** What a session PERSONA on a chat line renders (chatViews sessionAuthorFor):
 *  the session's current title and agent, keyed by session id. Sessions
 *  heartbeat about once a second, so the transcript must never subscribe to the
 *  raw collection — this wakes it only when a session is renamed, retyped, or
 *  appears. */
const sessionOriginSig = makeCollectionSig<any>(
  (s) => `${s.session_id ?? ""}|${s.display_title || s.title || ""}|${s.agent_type ?? ""}`,
);

const channelsSig = makeCollectionSig<ChatChannelRow>(
  (c) => `${c._id}|${c.client_id ?? ""}|${c.name}|${c.topic ?? ""}|${c.archived_at ?? 0}|${c.created_at}`,
);

const readsSig = makeCollectionSig<ChatReadRow>(
  (r) => `${r._id}|${r.channel_id}|${r.last_read_at}|${r.notify_level}|${r.joined_at ?? 0}`,
);

export const reactionsSig = makeCollectionSig<ChatReactionRow>(
  (r) => `${r._id}|${r.message_id}|${r.user_id}|${r.emoji}`,
);

function railSig(rail: ChatRailRow[]): string {
  let out = "";
  for (const r of rail ?? []) {
    out += `${r.channel_id}|${r.sort_at}|${r.unread}|${r.unread_mentions}|${r.notify_level}|${r.joined}|${r.last_message?._id ?? ""};`;
  }
  return out;
}

// teamMembers is an ARRAY that re-pushes on teammates' presence heartbeats, so it
// gets the same treatment: subscribe to the shared identity signature.

// ── Channels, reads, rail ───────────────────────────────────────────────────

/**
 * The team's channels, this viewer's read rows, and the server's own unread
 * numbers. ONE subscription, mounted app-wide (DashboardSyncEffects) rather than
 * on the chat page: the rail badges, the sidebar badge and the arrival toasts
 * all need it whether or not chat is open.
 */
export function useChatChannelsSync(): { error?: Error } {
  const teamId = useInboxStore((s) => s.clientState.ui?.active_team_id) as string | undefined;
  const syncTable = useInboxStore((s) => s.syncTable);
  // Chat is a per-team opt-in. Off = no subscription AND an empty rail, so the
  // unread badge, the title count and the arrival toasts — which all read the
  // rail — go quiet along with the nav row. The server refuses the query for
  // an off team anyway; skipping it keeps the console clean.
  const chatOn = useTeamFeature("chat");
  const isSyncHost = useIsSyncHost();
  useEffect(() => {
    if (!chatOn) syncTable("chatRail", []);
  }, [chatOn, syncTable]);
  // useQueryNoThrow, not useQuery: chat is local-first — the components read the
  // STORE, and this subscription only feeds it. A backend that is down (or a
  // client running ahead of a deploy) must leave the reader with the cached
  // channels they already had, not unmount the surface into an ErrorBoundary.
  const { data: result, error } = useQueryNoThrow(
    api.chat.listChannels,
    // Explicit team or nothing. Passing {} lets the SERVER pick a team from
    // users.active_team_id — a second source of truth that can disagree with
    // the workspace the client is actually showing. In the personal workspace
    // chat has no scope at all, so there is nothing to subscribe to.
    // Follower windows receive the channel rail over replication instead.
    chatOn && isSyncHost && teamId && isConvexId(teamId) ? { team_id: teamId } : "skip",
  );

  useConvexSync(
    result,
    useCallback(
      (data: any) => {
        if (!data) return;
        syncTable("chatChannels", data.channels ?? []);
        syncTable("chatReads", data.reads ?? []);
        syncTable("chatRail", data.rail ?? []);
        // This rail came from the server, not from IndexedDB. Only now is a
        // change in it evidence that something ARRIVED — see lib/chatLive.
        markChatRailLive();
      },
      [syncTable],
    ),
  );

  // Handed back rather than dropped: the rail itself degrades to its cached
  // rows (that is the whole point of useQueryNoThrow here), but a caller that
  // wants to say so has the fact.
  return { error };
}

// ── One channel's messages ──────────────────────────────────────────────────

export type ChannelFeed = {
  /** The first page has not landed yet. */
  loading: boolean;
  /** The query failed terminally. `loading` is false in this state: an errored
   *  query never resolves, so a caller that only watches `loading` waits for a
   *  page that is never coming and renders a blank rectangle forever. */
  error?: Error;
  hasMoreAbove: boolean;
  isLoadingOlder: boolean;
  loadOlder: () => void;
  /** One-shot refetch of the newest page, for the error state's retry. The live
   *  subscription cannot be re-armed (its args have not changed), but the store
   *  is what the surface renders, so filling it is a real recovery. */
  retry: () => void;
};

/**
 * The newest page of a channel, live, plus backwards paging on demand.
 *
 * Older pages are fetched once and overlaid as deltas — a channel's collection
 * only ever grows here, which is what lets the store hold three open channels at
 * once without any of them pruning the others.
 */
export function useChannelMessagesSync(channelId: string | undefined): ChannelFeed {
  const syncTable = useInboxStore((s) => s.syncTable);
  const convex = useConvex();
  const live = channelId && isConvexId(channelId);
  const { data: result, error: queryError } = useQueryNoThrow(
    api.chat.listMessages,
    live ? { channel_id: channelId, limit: PAGE_SIZE } : "skip",
  );
  const [recovered, setRecovered] = useState(false);

  // The cursor the NEXT older page starts at. Seeded from the live page, then
  // advanced by each fetch. Reset whenever the channel changes.
  const [olderCursor, setOlderCursor] = useState<string | null>(null);
  const [olderExhausted, setOlderExhausted] = useState(false);
  const [isLoadingOlder, setIsLoadingOlder] = useState(false);
  const channelRef = useRef(channelId);
  if (channelRef.current !== channelId) {
    channelRef.current = channelId;
    // Synchronous during render on a channel switch, so the first paint of the
    // new channel never inherits the old one's paging state.
    if (olderCursor !== null) setOlderCursor(null);
    if (olderExhausted) setOlderExhausted(false);
    if (isLoadingOlder) setIsLoadingOlder(false);
    if (recovered) setRecovered(false);
  }

  useConvexSync(
    result,
    useCallback(
      (data: any) => {
        if (!data) return;
        const messages: ChatMessageRow[] = data.messages ?? [];
        syncTable("chatMessages", messages);
        syncTable(
          "chatReactions",
          data.reactions ?? [],
          chatReactionSyncOpts(messages.map((m) => m._id)),
        );
        // The server's per-root reply rollups. Without them a thread this
        // client never opened shows NO affordance at all — the anchor answers
        // and the room looks like it ignored you.
        syncTable(
          "chatThreadSummaries",
          (data.threads ?? []).map((t: any) => ({ ...t, _id: String(t.root_id) })),
        );
        prefetchAttachmentImages(convex, messages);
        // Only seed the history cursor; never let a live re-push rewind a
        // cursor the reader has already paged past.
        setOlderCursor((prev) => (prev === null ? (data.next_cursor ?? null) : prev));
      },
      [syncTable, convex],
    ),
  );

  const loadOlder = useCallback(() => {
    if (!live || !olderCursor || isLoadingOlder || olderExhausted) return;
    const forChannel = channelId;
    setIsLoadingOlder(true);
    void convex
      .query(api.chat.listMessages, { channel_id: forChannel, cursor: olderCursor, limit: PAGE_SIZE })
      .then((page: any) => {
        // The reader switched channels while the page was in flight — its rows
        // belong to a channel nothing is showing, so drop them.
        if (channelRef.current !== forChannel) return;
        const messages: ChatMessageRow[] = page?.messages ?? [];
        useInboxStore.getState().syncTable("chatMessages", messages);
        useInboxStore
          .getState()
          .syncTable("chatReactions", page?.reactions ?? [], chatReactionSyncOpts(messages.map((m) => m._id)));
        useInboxStore
          .getState()
          .syncTable("chatThreadSummaries", (page?.threads ?? []).map((t: any) => ({ ...t, _id: String(t.root_id) })));
        prefetchAttachmentImages(convex, messages);
        setOlderCursor(page?.next_cursor ?? null);
        if (!page?.has_more) setOlderExhausted(true);
      })
      .catch(() => {
        // Leave the cursor where it was: the affordance stays, and the next
        // click retries. A silent permanent "no more history" would be a lie.
      })
      .finally(() => {
        if (channelRef.current === forChannel) setIsLoadingOlder(false);
      });
  }, [convex, live, channelId, olderCursor, isLoadingOlder, olderExhausted]);

  const retry = useCallback(() => {
    if (!live) return;
    const forChannel = channelId;
    void convex
      .query(api.chat.listMessages, { channel_id: forChannel, limit: PAGE_SIZE })
      .then((page: any) => {
        if (channelRef.current !== forChannel) return;
        const messages: ChatMessageRow[] = page?.messages ?? [];
        useInboxStore.getState().syncTable("chatMessages", messages);
        useInboxStore
          .getState()
          .syncTable("chatReactions", page?.reactions ?? [], chatReactionSyncOpts(messages.map((m) => m._id)));
        prefetchAttachmentImages(convex, messages);
        setOlderCursor((prev) => (prev === null ? (page?.next_cursor ?? null) : prev));
        setRecovered(true);
      })
      .catch(() => {
        // Still broken. The error state stays up and the button stays live.
      });
  }, [convex, live, channelId]);

  const error = queryError && !recovered ? queryError : undefined;
  return {
    loading: !!live && result === undefined && !error,
    error,
    hasMoreAbove: !!olderCursor && !olderExhausted,
    isLoadingOlder,
    loadOlder,
    retry,
  };
}

// ── One thread ──────────────────────────────────────────────────────────────

/** A thread's root and replies, live. Threads are short by construction (the
 *  server's page is 200), so this has no backwards paging of its own. */
export function useThreadSync(rootId: string | undefined): { loading: boolean; error?: Error } {
  const syncTable = useInboxStore((s) => s.syncTable);
  const convex = useConvex();
  const live = rootId && isConvexId(rootId);
  const { data: result, error } = useQueryNoThrow(api.chat.getThread, live ? { root_id: rootId } : "skip");

  useConvexSync(
    result,
    useCallback(
      (data: any) => {
        if (!data) return;
        const rows: ChatMessageRow[] = [...(data.root ? [data.root] : []), ...(data.replies ?? [])];
        if (rows.length) syncTable("chatMessages", rows);
        syncTable(
          "chatReactions",
          data.reactions ?? [],
          chatReactionSyncOpts(rows.map((m) => m._id)),
        );
        prefetchAttachmentImages(convex, rows);
      },
      [syncTable, convex],
    ),
  );

  return { loading: !!live && result === undefined && !error, error };
}

// ── Readers ─────────────────────────────────────────────────────────────────

/** The viewer plus the team roster, as chat identity. Bots (the anchor) are
 *  members too — chat.ts resolves their handles off the roster, so the client
 *  must draw its faces from the same list. */
export function useChatMembers(): { members: ChatMember[]; byId: Map<string, ChatMember>; viewerId: string; handles: HandleSets } {
  const s = useTrackedStore([
    (s: any) => memberListSig(s.teamMembers),
    (s: any) => s.currentUser?._id,
    (s: any) => s.currentUser?.name,
    (s: any) => s.currentUser?.image,
    (s: any) => anchorBotsSig(s.anchors),
  ]);
  const viewerId = String(s.currentUser?._id ?? "");
  const roster: any[] = s.teamMembers ?? [];
  const sig = memberListSig(roster);
  const botsSig = anchorBotsSig((s as any).anchors);
  const me = s.currentUser;
  return useMemo(() => {
    const byId = new Map<string, ChatMember>();
    for (const m of roster) if (m?._id) byId.set(String(m._id), m as ChatMember);
    // The viewer is in their own team roster, but a just-joined client can hold
    // the user before the roster lands.
    if (viewerId && !byId.has(viewerId) && me) byId.set(viewerId, me as ChatMember);
    // Handles and pickers come from the ROSTER only: a team anchor is on it,
    // a personal one is not (it belongs to one person, not the team).
    const members = [...byId.values()];
    const handles = buildHandleSets(members, viewerId);
    // Names and faces come from the roster PLUS every anchor bot the viewer can
    // see (lib/chatViews' known-agent registry, kept by the anchors feeder),
    // so a DM from a personal anchor is titled with its name rather than
    // "Someone". Lookup only — it never becomes a mention target here.
    for (const bot of anchorBots((s as any).anchors)) {
      if (!byId.has(bot._id)) byId.set(bot._id, bot);
    }
    return { members, byId, viewerId, handles };
    // The signatures are the deps, not the arrays: both collections re-push.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig, botsSig, viewerId, me]);
}

function anchorBots(anchors: Record<string, any> | undefined): ChatMember[] {
  const out: ChatMember[] = [];
  for (const id in anchors ?? {}) {
    const a = anchors![id];
    if (!a?.bot_user_id || a.status === "decommissioned") continue;
    out.push({ _id: String(a.bot_user_id), name: a.bot_name ?? a.name ?? "Anchor", image: a.bot_avatar ?? null, is_bot: true } as ChatMember);
  }
  return out;
}

function anchorBotsSig(anchors: Record<string, any> | undefined): string {
  let out = "";
  for (const id in anchors ?? {}) {
    const a = anchors![id];
    out += `${a?.bot_user_id ?? ""}|${a?.bot_name ?? ""}|${a?.bot_avatar ?? ""}|${a?.status ?? ""}\n`;
  }
  return out;
}

/** Open (or create) the DM with these teammates and go there. Local-first:
 *  openDmChannel answers in the same tick — an existing room's real id or a
 *  stub the server row supersedes — so the navigation never waits. One hook
 *  for the modal, the rail's suggestions and the sidebar's, so "how a DM
 *  opens" is decided in exactly one place. */
export function useOpenDm(): (memberIds: string[]) => void {
  const router = useRouter();
  return useCallback(
    (memberIds: string[]) => {
      const channelId = useInboxStore.getState().openDmChannel(memberIds);
      router.push(`/chat/${channelId}`);
    },
    [router],
  );
}

/** The channel rail, already sorted and counted. */
export function useChatRail(): ChatRailChannel[] {
  const s = useTrackedStore([
    (s: any) => channelsSig(s.chatChannels),
    (s: any) => readsSig(s.chatReads),
    (s: any) => railSig(s.chatRail),
    (s: any) => railMessagesSig(s.chatMessages),
    (s: any) => s.currentUser?._id,
    (s: any) => s.clientState?.ui?.active_team_id,
  ]);
  // The canonical workspace source (useWorkspaceArgs reads the same field).
  // No currentUser fallback: undefined MEANS the personal workspace, and
  // falling back to a team would resurrect team rooms the user left.
  const teamId = s.clientState?.ui?.active_team_id;
  return selectChatRail(s as any, String(s.currentUser?._id ?? ""), teamId ? String(teamId) : undefined);
}

export function useMessageViews(
  rows: ChatMessageRow[],
  reactionRows: Record<string, ChatReactionRow>,
  byId: Map<string, ChatMember>,
  viewerId: string,
  rollupSource: Record<string, ChatMessageRow>,
  summaries?: Record<string, any>,
): ChatMessageView[] {
  // Live session identities for lines a session typed. Signature-gated: the
  // sessions collection churns on heartbeats, and a transcript only cares when
  // a title or agent changes.
  const st = useTrackedStore([(s: any) => sessionOriginSig(s.sessions)]);
  const sessionsSig = sessionOriginSig(st.sessions);
  const sessionFor = useMemo(() => {
    const map = new Map<string, { title?: string; agentType?: string }>();
    for (const row of Object.values(st.sessions ?? {}) as any[]) {
      if (!row?.session_id) continue;
      map.set(String(row.session_id), {
        title: row.display_title || row.title || undefined,
        agentType: row.agent_type,
      });
    }
    return (id: string) => map.get(id);
    // The signature is the real dep: the raw map ref flips on every push.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionsSig]);
  return useMemo(() => {
    const rollups = threadRollups(Object.values(rollupSource));
    const byMessage = new Map<string, ChatReactionRow[]>();
    for (const id in reactionRows) {
      const r = reactionRows[id];
      const list = byMessage.get(r.message_id);
      if (list) list.push(r);
      else byMessage.set(r.message_id, [r]);
    }
    const nameOf = (userId: string) => memberName(byId.get(userId));
    return toMessageViews(rows, {
      members: byId,
      viewerId,
      rollups,
      summaries,
      sendState: chatSendState,
      sessionFor,
      reactionsFor: (messageId) => {
        const list = byMessage.get(messageId);
        return list ? foldReactions(list, viewerId, nameOf) : undefined;
      },
    });
  }, [rows, reactionRows, byId, viewerId, rollupSource, summaries, sessionFor]);
}

/** One channel's timeline, ready to render. Roots only — replies live in the
 *  thread panel. */
export function useChannelMessages(channelId: string | undefined): ChatMessageView[] {
  const { byId, viewerId } = useChatMembers();
  const s = useTrackedStore([
    (s: any) => messagesSig(s.chatMessages),
    (s: any) => reactionsSig(s.chatReactions),
    // Ref identity: syncTable's no-change bail keeps it stable, so this wakes
    // only when a delivery actually changed some root's rollup.
    (s: any) => s.chatThreadSummaries,
  ]);
  const rows = useMemo(
    () => (channelId ? selectChannelMessages(s as any, channelId) : []),
    // The signature is the real dep: the raw map ref flips on every push.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [channelId, messagesSig(s.chatMessages)],
  );
  return useMessageViews(rows, s.chatReactions, byId, viewerId, s.chatMessages, s.chatThreadSummaries);
}

/** A thread: its root message and its replies, both ready to render. */
export function useThreadMessages(rootId: string | undefined): {
  root: ChatMessageView | null;
  replies: ChatMessageView[];
} {
  const { byId, viewerId } = useChatMembers();
  const s = useTrackedStore([
    (s: any) => messagesSig(s.chatMessages),
    (s: any) => reactionsSig(s.chatReactions),
  ]);
  const rows = useMemo(() => {
    if (!rootId) return [] as ChatMessageRow[];
    const rootRow = (s.chatMessages as Record<string, ChatMessageRow>)[rootId];
    return [...(rootRow ? [rootRow] : []), ...selectThreadReplies(s as any, rootId)];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootId, messagesSig(s.chatMessages)]);
  const views = useMessageViews(rows, s.chatReactions, byId, viewerId, s.chatMessages);
  const rootRow = rootId ? (s.chatMessages as Record<string, ChatMessageRow>)[rootId] : undefined;
  return {
    root: rootRow ? views[0] ?? null : null,
    replies: rootRow ? views.slice(1) : views,
  };
}

/**
 * Where a dead stub channel id went.
 *
 * A channel is created optimistically and navigated to by its stub id, so the
 * rail can select it in the same tick. When the server row lands, the altKey
 * supersede deletes the stub and rekeys everything pointing at it — including
 * the tab path — but a URL that arrived some other way (a paste, a reload, a
 * window with no tab shell) can still be holding the dead id. The server row
 * keeps the stub id as its `client_id`, which is the forwarding address.
 *
 * Returns undefined while the stub is alive: the reader is on their new channel
 * and nothing needs to move.
 */
export function useSupersededChannelId(channelId: string | undefined): string | undefined {
  const s = useTrackedStore([(s: any) => channelsSig(s.chatChannels)]);
  return supersededChannelId(s.chatChannels as Record<string, ChatChannelRow>, channelId);
}

/** The plain-function core of useSupersededChannelId, for callers that already
 *  hold the channels map (the sidebar's pin resolution runs per pin, where a
 *  hook per item can't). */
export function supersededChannelId(
  channels: Record<string, ChatChannelRow>,
  channelId: string | undefined,
): string | undefined {
  if (!channelId || isConvexId(channelId) || channels[channelId]) return undefined;
  for (const id in channels) {
    if (channels[id]?.client_id === channelId) return id;
  }
  return undefined;
}

/** The channel a message belongs to — the permalink's missing half when the URL
 *  carries `?m=` for a message whose channel is already open. */
export function useChatMessageRow(messageId: string | undefined): ChatMessageRow | undefined {
  const s = useTrackedStore([(s: any) => messagesSig(s.chatMessages)]);
  if (!messageId) return undefined;
  return (s.chatMessages as Record<string, ChatMessageRow>)[messageId];
}

/** Unread totals across every channel, for the sidebar and the document title.
 *  Weight is the count of unread channels; only mentions produce a number.
 *  Threads have their own badge (hooks/useThreadsSync useThreadUnread). */
export function useChatUnread(): { channels: number; mentions: number } {
  const rail = useChatRail();
  return useMemo(() => {
    let channels = 0;
    let mentions = 0;
    for (const c of rail) {
      if ((c.unreadCount ?? 0) > 0 && !c.muted) channels++;
      mentions += c.mentionCount ?? 0;
    }
    return { channels, mentions };
  }, [rail]);
}

/** Fetch one message by id when the store has never seen it — the permalink
 *  landing case where `?m=` points into history the client has not paged to. */
export function useEnsureChatMessage(messageId: string | undefined): void {
  const convex = useConvex();
  const known = !!useChatMessageRow(messageId);
  const askedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!messageId || !isConvexId(messageId) || known) return;
    if (askedRef.current === messageId) return;
    askedRef.current = messageId;
    void convex
      .query(api.chat.getMessage, { message_id: messageId })
      .then((res: any) => {
        if (res?.message) useInboxStore.getState().syncTable("chatMessages", [res.message]);
      })
      .catch(() => {});
  }, [convex, messageId, known]);
}
