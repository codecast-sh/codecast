"use client";

import { useState, useEffect, useCallback, memo } from "react";
import { useQuery } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { DashboardLayout } from "../../components/DashboardLayout";
import { ConversationDiffLayout } from "../../components/ConversationDiffLayout";
import { ConversationData } from "../../components/ConversationView";
import { useConversationMessages } from "../../hooks/useConversationMessages";
import { useQueueStore, InboxSession } from "../../store/queueStore";

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

const InboxConversation = memo(function InboxConversation({ sessionId, onSendAndAdvance }: { sessionId: string; onSendAndAdvance: () => void }) {
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
  onStash,
}: {
  session: InboxSession;
  isActive: boolean;
  globalIndex: number;
  onSelect: (index: number) => void;
  onStash: (id: string) => void;
}) {
  const project = getProjectName(session.git_root, session.project_path);

  return (
    <div
      className={`relative group border-b border-sol-border/30 transition-colors ${
        isActive
          ? "bg-sol-bg-highlight border-l-2 border-l-sol-cyan"
          : "hover:bg-sol-bg-alt/80"
      }`}
    >
      <button
        onClick={() => onSelect(globalIndex)}
        className="w-full text-left px-3 py-2 pr-8"
      >
        <div className="flex items-center justify-between gap-2 mb-0.5">
          <span className="text-[11px] font-medium text-sol-cyan truncate">{project}</span>
          <div className="flex items-center gap-1.5 flex-shrink-0">
            {session.has_pending && (
              <span className="w-1.5 h-1.5 rounded-full bg-sol-yellow animate-pulse" title="Message pending" />
            )}
            {!session.is_idle && !session.has_pending && (
              <span className="w-1.5 h-1.5 rounded-full bg-sol-green" title="Working" />
            )}
            <span className="text-[10px] text-sol-text-dim tabular-nums">
              {formatIdleDuration(session.updated_at)}
            </span>
          </div>
        </div>
        <div className="text-sm text-sol-text truncate leading-tight">
          {session.title || `Session ${session.session_id?.slice(0, 8)}`}
        </div>
        {(session.idle_summary || session.subtitle) && (
          <div className="text-[11px] text-sol-text-muted mt-0.5 line-clamp-2 leading-snug">
            {session.idle_summary || session.subtitle}
          </div>
        )}
      </button>
      <button
        onClick={(e) => { e.stopPropagation(); onStash(session._id); }}
        className="absolute top-2 right-1.5 p-1 rounded text-sol-text-dim hover:text-sol-red opacity-0 group-hover:opacity-100 transition-opacity"
        title="Stash session"
      >
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
}

function InboxSessionPanel() {
  const sessions = useQueueStore((s) => s.sessions);
  const currentIndex = useQueueStore((s) => s.currentIndex);
  const setCurrentIndex = useQueueStore((s) => s.setCurrentIndex);
  const stashSession = useQueueStore((s) => s.stashSession);
  const unstashSession = useQueueStore((s) => s.unstashSession);
  const stashedIds = useQueueStore((s) => s.stashedIds);
  const [showStashed, setShowStashed] = useState(false);

  const needsInput = sessions.filter((s) => s.is_idle);
  const working = sessions.filter((s) => !s.is_idle);
  const stashedCount = stashedIds.size;

  const getGlobalIndex = (session: InboxSession) =>
    sessions.findIndex((s) => s._id === session._id);

  return (
    <div className="h-full flex flex-col bg-sol-bg-alt border-l border-sol-border/50 overflow-hidden">
      <div className="px-3 py-3 border-b border-sol-border/50 flex-shrink-0">
        <div className="text-xs font-medium text-sol-text-dim uppercase tracking-wide">
          {sessions.length} Session{sessions.length !== 1 ? "s" : ""}
        </div>
      </div>
      <div className="flex-1 overflow-y-auto">
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
                onStash={stashSession}
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
                onStash={stashSession}
              />
            ))}
          </>
        )}

        {stashedCount > 0 && (
          <>
            <button
              onClick={() => setShowStashed(!showStashed)}
              className="w-full px-3 py-1.5 bg-sol-bg border-b border-sol-border/30 flex items-center justify-between"
            >
              <span className="text-[10px] font-semibold uppercase tracking-wider text-sol-text-dim">
                Stashed ({stashedCount})
              </span>
              <svg
                className={`w-3 h-3 text-sol-text-dim transition-transform ${showStashed ? "rotate-180" : ""}`}
                fill="none" stroke="currentColor" viewBox="0 0 24 24"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>
            {showStashed && (
              <div className="opacity-60">
                {Array.from(stashedIds).map((id) => (
                  <div key={id} className="px-3 py-2 border-b border-sol-border/30 flex items-center justify-between">
                    <span className="text-xs text-sol-text-dim truncate">{id.slice(0, 12)}...</span>
                    <button
                      onClick={() => unstashSession(id)}
                      className="text-[10px] text-sol-cyan hover:text-sol-text transition-colors"
                    >
                      Restore
                    </button>
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        {sessions.length === 0 && stashedCount === 0 && (
          <div className="px-3 py-8 text-center text-sm text-sol-text-dim">
            No active sessions
          </div>
        )}
      </div>
    </div>
  );
}

export function QueuePageClient() {
  const activeSessions = useQuery(api.conversations.listIdleSessions);
  const sessions = useQueueStore((s) => s.sessions);
  const currentIndex = useQueueStore((s) => s.currentIndex);
  const syncFromConvex = useQueueStore((s) => s.syncFromConvex);
  const advanceToNext = useQueueStore((s) => s.advanceToNext);
  const stashSession = useQueueStore((s) => s.stashSession);
  const navigateUp = useQueueStore((s) => s.navigateUp);
  const navigateDown = useQueueStore((s) => s.navigateDown);

  useEffect(() => {
    if (activeSessions) {
      syncFromConvex(activeSessions);
    }
  }, [activeSessions, syncFromConvex]);

  const handleSendAndAdvance = useCallback(() => {
    advanceToNext();
  }, [advanceToNext]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const isInput = target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable;

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
      if (e.key === "Escape" && !isInput) {
        e.preventDefault();
        const current = sessions[currentIndex];
        if (current) stashSession(current._id);
        return;
      }
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [navigateDown, navigateUp, stashSession, sessions, currentIndex]);

  const currentSession = sessions[currentIndex];
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
          {currentSession ? (
            <InboxConversation
              key={currentSession._id}
              sessionId={currentSession._id}
              onSendAndAdvance={handleSendAndAdvance}
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
          <InboxSessionPanel />
        </div>
      </div>
      {prefetchIds.map((id) => (
        <Prefetch key={id} sessionId={id} />
      ))}
    </DashboardLayout>
  );
}
