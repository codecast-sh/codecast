"use client";

import { useState, useEffect, useCallback, useRef, memo } from "react";
import { useQuery, useMutation } from "convex/react";
import { useSearchParams } from "next/navigation";
import { Panel, Group, Separator } from "react-resizable-panels";
import { api } from "@codecast/convex/convex/_generated/api";
import { Id } from "@codecast/convex/convex/_generated/dataModel";
import { DashboardLayout } from "../../components/DashboardLayout";
import { ConversationDiffLayout } from "../../components/ConversationDiffLayout";
import { ConversationData } from "../../components/ConversationView";
import { useConversationMessages } from "../../hooks/useConversationMessages";
import { useQueueStore, InboxSession } from "../../store/queueStore";
import { registerMutation } from "../../store/convexCache";
import { useCurrentConversationStore } from "../../store/currentConversationStore";
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from "../../components/ui/tooltip";

function formatIdleDuration(updatedAt: number): string {
  const diff = Date.now() - updatedAt;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function getProjectName(gitRoot?: string, projectPath?: string): string {
  const path = gitRoot || projectPath;
  if (!path) return "unknown";
  return path.split("/").filter(Boolean).pop() || "unknown";
}

const InboxConversation = memo(function InboxConversation({ sessionId, onSendAndAdvance, lastUserMessage }: { sessionId: string; onSendAndAdvance: () => void; lastUserMessage?: string | null }) {
  const {
    conversation,
    hasMoreAbove,
    hasMoreBelow,
    isLoadingOlder,
    isLoadingNewer,
    loadOlder,
    loadNewer,
    jumpToStart,
    jumpToEnd,
  } = useConversationMessages(sessionId);

  if (!conversation) {
    return (
      <div className="h-full flex items-center justify-center text-sol-text-dim">
        <div className="flex items-center gap-2">
          <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
          </svg>
          <span className="text-sm">Loading conversation...</span>
        </div>
      </div>
    );
  }

  return (
    <ConversationDiffLayout
      conversation={conversation as ConversationData}
      embedded
      hasMoreAbove={hasMoreAbove}
      hasMoreBelow={hasMoreBelow}
      isLoadingOlder={isLoadingOlder}
      isLoadingNewer={isLoadingNewer}
      onLoadOlder={loadOlder}
      onLoadNewer={loadNewer}
      onJumpToStart={jumpToStart}
      onJumpToEnd={jumpToEnd}
      isOwner={true}
      onSendAndAdvance={onSendAndAdvance}
      autoFocusInput
      backHref="/inbox"
      fallbackStickyContent={lastUserMessage?.replace(/\[Image\s+\/tmp\/codecast\/images\/[^\]]*\]/gi, "").trim() || null}
    />
  );
});

function Prefetch({ sessionId }: { sessionId: string }) {
  useConversationMessages(sessionId);
  return null;
}

function SessionCard({
  session,
  isActive,
  globalIndex,
  onSelect,
  onDismiss,
  onDefer,
  onRestore,
  variant = "default",
}: {
  session: InboxSession;
  isActive: boolean;
  globalIndex: number;
  onSelect: (index: number) => void;
  onDismiss?: (id: string) => void;
  onDefer?: (id: string) => void;
  onRestore?: (id: string) => void;
  variant?: "default" | "working" | "dismissed";
}) {
  const project = getProjectName(session.git_root, session.project_path);
  const isWorking = variant === "working";
  const isDismissed = variant === "dismissed";

  return (
    <div
      className={`relative group border-b border-sol-border/30 transition-colors ${
        isActive
          ? "bg-sol-cyan/15 border-l-[3px] border-l-sol-cyan shadow-[inset_0_0_16px_rgba(42,161,152,0.12)]"
          : isWorking
            ? "bg-sol-green/[0.04] border-l-2 border-l-sol-green/40 hover:bg-sol-green/[0.08]"
            : isDismissed
              ? "opacity-60 hover:opacity-80 hover:bg-sol-bg-alt/80"
              : "hover:bg-sol-bg-alt/80"
      }`}
    >
      <button
        onClick={() => onSelect(globalIndex)}
        className="w-full text-left px-3 py-2 pr-8"
      >
        <div className="flex items-center justify-between gap-2 mb-0.5">
          <div className={`text-sm truncate leading-tight ${
            isActive ? "text-sol-text font-semibold" : isWorking ? "text-sol-text font-medium" : "text-sol-text"
          }`}>
            {session.title || "New Session"}
          </div>
          <div className="flex items-center gap-1.5 flex-shrink-0">
            {session.has_pending && (
              <span className="w-1.5 h-1.5 rounded-full bg-sol-yellow animate-pulse" title="Message pending" />
            )}
            {isWorking && (
              <span className="relative flex h-2 w-2" title="Working">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-sol-green opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-sol-green" />
              </span>
            )}
            <span className="text-[10px] text-sol-text-dim tabular-nums">
              {formatIdleDuration(session.updated_at)}
            </span>
          </div>
        </div>
        <span className={`text-[11px] truncate block ${
          isWorking ? "font-semibold text-sol-green" : "font-medium text-sol-cyan"
        }`}>{project}</span>
        {session.message_count === 0 && !session.last_user_message && (
          <div className="flex items-center gap-1.5 mt-0.5 text-[11px] text-sol-cyan/60">
            <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
            <span>Starting...</span>
          </div>
        )}
        {session.last_user_message && (
          <div className="text-[11px] text-sky-700 dark:text-sky-300 mt-0.5 truncate leading-snug">
            <span className="text-sky-600/60 dark:text-sky-400/50 mr-0.5">&gt;</span>
            {session.last_user_message.replace(/\[Image\s+\/tmp\/codecast\/images\/[^\]]*\]/gi, "").trim() || "[image]"}
          </div>
        )}
        {(session.idle_summary || session.subtitle) && (
          <div className="text-[11px] text-sol-text-muted mt-0.5 line-clamp-2 leading-snug">
            {session.idle_summary || session.subtitle}
          </div>
        )}
      </button>
      {(onDismiss || onDefer) && (
        <div className="absolute top-1.5 right-1 flex flex-col gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
          {onDefer && (
            <TooltipProvider delayDuration={300}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={(e) => { e.stopPropagation(); onDefer(session._id); }}
                    className="p-1 rounded text-sol-text-dim hover:text-sol-yellow transition-colors"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 3v14m0 0l-6-6m6 6l6-6M5 21h14" />
                    </svg>
                  </button>
                </TooltipTrigger>
                <TooltipContent side="left">Defer</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
          {onDismiss && (
            <TooltipProvider delayDuration={300}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={(e) => { e.stopPropagation(); onDismiss(session._id); }}
                    className="p-1 rounded text-sol-text-dim hover:text-sol-red transition-colors"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 7l10 10M17 17h-6m6 0v-6" />
                    </svg>
                  </button>
                </TooltipTrigger>
                <TooltipContent side="left">Dismiss</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
        </div>
      )}
      {onRestore && (
        <TooltipProvider delayDuration={300}>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={(e) => { e.stopPropagation(); onRestore(session._id); }}
                className="absolute top-2 right-1.5 p-1 rounded text-sol-text-dim hover:text-sol-cyan opacity-0 group-hover:opacity-100 transition-opacity"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 17L7 7M7 7h6M7 7v6" />
                </svg>
              </button>
            </TooltipTrigger>
            <TooltipContent side="left">Restore</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}
    </div>
  );
}

function InboxSessionPanel({
  showAll,
  onToggleShowAll,
  dismissedSessions,
}: {
  showAll: boolean;
  onToggleShowAll: () => void;
  dismissedSessions: InboxSession[];
}) {
  const sessions = useQueueStore((s) => s.sessions);
  const currentIndex = useQueueStore((s) => s.currentIndex);
  const setCurrentIndex = useQueueStore((s) => s.setCurrentIndex);
  const stashSession = useQueueStore((s) => s.stashSession);
  const deferSession = useQueueStore((s) => s.deferSession);
  const unstashSession = useQueueStore((s) => s.unstashSession);
  const showDismissed = useQueueStore((s) => s.showDismissed);
  const setShowDismissed = useQueueStore((s) => s.setShowDismissed);
  const viewingDismissedId = useQueueStore((s) => s.viewingDismissedId);
  const setViewingDismissedId = useQueueStore((s) => s.setViewingDismissedId);

  const newSessions = sessions.filter((s) => s.message_count === 0);
  const needsInput = sessions.filter((s) => s.is_idle && s.message_count > 0);
  const working = sessions.filter((s) => !s.is_idle && s.message_count > 0);

  const getGlobalIndex = (session: InboxSession) =>
    sessions.findIndex((s) => s._id === session._id);

  return (
    <div className="h-full w-full flex flex-col bg-sol-bg-alt border-l border-sol-border/50 overflow-hidden">
      <div className="px-3 py-3 border-b border-sol-border/50 flex-shrink-0">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-sol-text-dim uppercase tracking-wide">
            {sessions.length} Session{sessions.length !== 1 ? "s" : ""}
          </span>
          <button
            onClick={onToggleShowAll}
            className="text-[10px] text-sol-text-dim hover:text-sol-cyan transition-colors"
          >
            {showAll ? "Recent only" : "Show all"}
          </button>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto scrollbar-auto">
        {newSessions.length > 0 && (
          <>
            <div className="px-3 py-1.5 bg-sol-bg border-b border-sol-border/30">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-sol-blue">
                New ({newSessions.length})
              </span>
            </div>
            {newSessions.map((session) => (
              <SessionCard
                key={session._id}
                session={session}
                isActive={getGlobalIndex(session) === currentIndex}
                globalIndex={getGlobalIndex(session)}
                onSelect={setCurrentIndex}
                onDismiss={stashSession}
                onDefer={deferSession}
              />
            ))}
          </>
        )}

        {needsInput.length > 0 && (
          <>
            <div className="px-3 py-1.5 bg-sol-bg border-b border-sol-border/30">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-sol-yellow">
                Needs Input ({needsInput.length})
              </span>
            </div>
            {needsInput.map((session) => (
              <SessionCard
                key={session._id}
                session={session}
                isActive={getGlobalIndex(session) === currentIndex}
                globalIndex={getGlobalIndex(session)}
                onSelect={setCurrentIndex}
                onDismiss={stashSession}
                onDefer={deferSession}
              />
            ))}
          </>
        )}

        {working.length > 0 && (
          <>
            <div className="px-3 py-1.5 bg-sol-bg border-b border-sol-border/30">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-sol-green">
                Working ({working.length})
              </span>
            </div>
            {working.map((session) => (
              <SessionCard
                key={session._id}
                session={session}
                isActive={getGlobalIndex(session) === currentIndex}
                globalIndex={getGlobalIndex(session)}
                onSelect={setCurrentIndex}
                onDismiss={stashSession}
                onDefer={deferSession}
                variant="working"
              />
            ))}
          </>
        )}

        {sessions.length === 0 && (
          <div className="px-3 py-8 text-center text-sm text-sol-text-dim">
            No active sessions
          </div>
        )}

        <div className="border-t border-sol-border/30">
          <button
            onClick={() => setShowDismissed(!showDismissed)}
            className="w-full px-3 py-2 flex items-center justify-between text-[10px] font-semibold uppercase tracking-wider text-sol-text-dim hover:text-sol-text-muted transition-colors"
          >
            <span>
              Dismissed{dismissedSessions.length > 0 ? ` (${dismissedSessions.length})` : ""}
            </span>
            <svg
              className={`w-3 h-3 transition-transform ${showDismissed ? "rotate-180" : ""}`}
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </button>
          {showDismissed && dismissedSessions.length > 0 && (
            <div className="border-t border-sol-border/20">
              {dismissedSessions.map((session) => (
                <SessionCard
                  key={session._id}
                  session={session}
                  isActive={viewingDismissedId === session._id}
                  globalIndex={-1}
                  onSelect={() => setViewingDismissedId(session._id)}
                  onRestore={(id) => unstashSession(id)}
                  variant="dismissed"
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function QueuePageClient() {
  const searchParams = useSearchParams();
  const [showAll, setShowAll] = useState(false);
  const activeSessions = useQuery(api.conversations.listIdleSessions, { show_all: showAll });
  const dismissedQuery = useQuery(api.conversations.listDismissedSessions, {});
  const patchConv = useMutation(api.conversations.patchConversation);
  const sessions = useQueueStore((s) => s.sessions);
  const dismissedSessions = useQueueStore((s) => s.dismissedSessions);
  const currentIndex = useQueueStore((s) => s.currentIndex);
  const syncFromConvex = useQueueStore((s) => s.syncFromConvex);
  const syncDismissedFromConvex = useQueueStore((s) => s.syncDismissedFromConvex);
  const advanceToNext = useQueueStore((s) => s.advanceToNext);
  const navigateUp = useQueueStore((s) => s.navigateUp);
  const navigateDown = useQueueStore((s) => s.navigateDown);
  const stashSession = useQueueStore((s) => s.stashSession);
  const deferSession = useQueueStore((s) => s.deferSession);
  const rawSetCurrentIndex = useQueueStore((s) => s.setCurrentIndex);
  const viewingDismissedId = useQueueStore((s) => s.viewingDismissedId);
  const setViewingDismissedId = useQueueStore((s) => s.setViewingDismissedId);

  const [showShortcuts, setShowShortcuts] = useState(() => {
    if (typeof window === "undefined") return true;
    try { return localStorage.getItem("inbox-shortcuts") !== "hidden"; } catch { return true; }
  });
  const toggleShortcuts = useCallback(() => {
    setShowShortcuts((v) => {
      const next = !v;
      try { localStorage.setItem("inbox-shortcuts", next ? "visible" : "hidden"); } catch {}
      return next;
    });
  }, []);

  const [inboxLayout, setInboxLayout] = useState<{ [key: string]: number }>(() => {
    if (typeof window === "undefined") return { "inbox-main": 76, "inbox-sidebar": 24 };
    try {
      const stored = localStorage.getItem("inbox-layout");
      return stored ? JSON.parse(stored) : { "inbox-main": 76, "inbox-sidebar": 24 };
    } catch { return { "inbox-main": 76, "inbox-sidebar": 24 }; }
  });
  const handleInboxLayoutChange = useCallback((layout: { [key: string]: number }) => {
    setInboxLayout(layout);
    localStorage.setItem("inbox-layout", JSON.stringify(layout));
  }, []);

  useEffect(() => {
    registerMutation("conversations", (id, fields) =>
      patchConv({ id: id as Id<"conversations">, fields })
    );
  }, [patchConv]);
  const isPopstateRef = useRef(false);
  const lastAppliedParamId = useRef<string | null>(null);

  useEffect(() => {
    if (activeSessions) {
      syncFromConvex(activeSessions);
    }
  }, [activeSessions, syncFromConvex]);

  useEffect(() => {
    if (dismissedQuery) {
      syncDismissedFromConvex(dismissedQuery);
    }
  }, [dismissedQuery, syncDismissedFromConvex]);

  const injectSession = useQueueStore((s) => s.injectSession);
  const setCurrentIndex = rawSetCurrentIndex;

  // ID we're trying to navigate to that isn't yet in the queue
  const [pendingInjectId, setPendingInjectId] = useState<string | null>(null);

  // Query conversation for sessions not in the queue
  const directConv = useQuery(
    api.conversations.getConversation,
    pendingInjectId ? { conversation_id: pendingInjectId as Id<"conversations">, limit: 1 } : "skip"
  );

  // Select session from URL param -- only when the param actually changes
  const paramSessionId = searchParams.get("s");
  useEffect(() => {
    if (!paramSessionId || paramSessionId === lastAppliedParamId.current) return;
    if (sessions.length === 0 && activeSessions === undefined) return;
    lastAppliedParamId.current = paramSessionId;
    const idx = sessions.findIndex((s) => s._id === paramSessionId);
    if (idx >= 0) {
      rawSetCurrentIndex(idx);
      setPendingInjectId(null);
    } else {
      setPendingInjectId(paramSessionId);
    }
  }, [paramSessionId, sessions, rawSetCurrentIndex, activeSessions]);

  // Once we have the conversation data, inject it into the queue
  useEffect(() => {
    if (!pendingInjectId || !directConv) return;
    const already = sessions.findIndex((s) => s._id === pendingInjectId);
    if (already >= 0) {
      rawSetCurrentIndex(already);
      setPendingInjectId(null);
      return;
    }
    injectSession({
      _id: pendingInjectId,
      session_id: directConv.session_id || pendingInjectId,
      title: directConv.title,
      updated_at: directConv.updated_at,
      project_path: directConv.project_path,
      git_root: directConv.git_root,
      agent_type: directConv.agent_type || "claude_code",
      message_count: directConv.message_count || 0,
      is_idle: true,
      has_pending: false,
    });
    setPendingInjectId(null);
  }, [pendingInjectId, directConv, sessions, rawSetCurrentIndex, injectSession]);

  const handleDismiss = useCallback((id: string) => {
    stashSession(id);
  }, [stashSession]);

  const handleDismissCurrent = useCallback(() => {
    const current = sessions[currentIndex];
    if (current) handleDismiss(current._id);
  }, [sessions, currentIndex, handleDismiss]);

  const handleDeferCurrent = useCallback(() => {
    const current = sessions[currentIndex];
    if (current) deferSession(current._id);
  }, [sessions, currentIndex, deferSession]);

  const handleSendAndAdvance = useCallback(() => {
    advanceToNext();
  }, [advanceToNext]);

  const toggleShowAll = useCallback(() => {
    setShowAll((v) => !v);
  }, []);

  const viewingDismissedSession = viewingDismissedId
    ? dismissedSessions.find((s) => s._id === viewingDismissedId) ?? null
    : null;

  const setCurrentConversation = useCurrentConversationStore((s) => s.set);

  const currentSession = sessions[currentIndex];

  useEffect(() => {
    if (currentSession) {
      setCurrentConversation({
        conversationId: currentSession._id,
        projectPath: currentSession.project_path,
        gitRoot: currentSession.git_root,
        agentType: currentSession.agent_type,
        source: "inbox",
      });
    }
  }, [currentSession?._id, currentSession?.project_path, currentSession?.git_root, currentSession?.agent_type, setCurrentConversation]);

  // Sync URL when current session changes
  useEffect(() => {
    if (!currentSession) return;
    if (isPopstateRef.current) {
      isPopstateRef.current = false;
      return;
    }
    const url = new URL(window.location.href);
    if (!url.pathname.startsWith("/inbox")) return;
    if (url.searchParams.get("s") !== currentSession._id) {
      url.searchParams.set("s", currentSession._id);
      window.history.pushState({ inboxId: currentSession._id }, "", url.toString());
    }
  }, [currentSession?._id]);

  // Handle browser back/forward
  useEffect(() => {
    const onPopstate = (e: PopStateEvent) => {
      const id = e.state?.inboxId || new URL(window.location.href).searchParams.get("s");
      if (!id) return;
      const idx = sessions.findIndex((s) => s._id === id);
      if (idx >= 0) {
        isPopstateRef.current = true;
        setCurrentIndex(idx);
      }
    };
    window.addEventListener("popstate", onPopstate);
    return () => window.removeEventListener("popstate", onPopstate);
  }, [sessions, setCurrentIndex]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (e.key === "?" && !e.ctrlKey && !e.altKey && !e.metaKey && tag !== "INPUT" && tag !== "TEXTAREA" && !(e.target as HTMLElement)?.isContentEditable) {
        e.preventDefault();
        toggleShortcuts();
        return;
      }
      if (e.ctrlKey && e.key === "j") {
        e.preventDefault();
        e.stopImmediatePropagation();
        navigateDown();
        return;
      }
      if (e.ctrlKey && e.key === "k") {
        e.preventDefault();
        e.stopImmediatePropagation();
        navigateUp();
        return;
      }
      if (e.ctrlKey && e.key === "Backspace") {
        e.preventDefault();
        e.stopImmediatePropagation();
        handleDismissCurrent();
        return;
      }
      if (e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey && e.key === "Backspace") {
        e.preventDefault();
        e.stopImmediatePropagation();
        handleDeferCurrent();
        return;
      }
      if (e.ctrlKey && e.key === "i") {
        e.preventDefault();
        e.stopImmediatePropagation();
        const firstNeedsInput = sessions.findIndex((s) => s.is_idle && s.message_count > 0);
        if (firstNeedsInput >= 0) {
          setCurrentIndex(firstNeedsInput);
        }
        return;
      }
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [navigateDown, navigateUp, handleDismissCurrent, handleDeferCurrent, toggleShortcuts, sessions, setCurrentIndex]);

  const prefetchIds: string[] = [];
  const seen = new Set<string>();
  if (currentSession) seen.add(currentSession._id);
  for (const s of sessions) {
    if (!seen.has(s._id)) {
      seen.add(s._id);
      prefetchIds.push(s._id);
    }
  }

  return (
    <DashboardLayout>
      <div className="flex flex-col h-full">
      <Group orientation="horizontal" className="flex-1 min-h-0" defaultLayout={inboxLayout} onLayoutChange={handleInboxLayoutChange}>
        <Panel id="inbox-main" defaultSize="76%" minSize="30%">
          {viewingDismissedSession ? (
            <InboxConversation
              key={viewingDismissedSession._id}
              sessionId={viewingDismissedSession._id}
              onSendAndAdvance={() => setViewingDismissedId(null)}
              lastUserMessage={viewingDismissedSession.last_user_message}
            />
          ) : currentSession ? (
            <InboxConversation
              key={currentSession._id}
              sessionId={currentSession._id}
              onSendAndAdvance={handleSendAndAdvance}
              lastUserMessage={currentSession.last_user_message}
            />
          ) : (
            <div className="h-full flex items-center justify-center">
              <div className="text-center">
                <svg className="w-12 h-12 mx-auto mb-3 text-sol-text-dim" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <p className="text-sol-text-muted text-sm">
                  {activeSessions === undefined ? "Loading..." : "No active sessions"}
                </p>
                <p className="text-sol-text-dim text-xs mt-1">
                  Sessions will appear here when agents are running
                </p>
              </div>
            </div>
          )}
        </Panel>
        <Separator className="w-px bg-sol-border hover:w-1.5 hover:bg-sol-cyan data-[resize-handle-active]:w-1.5 data-[resize-handle-active]:bg-sol-cyan cursor-col-resize transition-[width,background-color] duration-150" />
        <Panel id="inbox-sidebar" defaultSize="24%" minSize="0%" maxSize="45%" collapsible collapsedSize="0%">
          <InboxSessionPanel showAll={showAll} onToggleShowAll={toggleShowAll} dismissedSessions={dismissedSessions} />
        </Panel>
      </Group>
      {showShortcuts && (
        <div className="flex-shrink-0 px-3 py-1.5 border-t border-sol-border/50 bg-sol-bg-alt/40 flex items-center gap-4 text-[10px] text-sol-text-dim">
          <span className="flex items-center gap-1">
            <kbd className="px-1 py-0.5 bg-sol-bg rounded border border-sol-border/80">Ctrl</kbd>
            <kbd className="px-1 py-0.5 bg-sol-bg rounded border border-sol-border/80">J/K</kbd>
            nav
          </span>
          <span className="flex items-center gap-1">
            <kbd className="px-1 py-0.5 bg-sol-bg rounded border border-sol-border/80">Ctrl</kbd>
            <kbd className="px-1 py-0.5 bg-sol-bg rounded border border-sol-border/80">I</kbd>
            needs input
          </span>
          <span className="flex items-center gap-1">
            <kbd className="px-1 py-0.5 bg-sol-bg rounded border border-sol-border/80">Shift</kbd>
            <kbd className="px-1 py-0.5 bg-sol-bg rounded border border-sol-border/80">Bksp</kbd>
            defer
          </span>
          <span className="flex items-center gap-1">
            <kbd className="px-1 py-0.5 bg-sol-bg rounded border border-sol-border/80">Ctrl</kbd>
            <kbd className="px-1 py-0.5 bg-sol-bg rounded border border-sol-border/80">Bksp</kbd>
            dismiss
          </span>
          <button onClick={toggleShortcuts} className="ml-auto flex items-center gap-1 hover:text-sol-text-muted transition-colors">
            <kbd className="px-1 py-0.5 bg-sol-bg rounded border border-sol-border/80">?</kbd>
            hide
          </button>
        </div>
      )}
      </div>
      {prefetchIds.map((id) => (
        <Prefetch key={id} sessionId={id} />
      ))}
    </DashboardLayout>
  );
}
