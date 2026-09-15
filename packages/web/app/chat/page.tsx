"use client";

// /chat — team chat. /community — the same composition in community scope.
//
// SCOPE. The team scope shows the active workspace's rooms and needs a signed
// in member. The community scope (app/community/page.tsx) shows the product's
// public rooms (chat_channels.kind "community") to anyone: a visitor reads and
// is offered a sign in where the composer would be; a signed in user of ANY
// team posts. What is off in community scope is everything that presumes a
// team: DMs, huddles, search, the org roles listening, channel creation.
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
import { Headphones, Lock, BellOff, Bell, Bot, Plus, AlertTriangle, RotateCw, Search, SquarePen } from "lucide-react";
import { toast } from "sonner";
import { ChannelMembersButton, DmHeadline } from "../../components/chat/ChannelPeople";
import { linkSendsOutbound } from "@codecast/convex/convex/lib/slackMirror";
import { SlackMirrorPill } from "../../components/chat/SlackMirrorPill";
import { useChannelSlackLink } from "../../components/chat/SlackSyncDialog";
import { WalkiePttButton } from "../../components/calls/WalkiePtt";
import { HuddleButton, OccupancyChip } from "../../components/calls/OccupancyChip";
import { chatViewRoomKey } from "../../lib/chatViews";
import { NewMessageModal } from "../../components/chat/NewMessageModal";
import { ChatSearch } from "../../components/chat/ChatSearch";
import { useShortcutAction } from "../../shortcuts";
import { MenuKeyCaps } from "../../components/KeyboardShortcutsHelp";
import { channelDisplayName } from "../../lib/chatViews";
import { useSwitchWorkspace } from "../../hooks/useSwitchWorkspace";
import { useInboxStore, selectChannelReadMarker, selectNavCollapsed, type ChatNotifyLevel, type ChatRailScope } from "../../store/inboxStore";
import Link from "next/link";
import { useAuthGate } from "@platform/auth/web";
import { useLocalAuth } from "../../lib/localAuth";
import { isStandaloneCommunityPath } from "../../lib/desktop";
import { Logo } from "../../components/Logo";
import type { ChatAttachment } from "../../store/chatSlice";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import {
  useChannelMessages,
  useChannelMessagesSync,
  useChatMembers,
  useChatRail,
  useCommunityChannelsSync,
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
import { ChannelListeners } from "../../components/chat/ChannelListeners";
import { useSyncOrgTree } from "../../hooks/useSyncOrgTree";
import { mentionWakeLine } from "../../lib/chatMentionWakes";
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
      <span className="ch-search-keys">
        <MenuKeyCaps action="chat.search" />
      </span>
    </button>
  );
}

/** Where the composer would be, for a visitor: reading is open, posting needs
 *  an account. The link comes back to this exact room. */
function SignInToPost({ compact }: { compact?: boolean }) {
  const here = typeof window === "undefined" ? "/community" : window.location.pathname + window.location.search;
  const back = encodeURIComponent(here);
  return (
    <div className={`ch-guest-post${compact ? " ch-guest-post-compact" : ""}`}>
      <span className="ch-guest-post-text">Anyone can read. Sign in to post.</span>
      <Link href={`/login?return_to=${back}`} className="ch-empty-action">Sign in</Link>
      <Link href={`/signup?return_to=${back}`} className="ch-guest-post-alt">Create an account</Link>
    </div>
  );
}

/** The community page's own chrome when it stands alone in a browser: who we
 *  are, where this is, the way back to the site, and the door into the app. */
function CommunityBar({ isGuest }: { isGuest: boolean }) {
  const here = typeof window === "undefined" ? "/community" : window.location.pathname + window.location.search;
  return (
    <header className="ch-community-bar">
      <a href="/" className="ch-community-brand" aria-label="Codecast home">
        <Logo size="sm" className="[--logo-c:currentColor]" />
      </a>
      <span className="ch-community-where">
        <span className="ch-community-slash" aria-hidden="true">/</span>
        community
      </span>
      <nav className="ch-community-links" aria-label="Site">
        <a href="/documentation">Docs</a>
        <a href="/changelog">Changelog</a>
        <a href="/support">Support</a>
      </nav>
      <span className="ch-community-spacer" />
      {isGuest ? (
        <Link href={`/login?return_to=${encodeURIComponent(here)}`} className="ch-community-cta">Sign in</Link>
      ) : (
        <Link href="/inbox" className="ch-community-cta">Open the app</Link>
      )}
    </header>
  );
}

export default function ChatPage({ scope = "team" }: { scope?: ChatRailScope } = {}) {
  const params = useParams<{ channelId?: string }>();
  const search = useSearchParams();
  const router = useRouter();
  const now = useCoarseNow(CLOCK_MS);
  const community = scope === "community";
  const base = community ? "/community" : "/chat";
  // A visitor on the community page: reads, never writes. Elsewhere the shell
  // has already redirected a guest, so this is false.
  const isGuest = useAuthGate(useLocalAuth) === "guest";
  // In a plain browser the community page is a standalone page with its own
  // header (the layout paints a bare frame from the same rule).
  const standalone = community && (isGuest || isStandaloneCommunityPath(typeof window === "undefined" ? "" : window.location.pathname));
  // The public rail's feeder is per view, mounted here and nowhere else.
  const communityFeed = useCommunityChannelsSync(community);

  const rail = useChatRail(scope);
  const { members: teamMembers, viewerId, handles } = useChatMembers();
  // The org tree of the active workspace (the singleton the org page paints
  // from): the header's "listening: N roles" and the composer's @role rows
  // read it. A per-view feeder like the org page's own, so a follower window
  // keeps it fresh too.
  useSyncOrgTree();

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
    if (supersededTo) router.replace(`${base}/${supersededTo}`);
  }, [supersededTo, router, base]);

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
  // The app sidebar lists the WORKSPACE's rooms, never the public ones, so
  // the community page always carries its own rail (and a visitor has no
  // sidebar at all).
  const showInlineRail = community || navCollapsed || zenMode || narrowViewport;
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
    // A community room is routed to the team that manages it, which is not
    // the viewer's workspace and need not be: no interstitial.
    if (!urlChannelId || community) return null;
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
      router.push(`${base}/${channelId}`);
    },
    [router, base],
  );

  // What a send woke (agent-channels.md C2): the server answers with
  // mention_wakes, the toast says which role and session — one line, gone on
  // its own. Silence when the line named nobody; the same toast the muted
  // channel notice already uses.
  const onSent = useCallback(
    (content: string) => (res: { mention_wakes?: any } | undefined) => {
      const roles = new Set<string>(
        ((useInboxStore.getState().orgTree?.roles ?? []) as { handle: string }[]).map((r) => r.handle.toLowerCase()),
      );
      const line = mentionWakeLine(content, res?.mention_wakes, roles);
      if (line) toast(line, { duration: 4000 });
    },
    [],
  );

  const send = useCallback(
    (content: string, attachments?: ChatAttachment[], opts?: { syncLocalOnly?: boolean }) => {
      if (!activeChannelId) return;
      useInboxStore.getState().sendChatMessage(activeChannelId, content, {
        attachments,
        syncLocalOnly: opts?.syncLocalOnly,
        onSent: onSent(content),
      });
    },
    [activeChannelId, onSent],
  );

  const sendReply = useCallback(
    (content: string, attachments?: ChatAttachment[], opts?: { broadcast?: boolean }) => {
      if (!activeChannelId || !threadRootId) return;
      useInboxStore.getState().sendChatMessage(activeChannelId, content, {
        threadRootId,
        attachments,
        broadcast: opts?.broadcast,
        onSent: onSent(content),
      });
    },
    [activeChannelId, threadRootId, onSent],
  );

  const markRead = useCallback(() => {
    // A visitor has no read mark to advance (and no identity to write one).
    if (!activeChannelId || !present || isGuest) return;
    // The newest message in the ROOM, replies included — not the newest row on
    // screen. The transcript shows roots only, while the rail's unread tally
    // counts every row in the channel, so a marker taken from the last root can
    // never clear a badge a thread reply raised.
    const state = useInboxStore.getState();
    const marker = selectChannelReadMarker(state as any, activeChannelId);
    state.markChannelRead(activeChannelId, marker?._id);
  }, [activeChannelId, present, isGuest]);

  const react = useCallback((messageId: string, emoji: string) => {
    useInboxStore.getState().toggleChatReaction(messageId, emoji);
  }, []);

  const editMessage = useCallback((messageId: string, content: string) => {
    useInboxStore.getState().editChatMessage(messageId, content);
  }, []);

  const deleteMessage = useCallback((messageId: string) => {
    useInboxStore.getState().deleteChatMessage(messageId);
  }, []);

  const shareToSlack = useCallback((messageId: string) => {
    useInboxStore.getState().shareChatMessageToSlack(messageId);
  }, []);

  // The channel's Slack mirror, if any: the header pill, the per-line marks
  // and the composer's keep-local switch all read this one row.
  const slackLink = useChannelSlackLink(activeChannelId);
  const slackOutbound = !!slackLink && linkSendsOutbound(slackLink);

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
    const path = urlChannelId ? `${base}/${urlChannelId}` : base;
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
      // Search is a team read (chat.searchMessages resolves a team); the
      // public rooms have none.
      if (!tabActive || community) return false;
      setSearchOpen(true);
      return true;
    }, [tabActive, community]),
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

  // The per team opt in gates the team's rooms only; the public rooms are
  // the product's, not a team's.
  if (!chatOn && !community) return <TeamFeatureOff feature="chat" />;

  return (
    <div className={standalone ? "ch-community-page" : undefined}>
    {standalone && <CommunityBar isGuest={isGuest} />}
    <div className="ch-shell">
      {showInlineRail && <ChatChannelRail
        channels={rail}
        activeChannelId={activeChannelId}
        onChannelContextMenu={isGuest ? undefined : (e, c) =>
          channelMenu.open(e, {
            channelId: c.id,
            notifyLevel: (c as any).notifyLevel ?? "mentions",
            onArchived: c.id === activeChannelId ? () => router.replace(base) : undefined,
          })
        }
        onSelect={selectChannel}
        onCreate={community ? undefined : createChannel}
        onNewMessage={community ? undefined : openNewMessage}
        onOpenDm={community ? undefined : openDmWith}
        showDms={!community}
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
                    {activeChannel?.isPrivate
                      ? <Lock className="w-3 h-3 inline-block" />
                      : activeChannel?.kind === "agents"
                        ? <Bot className="w-3 h-3 inline-block" />
                        : "#"}
                  </span>
                  {activeChannel?.name ?? "channel"}
                </span>
              )}
              {/* Which roles read this room on their next wake, and "follow
                  as @handle" for the viewer's own roles. */}
              {activeChannel && !community && <ChannelListeners channel={activeChannel} />}
              {activeChannel && activeChannel.kind !== "dm" && !community && !isGuest && (
                <SlackMirrorPill channelId={activeChannel.id} link={slackLink} />
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
              {activeChannel && activeChannel.kind !== "dm" && !community && (
                <HuddleButton
                  roomKey={chatViewRoomKey(activeChannel, viewerId, teamMembers)}
                  anchorTitle={`#${activeChannel.name}`}
                  className="shrink-0"
                  // A phone header has no room for the word beside the icon.
                  compact={narrowViewport}
                />
              )}
              {!community && <SearchPill onOpen={() => setSearchOpen(true)} />}
              {!community && (
                <button
                  type="button"
                  className="ch-tool"
                  title="New message"
                  aria-haspopup="dialog"
                  onClick={openNewMessage}
                >
                  <SquarePen className="w-3.5 h-3.5" />
                </button>
              )}
              {/* One management surface for everything channel-shaped —
                  notifications, rename, topic, archive — shared verbatim with
                  the sidebar's channel rows (ChannelMenu). */}
              {!isGuest && (
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
                      onArchived: () => router.replace(base),
                    });
                  }}
                >
                  {activeChannel?.muted ? <BellOff className="w-3.5 h-3.5" /> : <Bell className="w-3.5 h-3.5" />}
                </button>
              )}
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
                  {community
                    ? "This room is empty. Be the first to say something."
                    : "This channel is empty. Say something — or mention the anchor to bring an agent in."}
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
                slackOutbound={slackOutbound}
                onShareToSlack={shareToSlack}
                targetMessageId={targetRow?.thread_root_id ? undefined : targetId}
              />
            )}

            {isGuest ? <SignInToPost /> : <ChatComposer
              dropFilesRef={dropFilesRef}
              channelId={activeChannelId}
              // The @ popup draws on a team roster; the public has none.
              teamId={community ? undefined : activeChannel?.teamId}
              walkieRoomKey={walkieRoomKey}
              walkieRing={activeChannel?.dmMemberIds}
              slackChannelName={slackOutbound ? (slackLink?.slack_channel_name ?? slackLink?.slack_channel_id) : undefined}
              placeholder={
                activeChannel?.kind === "dm"
                  ? `Message ${channelDisplayName(activeChannel, useInboxStore.getState().teamMembers)}`
                  : `Message #${activeChannel?.name ?? "channel"}`
              }
              onSend={send}
              autoFocus
            />}
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
        ) : community ? (
          <div className="ch-empty">
            <div className="ch-empty-title">{communityFeed.loading ? "Opening the community" : "Nobody has opened a room yet"}</div>
            <div className="ch-empty-sub">
              {communityFeed.loading ? "Fetching the public rooms." : "The public rooms will appear here."}
            </div>
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
          teamId={community ? undefined : activeChannel?.teamId}
          composer={isGuest ? <SignInToPost compact /> : undefined}
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
    </div>
  );
}
