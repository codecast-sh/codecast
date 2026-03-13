"use client";

import { useState, useEffect, useCallback, useRef, memo, useMemo } from "react";
import { useQuery, useMutation } from "convex/react";
import { useSearchParams, useRouter } from "next/navigation";
import { Panel, Group, Separator } from "react-resizable-panels";
import { api } from "@codecast/convex/convex/_generated/api";
import { Id } from "@codecast/convex/convex/_generated/dataModel";
import { DashboardLayout } from "../../components/DashboardLayout";
import { ConversationDiffLayout } from "../../components/ConversationDiffLayout";
import { ConversationData } from "../../components/ConversationView";
import { useConversationMessages } from "../../hooks/useConversationMessages";
import { useInboxStore, InboxSession, isConvexId, sortSessions } from "../../store/inboxStore";
import { useSyncInboxSessions } from "../../hooks/useSyncInboxSessions";
import { useSessionSwitcher } from "../../hooks/useSessionSwitcher";
import { SessionSwitcher } from "../../components/SessionSwitcher";
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from "../../components/ui/tooltip";
import { cleanTitle } from "../../lib/conversationProcessor";
import { SharePopover } from "../../components/SharePopover";
import { ActivityFeed } from "../../components/ActivityFeed";
import { toast } from "sonner";

const NOISE_PREFIXES = ["[Request interrupted", "This session is being continued", "Your task is to create a detailed summary", "Please continue the conversation", "<task-notification>", "Implement the following plan"];

const NOISE_PATTERNS = [
  /toolu_[A-Za-z0-9_-]+/,
  /\/private\/tmp\/claude/,
  /\/tmp\/claude-\d+\//,
  /\.output<\/out/,
  /tasks\/[a-z0-9]+\.output/,
];

function cleanUserMessage(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const cleaned = raw
    .replace(/<task-notification>[\s\S]*?<\/task-notification>/g, "")
    .replace(/\[Image[:\s][^\]]*\]/gi, "")
    .replace(/<image\b[^>]*\/?>\s*(?:<\/image>)?/gi, "")
    .replace(/<[^>]+>/g, "")
    .trim();
  if (!cleaned) return null;
  if (NOISE_PREFIXES.some(p => cleaned.startsWith(p))) return null;
  if (NOISE_PATTERNS.some(p => p.test(cleaned))) return null;
  return cleaned;
}

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

const InboxConversation = memo(function InboxConversation({ sessionId, isIdle, onSendAndAdvance, lastUserMessage, sessionError, onBack, targetMessageId }: { sessionId: string; isIdle: boolean; onSendAndAdvance: () => void; lastUserMessage?: string | null; sessionError?: string; onBack?: () => void; targetMessageId?: string }) {
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
  } = useConversationMessages(sessionId, targetMessageId);

  const resumeSession = useMutation(api.users.resumeSession);
  const restartSessionMutation = useMutation(api.conversations.restartSession);
  const setPrivacy = useMutation(api.conversations.setPrivacy);
  const setTeamVisibility = useMutation(api.conversations.setTeamVisibility);
  const generateShareLink = useMutation(api.conversations.generateShareLink);
  const [resumeState, setResumeState] = useState<"idle" | "resuming" | "sent" | "failed">("idle");
  const forceRestartAttemptedRef = useRef(false);

  const lastMsg = conversation?.messages?.[conversation.messages.length - 1];
  const lastRoleIsUser = lastMsg?.role === "user";
  const isStale = (Date.now() - (conversation?.updated_at || 0)) > 5 * 60 * 1000;
  const looksAbandoned = isIdle && lastRoleIsUser && isStale;

  useEffect(() => {
    if (!isIdle && (resumeState === "sent" || resumeState === "resuming")) {
      setResumeState("idle");
      forceRestartAttemptedRef.current = false;
    }
  }, [isIdle, resumeState]);

  useEffect(() => {
    if (resumeState !== "sent") return;
    const timeout = setTimeout(async () => {
      if (!forceRestartAttemptedRef.current && isConvexId(sessionId)) {
        forceRestartAttemptedRef.current = true;
        try {
          await restartSessionMutation({ conversation_id: sessionId as Id<"conversations"> });
          setResumeState("sent");
        } catch {
          setResumeState("failed");
        }
      } else {
        setResumeState("failed");
      }
    }, 45_000);
    return () => clearTimeout(timeout);
  }, [resumeState, sessionId, restartSessionMutation]);

  const handleManualResume = useCallback(() => {
    setResumeState("resuming");
    resumeSession({ conversation_id: sessionId as Id<"conversations"> })
      .then(() => setResumeState("sent"))
      .catch(() => setResumeState("failed"));
  }, [sessionId, resumeSession]);

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

  const convId = conversation._id as Id<"conversations">;
  const shareUrl = conversation.share_token
    ? `${typeof window !== "undefined" ? window.location.origin : ""}/conversation/${convId}`
    : null;
  const shareControls = (
    <SharePopover
      isPrivate={conversation.is_private !== false}
      teamVisibility={(conversation as any).team_visibility || (conversation as any).effective_team_visibility}
      hasShareToken={!!conversation.share_token}
      hasTeam={!!(conversation as any).auto_shared}
      onSetPrivate={async () => { await setPrivacy({ conversation_id: convId, is_private: true }); toast.success("Made private"); }}
      onSetTeamVisibility={async (mode) => { await setTeamVisibility({ conversation_id: convId, team_visibility: mode }); toast.success(mode === "full" ? "Sharing full conversation with team" : "Sharing summary with team"); }}
      onGenerateShareLink={async () => { await generateShareLink({ conversation_id: convId }); return `${window.location.origin}/conversation/${convId}`; }}
      shareUrl={shareUrl}
    />
  );

  return (
    <div className="relative h-full">
      {(resumeState === "resuming" || resumeState === "sent") && (
        <div className="absolute top-0 left-0 right-0 z-10 flex items-center gap-2 px-4 py-1.5 bg-sol-orange/90 text-sol-bg text-xs backdrop-blur-sm">
          <span className="w-1.5 h-1.5 rounded-full bg-sol-bg animate-pulse" />
          Resuming session...
        </div>
      )}
      {resumeState === "failed" && (
        <div className="absolute top-0 left-0 right-0 z-10 flex items-center gap-2 px-4 py-1.5 bg-sol-red/90 text-sol-bg text-xs backdrop-blur-sm">
          <span className="w-1.5 h-1.5 rounded-full bg-sol-bg" />
          Resume timed out
          <button onClick={handleManualResume} className="ml-1 px-1.5 py-0.5 rounded bg-sol-bg/20 hover:bg-sol-bg/30 transition-colors">
            Retry
          </button>
        </div>
      )}
      {sessionError && resumeState === "idle" && (
        <div className="absolute top-0 left-0 right-0 z-10 flex items-center gap-2 px-4 py-1.5 bg-sol-red/90 text-sol-bg text-xs backdrop-blur-sm">
          <span className="w-1.5 h-1.5 rounded-full bg-sol-bg" />
          {sessionError}
          <button onClick={handleManualResume} className="ml-1 px-1.5 py-0.5 rounded bg-sol-bg/20 hover:bg-sol-bg/30 transition-colors">
            Resume
          </button>
        </div>
      )}
      {looksAbandoned && !sessionError && resumeState === "idle" && (
        <div className="absolute top-0 left-0 right-0 z-10 flex items-center gap-2 px-4 py-1.5 bg-sol-bg-alt/90 border-b border-sol-border/50 text-sol-text-dim text-xs backdrop-blur-sm">
          <span className="w-1.5 h-1.5 rounded-full bg-sol-text-dim/50" />
          Session unresponsive — send a message or
          <button onClick={handleManualResume} className="px-1.5 py-0.5 rounded bg-sol-cyan/10 hover:bg-sol-cyan/20 border border-sol-cyan/30 text-sol-cyan transition-colors">
            Resume
          </button>
        </div>
      )}
      <ConversationDiffLayout
        conversation={conversation as ConversationData}
        embedded
        headerExtra={shareControls}
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
        onBack={onBack}
        fallbackStickyContent={cleanUserMessage(lastUserMessage)}
        targetMessageId={targetMessageId}
      />
    </div>
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
  onPin,
  onRestore,
  onNavigateToSession,
  variant = "default",
}: {
  session: InboxSession;
  isActive: boolean;
  globalIndex: number;
  onSelect: (index: number) => void;
  onDismiss?: (id: string) => void;
  onDefer?: (id: string) => void;
  onPin?: (id: string) => void;
  onRestore?: (id: string) => void;
  onNavigateToSession?: (id: string) => void;
  variant?: "default" | "working" | "dismissed";
}) {
  const project = getProjectName(session.git_root, session.project_path);
  const isWorking = variant === "working";
  const isDismissed = variant === "dismissed";
  const isSubagent = !!session.is_subagent;
  const displayTitle = cleanTitle(session.title || "New Session");
  const isSlashCommand = displayTitle.startsWith("/");
  const cleanedUserMsg = cleanUserMessage(session.last_user_message);

  return (
    <div
      className={`relative group border-b border-sol-border/30 transition-colors overflow-hidden ${
        isActive
          ? "bg-sol-cyan/15 border-l-[3px] border-l-sol-cyan shadow-[inset_0_0_16px_rgba(42,161,152,0.12)]"
          : isWorking
            ? "bg-sol-green/[0.04] border-l-2 border-l-sol-green/40 hover:bg-sol-green/[0.08]"
            : isDismissed && isSubagent
              ? "opacity-40 hover:opacity-60 hover:bg-sol-bg-alt/50 border-l border-l-violet-500/20"
              : isDismissed
                ? "opacity-60 hover:opacity-80 hover:bg-sol-bg-alt/80"
                : "hover:bg-sol-bg-alt/80"
      }`}
    >
      <div
        role="button"
        tabIndex={0}
        onClick={() => onSelect(globalIndex)}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(globalIndex); } }}
        className={`w-full text-left cursor-pointer ${
          isDismissed && isSubagent ? "px-2 py-1" : "px-2.5 sm:px-3 py-1.5 sm:py-2"
        }`}
      >
        <div className={`truncate leading-tight ${
          isActive ? "text-sm text-sol-text font-semibold" : isWorking ? "text-sm text-sol-text font-medium" : isDismissed && isSubagent ? "text-xs text-sol-text-muted" : "text-sm text-sol-text"
        }`}>
          {isSlashCommand ? <span className="font-mono text-sol-cyan">{displayTitle}</span> : displayTitle}
        </div>
        {(session.idle_summary || session.subtitle) && !session.implementation_session && (
          <div className="text-[11px] text-sol-text-muted mt-0.5 line-clamp-2 leading-snug whitespace-pre-line">
            {session.idle_summary || session.subtitle}
          </div>
        )}
        {cleanedUserMsg && (
          <div className="text-[11px] text-sky-700 dark:text-sky-300 mt-0.5 truncate leading-snug font-semibold">
            <span className="text-sky-600/60 dark:text-sky-400/50 mr-0.5">&gt;</span>
            {cleanedUserMsg}
          </div>
        )}
        {session.message_count === 0 && !session.last_user_message && (
          session.is_connected ? (
            <div className="flex items-center gap-1.5 mt-0.5 text-[11px] text-sol-green/70">
              <span className="w-1.5 h-1.5 rounded-full bg-sol-green/70" />
              <span>Ready</span>
            </div>
          ) : (Date.now() - (session.started_at || session.updated_at)) < 2 * 60 * 1000 ? (
            <div className="flex items-center gap-1.5 mt-0.5 text-[11px] text-sol-cyan/60">
              <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              <span>Starting...</span>
            </div>
          ) : (
            <div className="text-[11px] text-sol-text-dim/60 mt-0.5">
              Waiting for connection
            </div>
          )
        )}
        <div className="flex items-center gap-1.5 mt-1">
          <span className={`text-[10px] truncate ${
            isWorking ? "font-medium text-sol-green/70" : "font-medium text-sol-cyan/70"
          }`}>{project}</span>
          {session.message_count > 0 && (
            <span className="text-[10px] text-sol-text-dim tabular-nums flex-shrink-0">
              {session.message_count} msg{session.message_count !== 1 ? "s" : ""}
            </span>
          )}
          <div className="flex items-center gap-1.5 flex-shrink-0 ml-auto">
            {isSubagent && (
              <span className="inline-flex items-center px-1 py-0 rounded text-[9px] font-medium bg-violet-900/30 text-violet-400/70 border border-violet-600/30">
                sub
              </span>
            )}
            {session.session_error && (
              <span className="w-1.5 h-1.5 rounded-full bg-sol-red" title={session.session_error} />
            )}
            {session.is_unresponsive && !session.session_error && (
              <span className="w-1.5 h-1.5 rounded-full bg-sol-orange" title="Session unresponsive" />
            )}
            {session.has_pending && !session.is_unresponsive && (
              <span className="w-1.5 h-1.5 rounded-full bg-sol-yellow animate-pulse" title="Message pending" />
            )}
            {!isWorking && !isDismissed && session.is_idle && !session.is_connected && !session.session_error && !session.is_unresponsive && !session.has_pending && session.message_count > 0 && (
              <span className="w-1.5 h-1.5 rounded-full bg-sol-text-dim/40 ring-1 ring-sol-text-dim/20" title="Session ended" />
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
        {session.implementation_session && (
          <div
            className="mt-1 flex items-center gap-1 text-[11px] text-sol-cyan hover:text-sol-cyan/80 cursor-pointer"
            onClick={(e) => {
              e.stopPropagation();
              if (onNavigateToSession) onNavigateToSession(session.implementation_session!._id);
            }}
          >
            <svg className="w-3 h-3 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7l5 5m0 0l-5 5m5-5H6" />
            </svg>
            <span className="truncate underline underline-offset-2">
              {cleanTitle(session.implementation_session.title || "New Session")}
            </span>
          </div>
        )}
      </div>
      {onPin && session.is_pinned && (
        <div className="absolute top-0 right-0 py-1 pr-2 pointer-events-none z-[1]" style={{ paddingLeft: 24, background: isActive ? 'linear-gradient(to right, transparent, color-mix(in srgb, var(--sol-cyan) 15%, var(--sol-bg-alt)) 60%)' : 'linear-gradient(to right, transparent, var(--sol-bg-alt) 60%)' }}>
          <button
            onClick={(e) => { e.stopPropagation(); onPin(session._id); }}
            className="p-1 rounded text-sol-magenta transition-colors pointer-events-auto"
          >
            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 17v5" />
              <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76z" />
            </svg>
          </button>
        </div>
      )}
      {(onDismiss || onDefer || onPin) && (
        <div className={`absolute top-0 bottom-0 right-0 flex flex-col items-center justify-between py-1 opacity-0 group-hover:opacity-100 transition-opacity pl-16 pr-2 ${isActive ? '' : 'bg-gradient-to-r from-transparent via-sol-bg-alt/60 to-sol-bg-alt'}`} style={isActive ? { background: 'linear-gradient(to right, transparent, color-mix(in srgb, color-mix(in srgb, var(--sol-cyan) 15%, var(--sol-bg-alt)) 60%, transparent), color-mix(in srgb, var(--sol-cyan) 15%, var(--sol-bg-alt)))' } : undefined}>
          {onPin && (
            <TooltipProvider delayDuration={300}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={(e) => { e.stopPropagation(); onPin(session._id); }}
                    className={`p-1 rounded transition-colors ${session.is_pinned ? 'text-sol-magenta' : 'text-sol-text-dim hover:text-sol-magenta'}`}
                  >
                    <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill={session.is_pinned ? "currentColor" : "none"} stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                      <path d="M12 17v5" />
                      <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76z" />
                    </svg>
                  </button>
                </TooltipTrigger>
                <TooltipContent side="left">{session.is_pinned ? "Unpin" : "Pin"}</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
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
                className="absolute top-1.5 right-1.5 p-1 rounded-md text-sol-text-dim hover:text-sol-cyan opacity-0 group-hover:opacity-100 transition-opacity bg-sol-bg/95 backdrop-blur-sm shadow-sm border border-sol-border/30"
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
  const sessions = useInboxStore((s) => s.sessions);
  const sortedSessions = useMemo(() => sortSessions(sessions), [sessions]);
  const currentSessionId = useInboxStore((s) => s.currentSessionId);
  const stashSession = useInboxStore((s) => s.stashSession);
  const deferSession = useInboxStore((s) => s.deferSession);
  const pinSession = useInboxStore((s) => s.pinSession);
  const unstashSession = useInboxStore((s) => s.unstashSession);
  const showDismissed = useInboxStore((s) => s.showDismissed);
  const setShowDismissed = useInboxStore((s) => s.setShowDismissed);
  const viewingDismissedId = useInboxStore((s) => s.viewingDismissedId);

  const setCurrentSession = useInboxStore((s) => s.setCurrentSession);
  const showMySessions = useInboxStore((s) => s.showMySessions);
  const setShowMySessions = useInboxStore((s) => s.setShowMySessions);

  const handleSelectSession = useCallback((session: InboxSession) => {
    if (sessions[session._id]) {
      setCurrentSession(session._id);
      if (showMySessions) setShowMySessions(false);
    } else {
      useInboxStore.setState({ pendingNavigateId: session._id, showMySessions: false });
    }
  }, [sessions, setCurrentSession, showMySessions, setShowMySessions]);

  const handleNavigateToSession = useCallback((targetId: string) => {
    if (sessions[targetId]) {
      setCurrentSession(targetId);
      if (showMySessions) setShowMySessions(false);
    } else {
      useInboxStore.setState({ pendingNavigateId: targetId, showMySessions: false });
    }
  }, [sessions, setCurrentSession, showMySessions, setShowMySessions]);

  const pinned = sortedSessions.filter((s) => s.is_pinned);
  const newSessions = sortedSessions.filter((s) => s.message_count === 0 && !s.is_pinned);
  const needsInput = sortedSessions.filter((s) => s.is_idle && s.message_count > 0 && !s.is_pinned);
  const working = sortedSessions.filter((s) => !s.is_idle && s.message_count > 0 && !s.is_pinned);

  return (
    <div className="h-full w-full flex flex-col bg-sol-bg-alt overflow-hidden">
      <div className="px-3 py-3 border-b border-sol-border/50 flex-shrink-0">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-sol-text-dim uppercase tracking-wide">
            {sortedSessions.length} Session{sortedSessions.length !== 1 ? "s" : ""}
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
        {pinned.length > 0 && (
          <div>
            <div className="px-3 py-1.5 bg-sol-bg border-b border-sol-border/30">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-sol-magenta">
                Pinned ({pinned.length})
              </span>
            </div>
            {pinned.map((session) => (
              <SessionCard
                key={session._id}
                session={session}
                isActive={!viewingDismissedId && session._id === currentSessionId}
                globalIndex={0}
                onSelect={() => handleSelectSession(session)}
                onDismiss={stashSession}
                onDefer={deferSession}
                onPin={pinSession}
                onNavigateToSession={handleNavigateToSession}
              />
            ))}
          </div>
        )}

        {newSessions.length > 0 && (
          <div>
            <div className="px-3 py-1.5 bg-sol-bg border-b border-sol-border/30">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-sol-blue">
                New ({newSessions.length})
              </span>
            </div>
            {newSessions.map((session) => (
              <SessionCard
                key={session._id}
                session={session}
                isActive={!viewingDismissedId && session._id === currentSessionId}
                globalIndex={0}
                onSelect={() => handleSelectSession(session)}
                onDismiss={stashSession}
                onDefer={deferSession}
                onPin={pinSession}
                onNavigateToSession={handleNavigateToSession}
              />
            ))}
          </div>
        )}

        {needsInput.length > 0 && (
          <div>
            <div className="px-3 py-1.5 bg-sol-bg border-b border-sol-border/30">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-sol-yellow">
                Needs Input ({needsInput.length})
              </span>
            </div>
            {needsInput.map((session) => (
              <SessionCard
                key={session._id}
                session={session}
                isActive={!viewingDismissedId && session._id === currentSessionId}
                globalIndex={0}
                onSelect={() => handleSelectSession(session)}
                onDismiss={stashSession}
                onDefer={deferSession}
                onPin={pinSession}
                onNavigateToSession={handleNavigateToSession}
              />
            ))}
          </div>
        )}

        {working.length > 0 && (
          <div>
            <div className="px-3 py-1.5 bg-sol-bg border-b border-sol-border/30">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-sol-green">
                Working ({working.length})
              </span>
            </div>
            {working.map((session) => (
              <SessionCard
                key={session._id}
                session={session}
                isActive={!viewingDismissedId && session._id === currentSessionId}
                globalIndex={0}
                onSelect={() => handleSelectSession(session)}
                onDismiss={stashSession}
                onDefer={deferSession}
                onPin={pinSession}
                onNavigateToSession={handleNavigateToSession}
                variant="working"
              />
            ))}
          </div>
        )}

        {sortedSessions.length === 0 && (
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
                  onSelect={() => handleSelectSession(session)}
                  onRestore={(id) => unstashSession(id)}
                  onNavigateToSession={handleNavigateToSession}
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
  const router = useRouter();

  // Redirect old /inbox?s=XXX URLs to /conversation/XXX
  useEffect(() => {
    const sessionId = searchParams.get("s");
    if (sessionId) {
      router.replace(`/conversation/${sessionId}`);
    }
  }, [searchParams, router]);

  const [isMac] = useState(() => typeof navigator !== "undefined" && navigator.platform.toUpperCase().includes("MAC"));
  const [showAll, setShowAll] = useState(false);
  const { activeSessions } = useSyncInboxSessions(showAll);
  const sessions = useInboxStore((s) => s.sessions);
  const dismissedSessions = useInboxStore((s) => s.dismissedSessions);
  const currentSessionId = useInboxStore((s) => s.currentSessionId);
  const advanceToNext = useInboxStore((s) => s.advanceToNext);
  const navigateUp = useInboxStore((s) => s.navigateUp);
  const navigateDown = useInboxStore((s) => s.navigateDown);
  const stashSession = useInboxStore((s) => s.stashSession);
  const deferSession = useInboxStore((s) => s.deferSession);
  const pinSession = useInboxStore((s) => s.pinSession);
  const setCurrentSession = useInboxStore((s) => s.setCurrentSession);
  const viewingDismissedId = useInboxStore((s) => s.viewingDismissedId);
  const setViewingDismissedId = useInboxStore((s) => s.setViewingDismissedId);
  const touchMru = useInboxStore((s) => s.touchMru);
  const showMySessions = useInboxStore((s) => s.showMySessions);
  const setShowMySessions = useInboxStore((s) => s.setShowMySessions);
  const sortedSessions = useMemo(() => sortSessions(sessions), [sessions]);

  const switcherState = useSessionSwitcher();

  const shortcutsHidden = useInboxStore(s => s.clientState.ui?.inbox_shortcuts_hidden ?? false);
  const updateUI = useInboxStore(s => s.updateClientUI);
  const showShortcuts = !shortcutsHidden;
  const toggleShortcuts = useCallback(() => {
    updateUI({ inbox_shortcuts_hidden: !shortcutsHidden });
  }, [shortcutsHidden, updateUI]);

  const DEFAULT_INBOX_LAYOUT = { main: 76, sidebar: 24 };
  const inboxLayoutPref = useInboxStore(s => s.clientState.layouts?.inbox ?? DEFAULT_INBOX_LAYOUT);
  const updateLayout = useInboxStore(s => s.updateClientLayout);
  const inboxLayout = { "inbox-main": inboxLayoutPref.main, "inbox-sidebar": inboxLayoutPref.sidebar };
  const handleInboxLayoutChange = useCallback((layout: { [key: string]: number }) => {
    updateLayout("inbox", { main: layout["inbox-main"] || 76, sidebar: layout["inbox-sidebar"] || 24 });
  }, [updateLayout]);

  const isPopstateRef = useRef(false);
  const lastAppliedParamId = useRef<string | null>(null);
  const paramProcessedRef = useRef(!searchParams.get("s"));

  const injectSession = useInboxStore((s) => s.injectSession);

  // ID we're trying to navigate to that isn't yet in the queue
  const [pendingInjectId, setPendingInjectId] = useState<string | null>(null);
  const [scrollToMessageId, setScrollToMessageId] = useState<string | null>(null);

  const shouldQueryDirect = pendingInjectId && isConvexId(pendingInjectId);

  // Query conversation for sessions not in the queue
  const directConv = useQuery(
    api.conversations.getConversation,
    shouldQueryDirect ? { conversation_id: pendingInjectId as Id<"conversations">, limit: 1 } : "skip"
  );

  // Select session from URL param -- only when the param actually changes
  const paramSessionId = searchParams.get("s");
  useEffect(() => {
    if (!paramSessionId || paramSessionId === lastAppliedParamId.current) return;
    if (Object.keys(sessions).length === 0 && activeSessions === undefined) return;
    lastAppliedParamId.current = paramSessionId;
    if (sessions[paramSessionId]) {
      setCurrentSession(paramSessionId);
      setPendingInjectId(null);
      paramProcessedRef.current = true;
    } else {
      setPendingInjectId(paramSessionId);
    }
  }, [paramSessionId, sessions, setCurrentSession, activeSessions]);

  // Once we have the conversation data, inject it into the queue
  useEffect(() => {
    if (!pendingInjectId) return;
    if (sessions[pendingInjectId]) {
      setCurrentSession(pendingInjectId);
      setPendingInjectId(null);
      paramProcessedRef.current = true;
      return;
    }
    // Invalid ID format -- query was skipped, redirect immediately
    if (!isConvexId(pendingInjectId)) {
      setPendingInjectId(null);
      paramProcessedRef.current = true;
      window.location.replace(`/conversation/${pendingInjectId}`);
      return;
    }
    // directConv: undefined = still loading, null = not found/no access
    if (directConv === undefined) return;
    if (directConv === null) {
      setPendingInjectId(null);
      paramProcessedRef.current = true;
      window.location.replace(`/conversation/${pendingInjectId}`);
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
    paramProcessedRef.current = true;
  }, [pendingInjectId, directConv, sessions, setCurrentSession, injectSession]);

  // Handle store-based navigation (from CommandPalette, bookmarks, etc.)
  const pendingNavigateId = useInboxStore((s) => s.pendingNavigateId);
  const pendingScrollToMessageId = useInboxStore((s) => s.pendingScrollToMessageId);
  useEffect(() => {
    if (!pendingNavigateId) return;
    const scrollTarget = pendingScrollToMessageId;
    useInboxStore.setState({ pendingNavigateId: null, pendingScrollToMessageId: null, showMySessions: false });
    if (scrollTarget) setScrollToMessageId(scrollTarget);
    if (sessions[pendingNavigateId]) {
      setPendingInjectId(null);
      setCurrentSession(pendingNavigateId);
    } else {
      setPendingInjectId(pendingNavigateId);
    }
  }, [pendingNavigateId, pendingScrollToMessageId, sessions, setCurrentSession]);

  const handleDismiss = useCallback((id: string) => {
    stashSession(id);
  }, [stashSession]);

  const prevSessionRef = useRef(currentSessionId);
  useEffect(() => {
    if (prevSessionRef.current && prevSessionRef.current !== currentSessionId) {
      setScrollToMessageId(null);
    }
    prevSessionRef.current = currentSessionId;
  }, [currentSessionId]);

  const handleDismissCurrent = useCallback(() => {
    if (currentSessionId) handleDismiss(currentSessionId);
  }, [currentSessionId, handleDismiss]);

  const handleDeferCurrent = useCallback(() => {
    if (currentSessionId) deferSession(currentSessionId);
  }, [currentSessionId, deferSession]);

  const handlePinCurrent = useCallback(() => {
    if (currentSessionId) pinSession(currentSessionId);
  }, [currentSessionId, pinSession]);

  const handleSendAndAdvance = useCallback(() => {
    advanceToNext();
  }, [advanceToNext]);

  const toggleShowAll = useCallback(() => {
    setShowAll((v) => !v);
  }, []);

  const viewingDismissedSession = viewingDismissedId
    ? dismissedSessions[viewingDismissedId] ?? null
    : null;

  const setCurrentConversation = useInboxStore((s) => s.setCurrentConversation);

  const rawCurrentSession = currentSessionId ? sessions[currentSessionId] : undefined;
  const currentSession = pendingInjectId && rawCurrentSession && rawCurrentSession._id !== pendingInjectId
    ? undefined
    : rawCurrentSession;

  useEffect(() => {
    if (currentSession) {
      setCurrentConversation({
        conversationId: currentSession._id,
        projectPath: currentSession.project_path,
        gitRoot: currentSession.git_root,
        agentType: currentSession.agent_type,
        source: "inbox",
      });
      touchMru(currentSession._id);
    }
  }, [currentSession?._id, currentSession?.project_path, currentSession?.git_root, currentSession?.agent_type, setCurrentConversation, touchMru]);

  // Sync URL when current session changes (but not before initial param is resolved)
  useEffect(() => {
    if (!paramProcessedRef.current) return;
    if (isPopstateRef.current) {
      isPopstateRef.current = false;
      return;
    }
    const targetId = viewingDismissedId
      ? undefined
      : useInboxStore.getState().getCurrentSession()?._id;
    if (!targetId) return;
    const targetPath = `/conversation/${targetId}`;
    if (window.location.pathname !== targetPath) {
      window.history.replaceState({ inboxId: targetId }, "", targetPath);
    }
  }, [currentSession?._id, viewingDismissedId]);

  // Handle browser back/forward
  useEffect(() => {
    const onPopstate = (e: PopStateEvent) => {
      const url = new URL(window.location.href);
      const id = e.state?.inboxId
        || url.searchParams.get("s")
        || url.pathname.match(/^\/conversation\/([a-z0-9]{32})$/)?.[1];
      if (!id) return;
      if (sessions[id]) {
        isPopstateRef.current = true;
        setCurrentSession(id);
        if (showMySessions) setShowMySessions(false);
      }
    };
    window.addEventListener("popstate", onPopstate);
    return () => window.removeEventListener("popstate", onPopstate);
  }, [sessions, setCurrentSession, showMySessions, setShowMySessions]);

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
        const firstNeedsInput = sortedSessions.find((s) => s.is_idle && s.message_count > 0 && !s.is_pinned);
        if (firstNeedsInput) {
          setCurrentSession(firstNeedsInput._id);
        }
        return;
      }
      const isMac = navigator.platform.toUpperCase().includes("MAC");
      if ((isMac ? e.ctrlKey && !e.shiftKey && e.key === "p" : e.altKey && !e.shiftKey && e.key === "p")) {
        e.preventDefault();
        e.stopImmediatePropagation();
        const firstPinned = sortedSessions.find((s) => s.is_pinned);
        if (firstPinned) {
          setCurrentSession(firstPinned._id);
        }
        return;
      }
      if (e.ctrlKey && e.shiftKey && e.key === "P") {
        e.preventDefault();
        e.stopImmediatePropagation();
        handlePinCurrent();
        return;
      }
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [navigateDown, navigateUp, handleDismissCurrent, handleDeferCurrent, handlePinCurrent, toggleShortcuts, sortedSessions, setCurrentSession]);

  const prefetchIds: string[] = [];
  const seen = new Set<string>();
  if (currentSession) seen.add(currentSession._id);
  for (const s of sortedSessions) {
    if (!seen.has(s._id)) {
      seen.add(s._id);
      prefetchIds.push(s._id);
    }
  }

  const handleNavigateToConversation = useCallback((conversationId: string) => {
    if (sessions[conversationId]) {
      setCurrentSession(conversationId);
    } else {
      useInboxStore.setState({ pendingNavigateId: conversationId });
    }
    if (showMySessions) setShowMySessions(false);
  }, [sessions, setCurrentSession, showMySessions, setShowMySessions]);

  const handleBack = useCallback(() => {
    setShowMySessions(true);
  }, [setShowMySessions]);

  const [mobileSessionsOpen, setMobileSessionsOpen] = useState(false);
  const [isMobileInbox, setIsMobileInbox] = useState(false);

  useEffect(() => {
    const check = () => setIsMobileInbox(window.innerWidth < 768);
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);

  const inboxContent = (
    <>
      {showMySessions ? (
        <div className="h-full overflow-y-auto" data-main-scroll>
          <div className="max-w-4xl mx-auto px-4 py-4">
            <ActivityFeed mode="personal" compact onNavigate={handleNavigateToConversation} />
          </div>
        </div>
      ) : viewingDismissedSession ? (
        <InboxConversation
          key={viewingDismissedSession._id}
          sessionId={viewingDismissedSession._id}
          isIdle={viewingDismissedSession.is_idle}
          onSendAndAdvance={() => setViewingDismissedId(null)}
          lastUserMessage={viewingDismissedSession.last_user_message}
          sessionError={viewingDismissedSession.session_error}
          onBack={handleBack}
        />
      ) : currentSession ? (
        <InboxConversation
          key={currentSession._id}
          sessionId={currentSession._id}
          isIdle={currentSession.is_idle}
          onSendAndAdvance={handleSendAndAdvance}
          lastUserMessage={currentSession.last_user_message}
          sessionError={currentSession.session_error}
          onBack={handleBack}
          targetMessageId={scrollToMessageId && currentSession._id === currentSessionId ? scrollToMessageId : undefined}
        />
      ) : pendingInjectId ? (
        <div className="h-full flex items-center justify-center text-sol-text-dim">
          <div className="flex items-center gap-2">
            <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
            </svg>
            <span className="text-sm">Loading session...</span>
          </div>
        </div>
      ) : (
        <div className="h-full overflow-y-auto" data-main-scroll>
          <div className="max-w-4xl mx-auto px-4 py-4">
            <ActivityFeed mode="personal" compact onNavigate={handleNavigateToConversation} />
          </div>
        </div>
      )}
    </>
  );

  return (
    <DashboardLayout>
      {switcherState.open && (
        <SessionSwitcher
          sessions={switcherState.mruSessions}
          selectedIndex={switcherState.selectedIndex}
        />
      )}
      <div className="flex flex-col h-full">
      {isMobileInbox ? (
        <div className="flex-1 min-h-0 relative">
          <div className="h-full">{inboxContent}</div>
          <button
            onClick={() => setMobileSessionsOpen(!mobileSessionsOpen)}
            className="absolute top-2 right-2 z-30 flex items-center gap-1.5 px-3 py-2 rounded-lg bg-sol-bg-alt/95 border border-sol-border/60 text-sol-text-dim text-xs backdrop-blur-sm shadow-md hover:text-sol-text hover:border-sol-border transition-colors"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h7" />
            </svg>
            {sortedSessions.length}
          </button>
          {mobileSessionsOpen && (
            <>
              <div className="fixed inset-0 z-40 bg-black/50" onClick={() => setMobileSessionsOpen(false)} />
              <div className="fixed inset-y-0 right-0 z-50 w-[80vw] max-w-xs shadow-xl animate-slide-in-right">
                <InboxSessionPanel showAll={showAll} onToggleShowAll={toggleShowAll} dismissedSessions={Object.values(dismissedSessions)} />
              </div>
            </>
          )}
        </div>
      ) : (
        <Group orientation="horizontal" className="flex-1 min-h-0" defaultLayout={inboxLayout} onLayoutChange={handleInboxLayoutChange}>
          <Panel id="inbox-main" defaultSize="76%" minSize="30%">
            {inboxContent}
          </Panel>
          <Separator className="relative w-px bg-sol-border/50 hover:bg-sol-cyan data-[resize-handle-active]:bg-sol-cyan cursor-col-resize transition-colors duration-150 before:absolute before:inset-y-0 before:-left-1 before:-right-1 before:content-['']" />
          <Panel id="inbox-sidebar" defaultSize="24%" minSize="0%" maxSize="45%" collapsible collapsedSize="0%">
            <InboxSessionPanel showAll={showAll} onToggleShowAll={toggleShowAll} dismissedSessions={Object.values(dismissedSessions)} />
          </Panel>
        </Group>
      )}
      {showShortcuts && !isMobileInbox && (
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
            <kbd className="px-1 py-0.5 bg-sol-bg rounded border border-sol-border/80">{isMac ? "Ctrl" : "Alt"}</kbd>
            <kbd className="px-1 py-0.5 bg-sol-bg rounded border border-sol-border/80">P</kbd>
            pinned
          </span>
          <span className="flex items-center gap-1">
            <kbd className="px-1 py-0.5 bg-sol-bg rounded border border-sol-border/80">Ctrl+Shift</kbd>
            <kbd className="px-1 py-0.5 bg-sol-bg rounded border border-sol-border/80">P</kbd>
            pin
          </span>
          <span className="flex items-center gap-1">
            <kbd className="px-1 py-0.5 bg-sol-bg rounded border border-sol-border/80">Shift</kbd>
            <kbd className="px-1 py-0.5 bg-sol-bg rounded border border-sol-border/80">←</kbd>
            defer
          </span>
          <span className="flex items-center gap-1">
            <kbd className="px-1 py-0.5 bg-sol-bg rounded border border-sol-border/80">Ctrl</kbd>
            <kbd className="px-1 py-0.5 bg-sol-bg rounded border border-sol-border/80">←</kbd>
            dismiss
          </span>
          <span className="flex items-center gap-1">
            <kbd className="px-1 py-0.5 bg-sol-bg rounded border border-sol-border/80">Ctrl</kbd>
            <kbd className="px-1 py-0.5 bg-sol-bg rounded border border-sol-border/80">Tab</kbd>
            switch
          </span>
          <span className="flex items-center gap-1">
            <kbd className="px-1 py-0.5 bg-sol-bg rounded border border-sol-border/80">Ctrl</kbd>
            <kbd className="px-1 py-0.5 bg-sol-bg rounded border border-sol-border/80">.</kbd>
            zen
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
