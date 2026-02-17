"use client";

import { useState, useEffect, useCallback, useRef, memo } from "react";
import { useQuery, useMutation } from "convex/react";
import { useSearchParams } from "next/navigation";
import { api } from "@codecast/convex/convex/_generated/api";
import { Id } from "@codecast/convex/convex/_generated/dataModel";
import { DashboardLayout } from "../../components/DashboardLayout";
import { ConversationDiffLayout } from "../../components/ConversationDiffLayout";
import { ConversationData } from "../../components/ConversationView";
import { useConversationMessages } from "../../hooks/useConversationMessages";
import { useQueueStore, InboxSession } from "../../store/queueStore";
import { registerMutation } from "../../store/convexCache";
import { useCurrentConversationStore } from "../../store/currentConversationStore";

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
      fallbackStickyContent={lastUserMessage}
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
  onRestore,
  variant = "default",
}: {
  session: InboxSession;
  isActive: boolean;
  globalIndex: number;
  onSelect: (index: number) => void;
  onDismiss?: (id: string) => void;
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
          <span className={`text-[11px] truncate ${
            isWorking ? "font-semibold text-sol-green" : "font-medium text-sol-cyan"
          }`}>{project}</span>
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
        <div className={`text-sm truncate leading-tight ${
          isActive ? "text-sol-text font-semibold" : isWorking ? "text-sol-text font-medium" : "text-sol-text"
        }`}>
          {session.title || `Session ${session.session_id?.slice(0, 8)}`}
        </div>
        {(session.idle_summary || session.subtitle) && (
          <div className="text-[11px] text-sol-text-muted mt-0.5 truncate leading-snug">
            {session.idle_summary || session.subtitle}
          </div>
        )}
        {session.last_user_message && (
          <div className="text-[10px] text-sol-text-dim mt-0.5 truncate leading-snug font-mono">
            <span className="text-sol-cyan/60 mr-0.5">&gt;</span>
            {session.last_user_message}
          </div>
        )}
      </button>
      {onDismiss && (
        <button
          onClick={(e) => { e.stopPropagation(); onDismiss(session._id); }}
          className="absolute top-2 right-1.5 p-1 rounded text-sol-text-dim hover:text-sol-red opacity-0 group-hover:opacity-100 transition-opacity"
          title="Dismiss (Ctrl+Backspace)"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      )}
      {onRestore && (
        <button
          onClick={(e) => { e.stopPropagation(); onRestore(session._id); }}
          className="absolute top-2 right-1.5 p-1 rounded text-sol-text-dim hover:text-sol-cyan opacity-0 group-hover:opacity-100 transition-opacity"
          title="Restore to inbox"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h10a5 5 0 010 10H9M3 10l4-4M3 10l4 4" />
          </svg>
        </button>
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
  const unstashSession = useQueueStore((s) => s.unstashSession);
  const showDismissed = useQueueStore((s) => s.showDismissed);
  const setShowDismissed = useQueueStore((s) => s.setShowDismissed);
  const viewingDismissedId = useQueueStore((s) => s.viewingDismissedId);
  const setViewingDismissedId = useQueueStore((s) => s.setViewingDismissedId);

  const needsInput = sessions.filter((s) => s.is_idle);
  const working = sessions.filter((s) => !s.is_idle);

  const getGlobalIndex = (session: InboxSession) =>
    sessions.findIndex((s) => s._id === session._id);

  return (
    <div className="h-full flex flex-col bg-sol-bg-alt border-l border-sol-border/50 overflow-hidden">
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
  const setCurrentIndex = useQueueStore((s) => s.setCurrentIndex);
  const viewingDismissedId = useQueueStore((s) => s.viewingDismissedId);
  const setViewingDismissedId = useQueueStore((s) => s.setViewingDismissedId);

  useEffect(() => {
    registerMutation("conversations", (id, fields) =>
      patchConv({ id: id as Id<"conversations">, fields })
    );
  }, [patchConv]);
  const isPopstateRef = useRef(false);
  const initialParamId = useRef(searchParams.get("s"));

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

  // On initial load, select session from URL param
  useEffect(() => {
    const paramId = initialParamId.current;
    if (!paramId || sessions.length === 0) return;
    const idx = sessions.findIndex((s) => s._id === paramId);
    if (idx >= 0 && idx !== currentIndex) {
      setCurrentIndex(idx);
    }
    initialParamId.current = null;
  }, [sessions, currentIndex, setCurrentIndex]);

  const handleDismiss = useCallback((id: string) => {
    stashSession(id);
  }, [stashSession]);

  const handleDismissCurrent = useCallback(() => {
    const current = sessions[currentIndex];
    if (current) handleDismiss(current._id);
  }, [sessions, currentIndex, handleDismiss]);

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
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [navigateDown, navigateUp, handleDismissCurrent]);

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
      <div className="h-full flex">
        <div className="flex-1 min-w-0">
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
        </div>
        <div className="w-72 flex-shrink-0 hidden md:block">
          <InboxSessionPanel showAll={showAll} onToggleShowAll={toggleShowAll} dismissedSessions={dismissedSessions} />
        </div>
      </div>
      {prefetchIds.map((id) => (
        <Prefetch key={id} sessionId={id} />
      ))}
    </DashboardLayout>
  );
}
