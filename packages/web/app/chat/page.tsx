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

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useMutation } from "convex/react";
import { api as _chatApi } from "@codecast/convex/convex/_generated/api";
const api = _chatApi as any;
import { Lock, BellOff, Bell, Plus, AlertTriangle, RotateCw } from "lucide-react";
import { useInboxStore, selectChannelReadMarker, type ChatNotifyLevel } from "../../store/inboxStore";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import {
  useChannelMessages,
  useChannelMessagesSync,
  useChatMembers,
  useChatRail,
  useEnsureChatMessage,
  useChatMessageRow,
  useSupersededChannelId,
  useThreadMessages,
  useThreadSync,
} from "../../hooks/useChatSync";
import { useTabContext } from "../../components/TabContent";
import { ChatChannelRail } from "../../components/chat/ChatChannelRail";
import { ChatMessageList } from "../../components/chat/ChatMessageList";
import { ChatThreadPanel } from "../../components/chat/ChatThreadPanel";
import { ChatComposer } from "../../components/chat/ChatComposer";
import { ChannelContextMenu, useChannelMenu } from "../../components/chat/ChannelMenu";
import { setChatFocus, clearChatFocus } from "../../lib/chatFocus";
import "../../components/chat/chat.css";

/** The clock the whole surface shares. Relative times ("3m ago") must stay
 *  honest without a re-render per row per second — see hooks/useCoarseNow. */
const CLOCK_MS = 30_000;

/** Is the window focused and the document visible, right now, reactively?
 *  document.hasFocus() is not state React can see, so it is subscribed to. */
function subscribePresence(fn: () => void): () => void {
  window.addEventListener("focus", fn);
  window.addEventListener("blur", fn);
  document.addEventListener("visibilitychange", fn);
  return () => {
    window.removeEventListener("focus", fn);
    window.removeEventListener("blur", fn);
    document.removeEventListener("visibilitychange", fn);
  };
}

function readPresence(): boolean {
  return document.visibilityState === "visible" && document.hasFocus();
}

export default function ChatPage() {
  const params = useParams<{ channelId?: string }>();
  const search = useSearchParams();
  const router = useRouter();
  const now = useCoarseNow(CLOCK_MS);

  const rail = useChatRail();
  const { viewerId, handles } = useChatMembers();

  // ── Is the reader actually here? ──────────────────────────────────────────
  const tab = useTabContext();
  // No tab shell (a standalone window, a test) means this page IS the view.
  const tabActive = tab ? tab.isActive : true;
  const windowPresent = useSyncExternalStore(subscribePresence, readPresence, () => false);
  const present = tabActive && windowPresent;

  // The channel from the URL, falling back to the busiest room the viewer is in.
  // A fallback rather than a redirect: rewriting the URL on arrival would put a
  // channel id in the history stack that the reader never chose.
  const urlChannelId = params.channelId;
  // A channel created here is navigated to by its local stub id. When the server
  // row lands the stub is superseded, and a URL still naming it points at a
  // channel that no longer exists — an empty room beside the real one in the
  // rail. The server row carries the stub as its client_id, so it forwards.
  const supersededTo = useSupersededChannelId(urlChannelId);
  useEffect(() => {
    if (supersededTo) router.replace(`/chat/${supersededTo}`);
  }, [supersededTo, router]);

  const activeWorkspaceTeam = useInboxStore((s) => s.clientState.ui?.active_team_id) as string | undefined;
  // Mirrors TeamSwitcher: the ui bag is the client truth, the user doc follows.
  const saveActiveTeam = useMutation(api.teams.setActiveTeam);
  // The URL names a channel the workspace filter excludes, and the cache KNOWS
  // it (carries a different team): rendering it would show the wrong team's
  // roster in the composer and popup. Surface a switch instead.
  const outOfScopeChannel = useInboxStore((s) => {
    if (!urlChannelId) return null;
    const row = s.chatChannels[urlChannelId];
    if (!row?.team_id) return null;
    if (activeWorkspaceTeam && String(row.team_id) === String(activeWorkspaceTeam)) return null;
    return { id: urlChannelId, name: row.name, teamId: String(row.team_id) };
  });
  const activeChannelId = useMemo(() => {
    if (supersededTo) return supersededTo;
    if (outOfScopeChannel) return undefined; // handled by the interstitial
    if (urlChannelId && rail.some((c) => c.id === urlChannelId)) return urlChannelId;
    if (urlChannelId) return urlChannelId; // not loaded yet — trust the URL
    return rail[0]?.id;
  }, [urlChannelId, supersededTo, rail, outOfScopeChannel]);
  const activeChannel = rail.find((c) => c.id === activeChannelId);

  // ── Data ──────────────────────────────────────────────────────────────────
  const feed = useChannelMessagesSync(activeChannelId);
  const messages = useChannelMessages(activeChannelId);

  // ── Permalink target ──────────────────────────────────────────────────────
  const targetId = search.get("m") || undefined;
  useEnsureChatMessage(targetId);
  const targetRow = useChatMessageRow(targetId);

  // ── Thread panel ──────────────────────────────────────────────────────────
  const [threadRootId, setThreadRootId] = useState<string | undefined>(undefined);
  // A permalink to a REPLY names a message that lives in a thread, so the panel
  // has to open for the link to land anywhere at all.
  const openedForRef = useRef<string | undefined>(undefined);
  useEffect(() => {
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

  // What the toast layer needs to know: a message in the room ON SCREEN must not
  // interrupt the person already reading it. On screen, not merely mounted — a
  // chat tab hidden behind Inbox was silencing its own toasts for a room the
  // reader could not see.
  useEffect(() => {
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
  useEffect(() => {
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
    (content: string) => {
      if (!activeChannelId) return;
      useInboxStore.getState().sendChatMessage(activeChannelId, content);
    },
    [activeChannelId],
  );

  const sendReply = useCallback(
    (content: string) => {
      if (!activeChannelId || !threadRootId) return;
      useInboxStore.getState().sendChatMessage(activeChannelId, content, { threadRootId });
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

  // The app's one context-menu system; the header bell and the rail's rows
  // (click and right-click) all open the same instance.
  const channelMenu = useChannelMenu();

  // ── Render ────────────────────────────────────────────────────────────────
  const showEmpty = messages.length === 0 && !feed.loading && !feed.error;
  const showError = messages.length === 0 && !!feed.error;
  const showSkeleton = messages.length === 0 && feed.loading;

  return (
    <div className="ch-shell">
      <ChatChannelRail
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
      />

      <div className="ch-main">
        {activeChannelId ? (
          <>
            <header className="ch-head">
              <span className="ch-head-name">
                <span className="ch-head-hash" aria-hidden="true">
                  {activeChannel?.isPrivate ? <Lock className="w-3 h-3 inline-block" /> : "#"}
                </span>
                {activeChannel?.name ?? "channel"}
              </span>
              {activeChannel?.topic && <span className="ch-head-topic">{activeChannel.topic}</span>}
              {!activeChannel?.topic && <span className="ch-head-topic" />}
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
              channelId={activeChannelId}
              teamId={activeChannel?.teamId}
              placeholder={`Message #${activeChannel?.name ?? "channel"}`}
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
                useInboxStore.getState().updateClientUI({ active_team_id: outOfScopeChannel.teamId });
                void saveActiveTeam({ team_id: outOfScopeChannel.teamId as any }).catch(() => {});
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
