"use client";

// /chat — team chat.
//
// The page is a composition, not an implementation. The rail, the transcript,
// the message row, the thread panel and the composer all already exist and are
// already screenshot-verified; this file wires them to the store, the URL and
// the read mark, and owns nothing else.
//
// THE URL IS THE STATE. /chat/<channelId>?m=<messageId> is the permalink shape
// the server mints (convex/chatText.ts chatPermalink), so the same link works
// from a notification, a push banner, the CLI and a teammate's paste. Selecting
// a channel rewrites the URL; opening a thread does not, because a thread is a
// position inside a channel rather than a different page — but a permalink to a
// reply opens the thread it belongs to, which is the only way that link can land
// on the message it names.
//
// READS ARE NOT IMPLIED BY ARRIVAL. The read mark advances only when the newest
// message is actually on screen (ChatMessageList reports it) — never on landing,
// never on a permalink jump into the middle of history. Marking a channel read
// because a link took the reader past it is how unread stops meaning anything.
//
// PRESENCE IS NOT MOUNTING. The tab shell keeps every opened tab mounted and
// hides the inactive ones with display:none, so this page keeps running while
// the reader works in Inbox. "The reader is here" therefore means the tab is
// ACTIVE, the document is VISIBLE and the window is FOCUSED — not that the
// component exists. A hidden tab that marks the channel read and silences its
// own toasts is the exact failure this file's read rule exists to prevent.

import { useCallsAvailable, useTeamFeature } from "../../lib/teamFeatures";
import { TeamFeatureOff } from "../../components/TeamFeatureOff";
import { useCallback, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useMutation } from "convex/react";
import { api as _chatApi } from "@codecast/convex/convex/_generated/api";
const api = _chatApi as any;
import { Headphones, Lock, BellOff, Bell, Plus, AlertTriangle, RotateCw, Search, SquarePen } from "lucide-react";
import { ChannelMembersButton, DmHeadline } from "../../components/chat/ChannelPeople";
import { WalkiePttButton } from "../../components/calls/WalkiePtt";
import { HuddleButton, OccupancyChip } from "../../components/calls/OccupancyChip";
import { chatViewRoomKey } from "../../lib/chatViews";
import { NewMessageModal } from "../../components/chat/NewMessageModal";
import { ChatSearch } from "../../components/chat/ChatSearch";
import { useShortcutAction } from "../../shortcuts";
import { MenuKeyCaps } from "../../components/KeyboardShortcutsHelp";
import { channelDisplayName } from "../../lib/chatViews";
import { useSwitchWorkspace } from "../../hooks/useSwitchWorkspace";
import { useInboxStore, selectChannelReadMarker, selectNavCollapsed, type ChatNotifyLevel } from "../../store/inboxStore";
import type { ChatAttachment } from "../../store/chatSlice";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import {
  useChannelMessages,
  useChannelMessagesSync,
  useChatMembers,
  useChatRail,
  useOpenDm,
  useEnsureChatMessage,
  useChatMessageRow,
  useSupersededChannelId,
  useThreadMessages,
  useThreadSync,
} from "../../hooks/useChatSync";
import { useTalkShortcut } from "../../hooks/useWalkie";
import { usePagePresence, useTabActive } from "../../hooks/usePagePresence";
import { prewarmRoom } from "../../lib/calls/roomPrewarm";
import { ChatChannelRail } from "../../components/chat/ChatChannelRail";
import { ChatMessageList } from "../../components/chat/ChatMessageList";
import { ChatThreadPanel } from "../../components/chat/ChatThreadPanel";
import { ChatComposer } from "../../components/chat/ChatComposer";
import { ChannelContextMenu } from "../../components/chat/ChannelMenu";
import { useChannelMenu } from "../../hooks/useChannelMenu";
import { useTitlebarHead } from "../../hooks/useTitlebarHead";
import { setChatFocus, clearChatFocus } from "../../lib/chatFocus";
import "../../components/chat/chat.css";

import { useWatchEffect } from "../../hooks/useWatchEffect";
/** The clock the whole surface shares. Relative times ("3m ago") must stay
 *  honest without a re-render per row per second — see hooks/useCoarseNow. */
const CLOCK_MS = 30_000;

/** The header's search affordance — a quiet pill wearing its shortcut. */
function SearchPill({ onOpen }: { onOpen: () => void }) {
  return (
    <button type="button" className="ch-search-open" title="Search messages" onClick={onOpen}>
      <Search className="w-3 h-3" />
      Search
      <MenuKeyCaps action="chat.search" />
    </button>
  );
}

export default function ChatPage() {
  const params = useParams<{ channelId?: string }>();
  const search = useSearchParams();
  const router = useRouter();
  const now = useCoarseNow(CLOCK_MS);

  const rail = useChatRail();
  const { members: teamMembers, viewerId, handles } = useChatMembers();

  // ── Is the reader actually here? ──────────────────────────────────────────
  const tabActive = useTabActive();
  const present = usePagePresence();

  // The channel from the URL, falling back to the busiest room the viewer is in.
  // A fallback rather than a redirect: rewriting the URL on arrival would put a
  // channel id in the history stack that the reader never chose.
  const urlChannelId = params.channelId;
  // /chat/threads was the Threads inbox before it became a page of its own.
  // The segment stays an alias (old tabs, bookmarks, notifications) and
  // forwards to /threads; it is never a channel id (Convex ids can't collide).
  const isThreadsView = urlChannelId === "threads";
  useWatchEffect(() => {
    if (isThreadsView) router.replace("/threads");
  }, [isThreadsView, router]);
  // A channel created here is navigated to by its local stub id. When the server
  // row lands the stub is superseded, and a URL still naming it points at a
  // channel that no longer exists — an empty room beside the real one in the
  // rail. The server row carries the stub as its client_id, so it forwards.
  const supersededTo = useSupersededChannelId(urlChannelId);
  useWatchEffect(() => {
    if (supersededTo) router.replace(`/chat/${supersededTo}`);
  }, [supersededTo, router]);

  const activeWorkspaceTeam = useInboxStore((s) => s.clientState.ui?.active_team_id) as string | undefined;
  const chatOn = useTeamFeature("chat");
  const navCollapsed = useInboxStore((s) => selectNavCollapsed(s as any));
  const zenMode = useInboxStore((s) => s.clientState.ui?.zen_mode ?? false);
  const headTitlebarRef = useTitlebarHead<HTMLElement>();
  const narrowViewport = useSyncExternalStore(
    (cb) => {
      if (typeof window === "undefined") return () => {};
      const mq = window.matchMedia("(max-width: 768px)");
      mq.addEventListener("change", cb);
      return () => mq.removeEventListener("change", cb);
    },
    () => (typeof window === "undefined" ? false : window.matchMedia("(max-width: 768px)").matches),
    () => false,
  );
  // One channel list on screen at a time: the app sidebar lists the channels,
  // so the page's own rail appears only when that sidebar is out of the way —
  // collapsed, zen mode, or a phone-width viewport. Collapsing the sidebar IS
  // the "just Slack" switch; no separate preference to remember.
  const showInlineRail = navCollapsed || zenMode || narrowViewport;
  // Switching workspace writes BOTH the local mirror and the canonical
  // users.active_team_id (hooks/useSwitchWorkspace) — one path for every caller.
  const switchWorkspace = useSwitchWorkspace();
  // The URL names a channel the workspace filter excludes, and the cache KNOWS
  // it (carries a different team): rendering it would show the wrong team's
  // roster in the composer and popup. Surface a switch instead.
  // Selects the ROW, not a built object: a selector that returns a fresh
  // object fails Object.is on every store notification and re-renders the
  // whole page on writes that have nothing to do with chat.
  const outOfScopeRow = useInboxStore((s) => {
    if (!urlChannelId) return null;
    const row = s.chatChannels[urlChannelId];
    if (!row?.team_id) return null;
    if (activeWorkspaceTeam && String(row.team_id) === String(activeWorkspaceTeam)) return null;
    return row;
  });
  const outOfScopeChannel = useMemo(
    () =>
      outOfScopeRow
        ? { id: outOfScopeRow._id, name: outOfScopeRow.name, teamId: String(outOfScopeRow.team_id) }
        : null,
    [outOfScopeRow],
  );
  const activeChannelId = useMemo(() => {
    if (isThreadsView) return undefined; // forwarding to /threads
    if (supersededTo) return supersededTo;
    if (outOfScopeChannel) return undefined; // handled by the interstitial
    if (urlChannelId && rail.some((c) => c.id === urlChannelId)) return urlChannelId;
    if (urlChannelId) return urlChannelId; // not loaded yet — trust the URL
    return rail[0]?.id;
  }, [urlChannelId, supersededTo, rail, outOfScopeChannel, isThreadsView]);
  const activeChannel = rail.find((c) => c.id === activeChannelId);

  // ── Data ──────────────────────────────────────────────────────────────────
  const feed = useChannelMessagesSync(activeChannelId);
  const messages = useChannelMessages(activeChannelId);

  // ── Push to talk ──────────────────────────────────────────────────────────
  // DMs only in v1: a burst is spoken into the DM's own room, and a channel-wide
  // walkie is a different product decision nobody has made.
  // Gated on calls being AVAILABLE, not merely on this being a DM: the team's
  // feature flag and a deployment with LiveKit behind it. Without this the mic
  // rendered enabled with calls off, and pressing it joined a room that threw
  // — leaving the call plane in `error` rather than `idle`, which the ordinary
  // call dock does not bail on, so a floating call window with an empty roster
  // and a hang-up button opened out of a chat composer. The teammate hover card
  // already asked this question; the composer, which is the primary way anyone
  // reaches push to talk, did not. This also disarms the keyboard chord, whose
  // `enabled` is derived from the same value.
  const callsAvailable = useCallsAvailable();
  const walkieRoomKey =
    callsAvailable && activeChannel?.kind === "dm"
      ? chatViewRoomKey(activeChannel, viewerId, teamMembers)
      : undefined;
  const resolveWalkieChannel = useCallback(() => activeChannelId ?? null, [activeChannelId]);

  // THE ROOM, OPENED BEFORE ANYBODY SPEAKS.
  //
  // Having a DM on screen is the earliest honest signal that a burst may be
  // spoken into it, and the media connection is what the first word waits on —
  // seconds, cold. So the room is connected silently here and `joinCall` spends
  // it later (lib/calls/roomPrewarm). Nothing is captured, nothing is published
  // and no surface changes; the connection releases itself if the guess was
  // wrong.
  //
  // Gated on presence, and re-asked when it returns, because that is also what
  // re-arms the release: a DM left open behind another window is a guess that
  // has already expired, and coming back to it is a fresh one.
  //
  // At render rather than in an effect, the same way the thread panel below
  // watches the channel change. A connection is worth starting a paint earlier
  // than an effect would, and `prewarmRoom` is a fire-and-forget call with its
  // own guards — the ref is only here so a re-render for some other reason
  // does not ask again.
  const warmedForRef = useRef<string | undefined>(undefined);
  const roomToWarm = present ? walkieRoomKey : undefined;
  if (warmedForRef.current !== roomToWarm) {
    warmedForRef.current = roomToWarm;
    if (roomToWarm) prewarmRoom(roomToWarm);
  }

  // ── Permalink target ──────────────────────────────────────────────────────
  const targetId = search.get("m") || undefined;
  useEnsureChatMessage(targetId);
  const targetRow = useChatMessageRow(targetId);

  // ── Thread panel ──────────────────────────────────────────────────────────
  const [threadRootId, setThreadRootId] = useState<string | undefined>(undefined);
  // A permalink to a REPLY names a message that lives in a thread, so the panel
  // has to open for the link to land anywhere at all.
  const openedForRef = useRef<string | undefined>(undefined);
  useWatchEffect(() => {
    if (!targetRow || openedForRef.current === targetRow._id) return;
    openedForRef.current = targetRow._id;
    if (targetRow.thread_root_id) setThreadRootId(targetRow.thread_root_id);
  }, [targetRow]);
  // Close the panel when the channel changes: a thread belongs to one room.
  const prevChannelRef = useRef(activeChannelId);
  if (prevChannelRef.current !== activeChannelId) {
    prevChannelRef.current = activeChannelId;
    if (threadRootId) setThreadRootId(undefined);
  }
  useThreadSync(threadRootId);
  const thread = useThreadMessages(threadRootId);
  // The keyboard toggle. What this page knows is whether the key has anywhere
  // to talk: a DM, with no thread covering it. Whether the page is the one on
  // screen is the hook's own question, asked there so no surface can arm a live
  // mic by forgetting to ask it.
  useTalkShortcut(walkieRoomKey, resolveWalkieChannel, !!walkieRoomKey && !threadRootId);

  // What the toast layer needs to know: a message in the room ON SCREEN must not
  // interrupt the person already reading it. On screen, not merely mounted — a
  // chat tab hidden behind Inbox was silencing its own toasts for a room the
  // reader could not see.
  useWatchEffect(() => {
    if (!present) {
      clearChatFocus();
      return;
    }
    setChatFocus({ channelId: activeChannelId, threadRootId });
    return () => clearChatFocus();
  }, [present, activeChannelId, threadRootId]);

  // ── The unread rule ───────────────────────────────────────────────────────
  // Frozen at channel entry. If it tracked the live read mark, the rule would
  // vanish the moment the reader's own scrolling advanced it — erasing the place
  // they came back to, mid-read. See the note in ChatMessageList.
  const [frozenReadAt, setFrozenReadAt] = useState<number | undefined>(undefined);
  const frozenForRef = useRef<string | undefined>(undefined);
  useWatchEffect(() => {
    // Wait for a RESOLVED channel, not merely for an id. On a cold load of
    // /chat/<id> — a reload, or a link from a notification — the id is known on
    // the first commit while the rail is still hydrating, and freezing there
    // stamped `undefined` forever: no rule, no landing on it, on exactly the
    // paths the rule is for.
    if (!activeChannelId || !activeChannel) return;
    if (frozenForRef.current === activeChannelId) return;
    frozenForRef.current = activeChannelId;
    setFrozenReadAt(activeChannel.lastReadAt);
  }, [activeChannelId, activeChannel]);

  // ── Actions ───────────────────────────────────────────────────────────────
  const selectChannel = useCallback(
    (channelId: string) => {
      router.push(`/chat/${channelId}`);
    },
    [router],
  );

  const send = useCallback(
    (content: string, attachments?: ChatAttachment[]) => {
      if (!activeChannelId) return;
      useInboxStore.getState().sendChatMessage(activeChannelId, content, { attachments });
    },
    [activeChannelId],
  );

  const sendReply = useCallback(
    (content: string, attachments?: ChatAttachment[], opts?: { broadcast?: boolean }) => {
      if (!activeChannelId || !threadRootId) return;
      useInboxStore.getState().sendChatMessage(activeChannelId, content, {
        threadRootId,
        attachments,
        broadcast: opts?.broadcast,
      });
    },
    [activeChannelId, threadRootId],
  );

  const markRead = useCallback(() => {
    if (!activeChannelId || !present) return;
    // The newest message in the ROOM, replies included — not the newest row on
    // screen. The transcript shows roots only, while the rail's unread tally
    // counts every row in the channel, so a marker taken from the last root can
    // never clear a badge a thread reply raised.
    const state = useInboxStore.getState();
    const marker = selectChannelReadMarker(state as any, activeChannelId);
    state.markChannelRead(activeChannelId, marker?._id);
  }, [activeChannelId, present]);

  const react = useCallback((messageId: string, emoji: string) => {
    useInboxStore.getState().toggleChatReaction(messageId, emoji);
  }, []);

  const editMessage = useCallback((messageId: string, content: string) => {
    useInboxStore.getState().editChatMessage(messageId, content);
  }, []);

  const deleteMessage = useCallback((messageId: string) => {
    useInboxStore.getState().deleteChatMessage(messageId);
  }, []);

  const retrySend = useCallback((messageId: string) => {
    useInboxStore.getState().retryChatSend(messageId);
  }, []);

  // The app's own modal, not window.prompt: prompt() does not exist in Electron,
  // where it returns nothing and the button is simply dead.
  const createChannel = useCallback(() => {
    useInboxStore.getState().openCreateModal("chat");
  }, []);

  // The new-message modal: one field for people, channels and groups.
  const [newMessageOpen, setNewMessageOpen] = useState(false);
  const openNewMessage = useCallback(() => setNewMessageOpen(true), []);

  // Chat search — transient overlay; results are a server-ranked read.
  //
  // ?search= is a REQUEST, consumed exactly once: the query moves into state,
  // the panel opens, and the param is stripped from the URL. Leaving it in the
  // URL would make the same request unrepeatable (same path, no change to
  // react to), reopen the panel on reload, and prefill a later manual open
  // with a stale query. Keying the panel on the seed remounts it for a new
  // request even while it is already open.
  const searchParam = search.get("search") || undefined;
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchSeed, setSearchSeed] = useState<{ q: string; n: number } | undefined>(undefined);
  useWatchEffect(() => {
    if (!searchParam) return;
    setSearchSeed((prev) => ({ q: searchParam, n: (prev?.n ?? 0) + 1 }));
    setSearchOpen(true);
    const path = urlChannelId ? `/chat/${urlChannelId}` : "/chat";
    router.replace(path);
    // urlChannelId is read at consume time only; the effect keys on the request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParam, router]);
  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setSearchSeed(undefined);
  }, []);
  // Only the chat tab the reader is LOOKING at owns the chord. The tab shell
  // keeps every opened chat page mounted, so an ungated handler in a hidden
  // pane would open a search nobody can see — and, having "handled" the key,
  // stop the chord reaching whatever surface actually holds focus.
  useShortcutAction(
    "chat.search",
    useCallback(() => {
      if (!tabActive) return false;
      setSearchOpen(true);
      return true;
    }, [tabActive]),
  );

  // A suggested teammate in the rail becomes a room in the same tick.
  const openDm = useOpenDm();
  const openDmWith = useCallback((memberId: string) => openDm([memberId]), [openDm]);

  // The app's one context-menu system; the header bell and the rail's rows
  // (click and right-click) all open the same instance.
  const channelMenu = useChannelMenu();

  // ── Images land anywhere ──────────────────────────────────────────────────
  // The whole channel is the drop target; the composer's thumbnail strip is
  // where the files land (MessageInput installs the handler on this ref).
  const dropFilesRef = useRef<((files: File[]) => void) | null>(null);
  const [dragging, setDragging] = useState(false);
  const dragDepthRef = useRef(0);
  const onDragEnter = useCallback((e: React.DragEvent) => {
    if (!e.dataTransfer?.types?.includes("Files")) return;
    dragDepthRef.current++;
    setDragging(true);
  }, []);
  const onDragLeave = useCallback(() => {
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setDragging(false);
  }, []);
  const onDragOver = useCallback((e: React.DragEvent) => {
    if (e.dataTransfer?.types?.includes("Files")) e.preventDefault();
  }, []);
  const onDrop = useCallback((e: React.DragEvent) => {
    dragDepthRef.current = 0;
    setDragging(false);
    const files = Array.from(e.dataTransfer?.files ?? []).filter((f) => f.type.startsWith("image/"));
    if (files.length === 0) return;
    e.preventDefault();
    dropFilesRef.current?.(files);
  }, []);

  // ── Render ────────────────────────────────────────────────────────────────
  // Local-first: the store may already know this room is empty (the rail
  // summary attests it — knownEmpty), and then the empty state renders
  // immediately. The skeleton is reserved for the one honest unknown: a
  // channel with no cached rows AND no rail attestation, where "empty" and
  // "not loaded yet" are genuinely indistinguishable until the first page
  // lands. Without this, opening a fresh DM flashed empty → skeleton → empty
  // across the stub-to-server-id handoff.
  const knownEmpty = !!activeChannel?.knownEmpty;
  const showEmpty = messages.length === 0 && !feed.error && (knownEmpty || !feed.loading);
  const showError = messages.length === 0 && !!feed.error;
  const showSkeleton = messages.length === 0 && feed.loading && !knownEmpty;

  if (!chatOn) return <TeamFeatureOff feature="chat" />;

  return (
    <div className="ch-shell">
      {showInlineRail && <ChatChannelRail
        channels={rail}
        activeChannelId={activeChannelId}
        onChannelContextMenu={(e, c) =>
          channelMenu.open(e, {
            channelId: c.id,
            notifyLevel: (c as any).notifyLevel ?? "mentions",
            onArchived: c.id === activeChannelId ? () => router.replace("/chat") : undefined,
          })
        }
        onSelect={selectChannel}
        onCreate={createChannel}
        onNewMessage={openNewMessage}
        onOpenDm={openDmWith}
      />}

      <div
        className="ch-main"
        onDragEnter={onDragEnter}
        onDragLeave={onDragLeave}
        onDragOver={onDragOver}
        onDrop={onDrop}
      >
        {dragging && (
          <div className="ch-drop-overlay" aria-hidden="true">
            <div className="ch-drop-card">Drop images to attach</div>
          </div>
        )}
        {activeChannelId ? (
          <>
            <header ref={headTitlebarRef} className="ch-head">
              {activeChannel?.kind === "dm" ? (
                <DmHeadline channel={activeChannel} />
              ) : (
                <span className="ch-head-name">
                  <span className="ch-head-hash" aria-hidden="true">
                    {activeChannel?.isPrivate ? <Lock className="w-3 h-3 inline-block" /> : "#"}
                  </span>
                  {activeChannel?.name ?? "channel"}
                </span>
              )}
              {activeChannel?.kind !== "dm" && activeChannel?.topic
                ? <span className="ch-head-topic">{activeChannel.topic}</span>
                : <span className="ch-head-topic" />}
              {activeChannel && (activeChannel.kind === "dm" || activeChannel.isPrivate) && (
                <ChannelMembersButton channel={activeChannel} />
              )}
              {/* ONE voice control per room. A DM gets the key — it used to
                  be reachable only from the composer, so a DM read from the
                  top of the room had no visible way to talk back, and the key
                  IS the product. Ring sits under the key (right click, long
                  press) rather than beside it: a ring is a talk that skips
                  the one-way stage, and two buttons on the same room read as
                  two products. A channel has no walkie, so its one control is
                  the huddle button — an open door the rail chip and the "in a
                  huddle" strip tell the team about. Either kind wears the
                  occupancy chip once the room is live; that is a state of the
                  room, not a second control. */}
              {walkieRoomKey && activeChannel && (
                <>
                  <WalkiePttButton
                    roomKey={walkieRoomKey}
                    resolveChannelId={resolveWalkieChannel}
                    size="sm"
                    icon={Headphones}
                    className="shrink-0"
                    title="Talk to them — they see your face and hear you; click again to stop"
                    ring={{ toUserIds: activeChannel.dmMemberIds ?? [] }}
                  />
                  <OccupancyChip roomKey={walkieRoomKey} className="shrink-0" />
                </>
              )}
              {activeChannel && activeChannel.kind !== "dm" && (
                <HuddleButton
                  roomKey={chatViewRoomKey(activeChannel, viewerId, teamMembers)}
                  anchorTitle={`#${activeChannel.name}`}
                  className="shrink-0"
                />
              )}
              <SearchPill onOpen={() => setSearchOpen(true)} />
              <button
                type="button"
                className="ch-tool"
                title="New message"
                aria-haspopup="dialog"
                onClick={openNewMessage}
              >
                <SquarePen className="w-3.5 h-3.5" />
              </button>
              {/* One management surface for everything channel-shaped —
                  notifications, rename, topic, archive — shared verbatim with
                  the sidebar's channel rows (ChannelMenu). */}
              <button
                type="button"
                className="ch-tool"
                title="Channel settings"
                aria-haspopup="menu"
                onClick={(e) => {
                  if (!activeChannelId) return;
                  channelMenu.open(e, {
                    channelId: activeChannelId,
                    notifyLevel: activeChannel?.notifyLevel ?? "mentions",
                    onArchived: () => router.replace("/chat"),
                  });
                }}
              >
                {activeChannel?.muted ? <BellOff className="w-3.5 h-3.5" /> : <Bell className="w-3.5 h-3.5" />}
              </button>
            </header>

            {showSkeleton ? (
              // A first load has a shape. Rendering nothing at all made a slow
              // channel and a broken one look identical: a large blank rectangle.
              <div className="ch-skeleton" role="status" aria-label="Loading messages">
                {[0, 1, 2, 3, 4].map((i) => (
                  <div className="ch-skel-row" key={i}>
                    <div className="ch-skel-avatar" />
                    <div className="ch-skel-lines">
                      <div className="ch-skel-line ch-skel-head" />
                      <div className="ch-skel-line" style={{ width: `${72 - i * 9}%` }} />
                    </div>
                  </div>
                ))}
              </div>
            ) : showError ? (
              <div className="ch-empty">
                <div className="ch-empty-icon ch-empty-bad" aria-hidden="true">
                  <AlertTriangle className="w-5 h-5" />
                </div>
                <div className="ch-empty-title">Couldn&apos;t load this channel</div>
                <div className="ch-empty-sub">
                  The server refused the request. Anything already on this device is still here.
                </div>
                <button type="button" className="ch-empty-action" onClick={feed.retry}>
                  <RotateCw className="w-3 h-3" />
                  Try again
                </button>
              </div>
            ) : showEmpty ? (
              <div className="ch-empty">
                <div className="ch-empty-title">Nothing here yet</div>
                <div className="ch-empty-sub">
                  This channel is empty. Say something — or mention the anchor to bring an agent in.
                </div>
              </div>
            ) : (
              <ChatMessageList
                messages={messages}
                lastReadAt={frozenReadAt}
                viewerId={viewerId}
                channelId={activeChannelId}
                permalinkChannelId={activeChannelId}
                knownHandles={handles.known}
                selfHandles={handles.self}
                handleNames={handles.names}
                now={now}
                hasMoreAbove={feed.hasMoreAbove}
                isLoadingOlder={feed.isLoadingOlder}
                onLoadOlder={feed.loadOlder}
                onReachedBottom={markRead}
                canReportRead={present}
                onOpenThread={setThreadRootId}
                onReact={react}
                onEdit={editMessage}
                onDelete={deleteMessage}
                onRetrySend={retrySend}
                targetMessageId={targetRow?.thread_root_id ? undefined : targetId}
              />
            )}

            <ChatComposer
              dropFilesRef={dropFilesRef}
              channelId={activeChannelId}
              teamId={activeChannel?.teamId}
              walkieRoomKey={walkieRoomKey}
              walkieRing={activeChannel?.dmMemberIds}
              placeholder={
                activeChannel?.kind === "dm"
                  ? `Message ${channelDisplayName(activeChannel, useInboxStore.getState().teamMembers)}`
                  : `Message #${activeChannel?.name ?? "channel"}`
              }
              onSend={send}
              autoFocus
            />
          </>
        ) : outOfScopeChannel ? (
          <div className="ch-empty">
            <div className="ch-empty-title">#{outOfScopeChannel.name} belongs to another team</div>
            <div className="ch-empty-sub">
              Channels live inside their team's workspace. Switch to that team to read it.
            </div>
            <button
              type="button"
              className="ch-empty-action"
              onClick={() => {
                void switchWorkspace(outOfScopeChannel.teamId as any).catch(() => {});
              }}
            >
              Switch team and open
            </button>
          </div>
        ) : !activeWorkspaceTeam ? (
          <div className="ch-empty">
            <div className="ch-empty-title">Chat lives in team workspaces</div>
            <div className="ch-empty-sub">
              The personal workspace has no channels. Switch to a team to see its rooms.
            </div>
          </div>
        ) : (
          <div className="ch-empty">
            <div className="ch-empty-title">No channels yet</div>
            <div className="ch-empty-sub">
              Create the first one and the rest of the team joins it automatically.
            </div>
            <button type="button" className="ch-empty-action" onClick={createChannel}>
              <Plus className="w-3 h-3" />
              New channel
            </button>
          </div>
        )}
      </div>

      <ChannelContextMenu state={channelMenu} />
      {newMessageOpen && <NewMessageModal onClose={() => setNewMessageOpen(false)} />}
      {searchOpen && (
        <ChatSearch
          key={searchSeed ? `seed-${searchSeed.n}` : "manual"}
          channels={rail}
          currentChannelId={activeChannelId}
          initialQuery={searchSeed?.q}
          onClose={closeSearch}
        />
      )}
      {threadRootId && activeChannelId && (
        <ChatThreadPanel
          channelId={activeChannelId}
          channelName={activeChannel?.name ?? "channel"}
          rootId={threadRootId}
          root={thread.root}
          replies={thread.replies}
          viewerId={viewerId}
          knownHandles={handles.known}
          selfHandles={handles.self}
          handleNames={handles.names}
          teamId={activeChannel?.teamId}
          now={now}
          // The link named a reply, and a reply only exists in this panel.
          targetMessageId={targetRow?.thread_root_id ? targetId : undefined}
          onClose={() => setThreadRootId(undefined)}
          onSend={sendReply}
          onReact={react}
          onEdit={editMessage}
          onDelete={deleteMessage}
          onRetrySend={retrySend}
        />
      )}
    </div>
  );
}
