import { useState, useCallback, useRef, memo, useMemo } from "react";
import { useMountEffect } from "../../hooks/useMountEffect";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { useEventListener } from "../../hooks/useEventListener";
import { useShortcutContext } from "../../shortcuts";
import { useQuery, useMutation } from "convex/react";
import { useSearchParams, useRouter } from "next/navigation";
import { api } from "@codecast/convex/convex/_generated/api";
import { Id } from "@codecast/convex/convex/_generated/dataModel";
import { DashboardLayout } from "../../components/DashboardLayout";
import { KeyCap } from "../../components/KeyboardShortcutsHelp";
import { ErrorBoundary } from "../../components/ErrorBoundary";
import { ConversationDiffLayout } from "../../components/ConversationDiffLayout";
import { ConversationData } from "../../components/ConversationView";
import { useConversationMessages } from "../../hooks/useConversationMessages";
import { useInboxStore, InboxSession, getSessionRenderKey, isConvexId, sortSessions, isInterruptControlMessage } from "../../store/inboxStore";
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from "../../components/ui/tooltip";
import { cleanTitle } from "../../lib/conversationProcessor";
import { SharePopover } from "../../components/SharePopover";
import { ActivityFeed } from "../../components/ActivityFeed";
import { TaskStatusBadge } from "../../components/TaskStatusBadge";
import { PlanContextPanel } from "../../components/PlanContextPanel";
import { WorkflowContextPanel } from "../../components/WorkflowContextPanel";
import { toast } from "sonner";
import { undoableStashSession } from "../../store/undoActions";
import { cleanUserMessage, formatIdleDuration, getProjectName, SessionListPanel } from "../../components/GlobalSessionPanel";

const InboxConversation = memo(function InboxConversation({ sessionId, isIdle, onSendAndAdvance, onSendAndDismiss, lastUserMessage, sessionError, onBack, targetMessageId }: { sessionId: string; isIdle: boolean; onSendAndAdvance: () => void; onSendAndDismiss?: () => void; lastUserMessage?: string | null; sessionError?: string; onBack?: () => void; targetMessageId?: string }) {
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
  const looksAbandoned = isIdle && lastRoleIsUser && !isInterruptControlMessage(lastMsg?.content) && isStale;

  useWatchEffect(() => {
    if (!isIdle && (resumeState === "sent" || resumeState === "resuming")) {
      setResumeState("idle");
      forceRestartAttemptedRef.current = false;
    }
  }, [isIdle, resumeState]);

  useWatchEffect(() => {
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
  const isOwnSession = (conversation as any).is_own !== false;
  const shareUrl = conversation.share_token
    ? `${typeof window !== "undefined" ? window.location.origin : ""}/conversation/${convId}`
    : null;
  const shareControls = isOwnSession ? (
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
  ) : null;

  const activePlanId = (conversation as any)?.active_plan_id;
  const workflowRunId = (conversation as any)?.workflow_run_id;

  return (
    <div className="relative h-full flex flex-col">
      {isOwnSession && (resumeState === "resuming" || resumeState === "sent") && (
        <div className="absolute top-0 left-0 right-0 z-10 flex items-center gap-2 px-4 py-1.5 bg-sol-orange/90 text-sol-bg text-xs backdrop-blur-sm">
          <span className="w-1.5 h-1.5 rounded-full bg-sol-bg animate-pulse" />
          Resuming session...
        </div>
      )}
      {isOwnSession && resumeState === "failed" && (
        <div className="absolute top-0 left-0 right-0 z-10 flex items-center gap-2 px-4 py-1.5 bg-sol-red/90 text-sol-bg text-xs backdrop-blur-sm">
          <span className="w-1.5 h-1.5 rounded-full bg-sol-bg" />
          Resume timed out
          <button onClick={handleManualResume} className="ml-1 px-1.5 py-0.5 rounded bg-sol-bg/20 hover:bg-sol-bg/30 transition-colors">
            Retry
          </button>
        </div>
      )}
      {isOwnSession && sessionError && resumeState === "idle" && (
        <div className="absolute top-0 left-0 right-0 z-10 flex items-center gap-2 px-4 py-1.5 bg-sol-red/90 text-sol-bg text-xs backdrop-blur-sm">
          <span className="w-1.5 h-1.5 rounded-full bg-sol-bg" />
          {sessionError}
          <button onClick={handleManualResume} className="ml-1 px-1.5 py-0.5 rounded bg-sol-bg/20 hover:bg-sol-bg/30 transition-colors">
            Resume
          </button>
        </div>
      )}
      {isOwnSession && looksAbandoned && !sessionError && resumeState === "idle" && (
        <div className="absolute top-0 left-0 right-0 z-10 flex items-center gap-2 px-4 py-1.5 bg-sol-bg-alt/90 border-b border-sol-border/50 text-sol-text-dim text-xs backdrop-blur-sm">
          <span className="w-1.5 h-1.5 rounded-full bg-sol-text-dim/50" />
          Session unresponsive — send a message or
          <button onClick={handleManualResume} className="px-1.5 py-0.5 rounded bg-sol-cyan/10 hover:bg-sol-cyan/20 border border-sol-cyan/30 text-sol-cyan transition-colors">
            Resume
          </button>
        </div>
      )}
      <div className="h-full">
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
          isOwner={isOwnSession}
          onSendAndAdvance={isOwnSession ? onSendAndAdvance : undefined}
          onSendAndDismiss={isOwnSession ? onSendAndDismiss : undefined}
          autoFocusInput
          backHref="/inbox"
          onBack={onBack}
          targetMessageId={targetMessageId}
          fallbackStickyContent={isOwnSession ? cleanUserMessage(lastUserMessage) : undefined}
          subHeaderContent={<>
            {activePlanId && <PlanContextPanel planId={activePlanId} />}
            {workflowRunId && <WorkflowContextPanel workflowRunId={workflowRunId} />}
          </>}
        />
      </div>
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
  const isSubagent = !!session.is_subagent || !!session.worktree_name;
  const displayTitle = cleanTitle(session.title || "New Session");
  const isSlashCommand = displayTitle.startsWith("/");
  const cleanedUserMsg = cleanUserMessage(session.last_user_message);

  const [isDragOver, setIsDragOver] = useState(false);
  const dragCounter = useRef(0);
  const generateUploadUrl = useMutation(api.images.generateUploadUrl);
  const sendMessage = useMutation(api.pendingMessages.sendMessageToSession);

  const handleFileDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current++;
    if (e.dataTransfer.types.includes("Files")) setIsDragOver(true);
  }, []);

  const handleFileDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleFileDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current--;
    if (dragCounter.current === 0) setIsDragOver(false);
  }, []);

  const handleFileDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current = 0;
    setIsDragOver(false);
    const files = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith("image/"));
    if (files.length === 0) {
      if (e.dataTransfer.files.length > 0) toast.error("Only image files are supported");
      return;
    }
    try {
      const storageIds: Id<"_storage">[] = [];
      for (const file of files) {
        const uploadUrl = await generateUploadUrl({});
        const result = await fetch(uploadUrl, { method: "POST", headers: { "Content-Type": file.type }, body: file });
        const { storageId } = await result.json();
        storageIds.push(storageId);
      }
      await sendMessage({ conversation_id: session._id as Id<"conversations">, content: "[image]", image_storage_ids: storageIds });
      toast.success(`Attached ${files.length} image${files.length > 1 ? "s" : ""} to "${displayTitle}"`);
    } catch {
      toast.error("Failed to attach files");
    }
  }, [session._id, displayTitle, generateUploadUrl, sendMessage]);

  if (isSubagent) {
    return (
      <div
        onDragEnter={handleFileDragEnter}
        onDragOver={handleFileDragOver}
        onDragLeave={handleFileDragLeave}
        onDrop={handleFileDrop}
        className={`relative group transition-colors overflow-hidden ${isDragOver ? "ring-1 ring-inset ring-violet-400/40 bg-violet-500/10" : ""} ${
          isActive
            ? "bg-violet-500/[0.08] border-l-2 border-l-violet-400/60"
            : isWorking
              ? "hover:bg-violet-500/[0.06] border-l border-l-violet-400/25"
              : isDismissed
                ? "opacity-40 hover:opacity-60 hover:bg-violet-500/[0.04]"
                : "hover:bg-violet-500/[0.06] border-l border-l-violet-500/15"
        }`}
      >
        <div
          role="button"
          tabIndex={0}
          onClick={() => onSelect(globalIndex)}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(globalIndex); } }}
          className="w-full text-left cursor-pointer px-2 py-1"
        >
          <div className="flex items-center gap-1.5">
            <svg className="w-3 h-3 text-violet-400/60 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 4v12h12" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M14 12l4 4-4 4" />
            </svg>
            <span className={`truncate text-xs leading-tight flex-1 ${
              isActive ? "text-violet-300 font-medium" : "text-gray-400 font-normal"
            }`}>
              {isSlashCommand ? <span className="font-mono text-violet-400/80">{displayTitle}</span> : displayTitle}
            </span>
            <div className="flex items-center gap-1 flex-shrink-0">
              {session.session_error && (
                <span className="w-1.5 h-1.5 rounded-full bg-sol-red" title={session.session_error} />
              )}
              {session.is_unresponsive && !session.session_error && (
                <span className="w-1.5 h-1.5 rounded-full bg-sol-orange" title="Session unresponsive" />
              )}
              {session.has_pending && !session.is_unresponsive && (
                <span className="w-1.5 h-1.5 rounded-full bg-sol-yellow animate-pulse" title="Message pending" />
              )}
              {isWorking && (
                <span className="relative flex h-1.5 w-1.5" title="Working">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-violet-400 opacity-75" />
                  <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-violet-400" />
                </span>
              )}
              {!isWorking && !isDismissed && session.is_idle && !session.is_connected && !session.session_error && !session.is_unresponsive && !session.has_pending && session.message_count > 0 && (
                <span className="w-1.5 h-1.5 rounded-full bg-gray-500/40 ring-1 ring-gray-500/20" title="Session idle" />
              )}
              {session.message_count > 0 && (
                <span className="text-[9px] text-gray-500 tabular-nums">{session.message_count}</span>
              )}
              <span className="text-[9px] text-gray-500 tabular-nums">
                {formatIdleDuration(session.updated_at)}
              </span>
            </div>
          </div>
          {cleanedUserMsg && (
            <div className="text-[10px] text-gray-500 mt-0.5 truncate leading-snug pl-[18px]">
              <span className="text-gray-600 mr-0.5">&gt;</span>
              {cleanedUserMsg}
            </div>
          )}
          {session.active_task && (
            <div className="flex items-center gap-1 mt-0.5 pl-[18px]">
              <span className="inline-flex items-center px-1 py-0 rounded text-[9px] font-medium bg-violet-900/20 text-violet-400/70 border border-violet-600/20 max-w-[160px] truncate" title={session.active_task.title}>
                {session.active_task.title}
              </span>
            </div>
          )}
        </div>
        {(onDismiss || onDefer || onPin) && (
          <div className={`absolute top-0 bottom-0 right-0 flex items-center py-1 opacity-0 group-hover:opacity-100 transition-opacity pl-8 pr-2 bg-gradient-to-r from-transparent to-sol-bg-alt`}>
            {onDismiss && (
              <button
                onClick={(e) => { e.stopPropagation(); onDismiss(session._id); }}
                className="p-0.5 rounded text-gray-500 hover:text-sol-red transition-colors"
              >
                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            )}
          </div>
        )}
        {onRestore && (
          <button
            onClick={(e) => { e.stopPropagation(); onRestore(session._id); }}
            className="absolute top-1 right-1.5 p-0.5 rounded text-gray-500 hover:text-violet-400 opacity-0 group-hover:opacity-100 transition-opacity"
          >
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 17L7 7M7 7h6M7 7v6" />
            </svg>
          </button>
        )}
      </div>
    );
  }

  return (
    <div
      onDragEnter={handleFileDragEnter}
      onDragOver={handleFileDragOver}
      onDragLeave={handleFileDragLeave}
      onDrop={handleFileDrop}
      className={`relative group border-b border-sol-border/30 transition-colors overflow-hidden ${isDragOver ? "ring-1 ring-inset ring-sol-cyan bg-sol-cyan/10" : ""} ${
        isActive
          ? "bg-sol-cyan/15 border-l-[3px] border-l-sol-cyan shadow-[inset_0_0_16px_rgba(42,161,152,0.12)]"
          : isWorking
            ? "bg-sol-green/[0.04] border-l-2 border-l-sol-green/40 hover:bg-sol-green/[0.08]"
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
        className="w-full text-left cursor-pointer px-2.5 sm:px-3 py-1.5 sm:py-2"
      >
        <div className={`truncate leading-tight ${
          isActive ? "text-sm text-sol-text font-semibold" : isWorking ? "text-sm text-sol-text font-medium" : isDismissed ? "text-sm text-sol-text-muted" : "text-sm text-sol-text"
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
          {project !== "unknown" && (
            <span className={`text-[10px] truncate ${
              isWorking ? "font-medium text-sol-green/70" : "font-medium text-sol-cyan/70"
            }`}>{project}</span>
          )}
          {session.worktree_name && (
            <span className="text-[9px] text-sol-cyan font-mono truncate max-w-[80px]" title={session.worktree_branch || session.worktree_name}>
              {session.worktree_name}
            </span>
          )}
          {session.message_count > 0 && (
            <span className="text-[10px] text-sol-text-dim tabular-nums flex-shrink-0">
              {session.message_count} msg{session.message_count !== 1 ? "s" : ""}
            </span>
          )}
          <div className="flex items-center gap-1.5 flex-shrink-0 ml-auto">
            {session.active_plan && (
              <span className="inline-flex items-center gap-0.5 px-1 py-0 rounded text-[9px] font-medium bg-sol-cyan/10 text-sol-cyan border border-sol-cyan/20 max-w-[120px] truncate" title={session.active_plan.title}>
                {session.active_plan.title}
              </span>
            )}
            {session.active_task && (
              <span className="inline-flex items-center gap-0.5 px-1 py-0 rounded text-[9px] font-medium bg-sol-violet/10 text-sol-violet border border-sol-violet/20 max-w-[140px] truncate" title={session.active_task.title}>
                {session.active_task.title}
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
              <span className="w-1.5 h-1.5 rounded-full bg-sol-text-dim/40 ring-1 ring-sol-text-dim/20" title="Session idle" />
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

// InboxSessionPanel and NeedsAttentionSection moved to GlobalSessionPanel.tsx as shared SessionListPanel

function InboxShortcuts() {
  useShortcutContext('inbox');
  return null;
}

export function QueuePageClient({ initialSessionId }: { initialSessionId?: string } = {}) {
  const searchParams = useSearchParams();
  const router = useRouter();

  // Auto-open session panel when entering inbox (DashboardLayout renders it)
  useMountEffect(() => {
    if (!useInboxStore.getState().sidePanelOpen) {
      useInboxStore.setState({ sidePanelOpen: true });
    }
  });


  const sessions = useInboxStore((s) => s.sessions);
  const clientStateInitialized = useInboxStore((s) => s.clientStateInitialized);
  const dismissedSessions = useInboxStore((s) => s.dismissedSessions);
  const currentSessionId = useInboxStore((s) => s.currentSessionId);
  const advanceToNext = useInboxStore((s) => s.advanceToNext);
  const setCurrentSession = useInboxStore((s) => s.setCurrentSession);
  const viewingDismissedId = useInboxStore((s) => s.viewingDismissedId);
  const setViewingDismissedId = useInboxStore((s) => s.setViewingDismissedId);
  const touchMru = useInboxStore((s) => s.touchMru);
  const showMySessions = useInboxStore((s) => s.showMySessions);
  const setShowMySessions = useInboxStore((s) => s.setShowMySessions);
  const sortedSessions = useMemo(() => sortSessions(sessions), [sessions]);

  const shortcutsHidden = useInboxStore(s => s.clientState.ui?.inbox_shortcuts_hidden ?? false);
  const showShortcuts = !shortcutsHidden;



  const isPopstateRef = useRef(false);
  const lastAppliedParamId = useRef<string | null>(null);
  const paramProcessedRef = useRef(!searchParams.get("s") && !initialSessionId);

  const injectSession = useInboxStore((s) => s.injectSession);

  // ID we're trying to navigate to that isn't yet in the queue
  const [pendingInjectId, setPendingInjectId] = useState<string | null>(null);
  const [scrollTarget, setScrollTarget] = useState<{ sessionId: string; messageId: string } | null>(null);

  const shouldQueryDirect = pendingInjectId && isConvexId(pendingInjectId);

  // Query conversation for sessions not in the queue
  const directConv = useQuery(
    api.conversations.getConversation,
    shouldQueryDirect ? { conversation_id: pendingInjectId as Id<"conversations">, limit: 1 } : "skip"
  );

  // Select session from URL param or initialSessionId -- only when the param actually changes
  const paramSessionId = searchParams.get("s") || initialSessionId || null;
  useWatchEffect(() => {
    if (!paramSessionId || paramSessionId === lastAppliedParamId.current) return;
    if (Object.keys(sessions).length === 0 && !clientStateInitialized) return;
    lastAppliedParamId.current = paramSessionId;
    if (sessions[paramSessionId]) {
      setCurrentSession(paramSessionId);
      setPendingInjectId(null);
      paramProcessedRef.current = true;
    } else {
      setPendingInjectId(paramSessionId);
    }
  }, [paramSessionId, sessions, setCurrentSession, clientStateInitialized]);

  // Once we have the conversation data, inject it into the queue
  useWatchEffect(() => {
    if (!pendingInjectId) return;
    if (sessions[pendingInjectId]) {
      setCurrentSession(pendingInjectId);
      setPendingInjectId(null);
      paramProcessedRef.current = true;
      return;
    }
    // Invalid ID format -- query was skipped, just clear pending state
    if (!isConvexId(pendingInjectId)) {
      setPendingInjectId(null);
      paramProcessedRef.current = true;
      return;
    }
    // directConv: undefined = still loading, null = not found/no access
    if (directConv === undefined) return;
    if (directConv === null) {
      setPendingInjectId(null);
      paramProcessedRef.current = true;
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
  useWatchEffect(() => {
    if (!pendingNavigateId) return;
    const scrollTarget = pendingScrollToMessageId;
    useInboxStore.setState({ pendingNavigateId: null, pendingScrollToMessageId: null, showMySessions: false });
    if (scrollTarget) {
      setScrollTarget({ sessionId: pendingNavigateId, messageId: scrollTarget });
    }
    if (sessions[pendingNavigateId]) {
      setPendingInjectId(null);
      setCurrentSession(pendingNavigateId);
    } else {
      setPendingInjectId(pendingNavigateId);
    }
  }, [pendingNavigateId, pendingScrollToMessageId, sessions, setCurrentSession]);

  const handleDismiss = useCallback((id: string) => {
    undoableStashSession(id);
  }, []);

  const prevSessionRef = useRef(currentSessionId);
  prevSessionRef.current = currentSessionId;


  const handleSendAndAdvance = useCallback(() => {
    advanceToNext();
  }, [advanceToNext]);

  const handleSendAndDismiss = useCallback(() => {
    if (currentSessionId) undoableStashSession(currentSessionId);
  }, [currentSessionId]);

  const handleSessionSelect = useCallback((id: string) => {
    if (sessions[id]) {
      setCurrentSession(id);
      if (showMySessions) setShowMySessions(false);
    } else if (dismissedSessions[id]) {
      setViewingDismissedId(id);
      if (showMySessions) setShowMySessions(false);
    } else {
      useInboxStore.setState({ pendingNavigateId: id, showMySessions: false });
    }
  }, [sessions, dismissedSessions, setCurrentSession, setViewingDismissedId, showMySessions, setShowMySessions]);

  const viewingDismissedSession = viewingDismissedId
    ? dismissedSessions[viewingDismissedId] ?? null
    : null;

  const setCurrentConversation = useInboxStore((s) => s.setCurrentConversation);

  const rawCurrentSession = currentSessionId ? sessions[currentSessionId] : undefined;
  const currentSession = pendingInjectId && rawCurrentSession && rawCurrentSession._id !== pendingInjectId
    ? undefined
    : rawCurrentSession;

  useWatchEffect(() => {
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

  useWatchEffect(() => {
    if (currentSessionId || currentSession || showMySessions || viewingDismissedId || pendingInjectId) return;
    if (sortedSessions.length > 0) setCurrentSession(sortedSessions[0]._id);
  }, [currentSessionId, currentSession, showMySessions, viewingDismissedId, pendingInjectId, sortedSessions, setCurrentSession]);

  // Sync URL when current session changes (but not before initial param is resolved)
  useWatchEffect(() => {
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
  useEventListener("popstate", (e: PopStateEvent) => {
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
  });


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
  const viewingDismissedRenderKey = getSessionRenderKey(viewingDismissedSession);
  const currentSessionRenderKey = getSessionRenderKey(currentSession);

  useMountEffect(() => { setIsMobileInbox(window.innerWidth < 768); });
  useEventListener("resize", () => setIsMobileInbox(window.innerWidth < 768));

  const inboxContent = (
    <>
      {showMySessions ? (
        <div className="h-full overflow-y-auto" data-main-scroll>
          <div className="max-w-4xl mx-auto px-4 py-4">
            <ErrorBoundary name="ActivityFeed" level="inline">
              <ActivityFeed mode="personal" compact onNavigate={handleNavigateToConversation} />
            </ErrorBoundary>
          </div>
        </div>
      ) : viewingDismissedSession ? (
        <ErrorBoundary name="Conversation" level="inline" key={`eb-${viewingDismissedRenderKey}`}>
          <InboxConversation
            key={viewingDismissedRenderKey || viewingDismissedSession._id}
            sessionId={viewingDismissedSession._id}
            isIdle={viewingDismissedSession.is_idle}
            onSendAndAdvance={() => setViewingDismissedId(null)}
            lastUserMessage={viewingDismissedSession.last_user_message}
            sessionError={viewingDismissedSession.session_error}
            onBack={handleBack}
          />
        </ErrorBoundary>
      ) : currentSession ? (
        <ErrorBoundary name="Conversation" level="inline" key={`eb-${currentSessionRenderKey}`}>
          <InboxConversation
            key={
              scrollTarget?.sessionId === currentSession._id
                ? `${currentSessionRenderKey}-${scrollTarget.messageId}`
                : (currentSessionRenderKey || currentSession._id)
            }
            sessionId={currentSession._id}
            isIdle={currentSession.is_idle}
            onSendAndAdvance={handleSendAndAdvance}
            onSendAndDismiss={handleSendAndDismiss}
            lastUserMessage={currentSession.last_user_message}
            sessionError={currentSession.session_error}
            onBack={handleBack}
            targetMessageId={scrollTarget?.sessionId === currentSession._id ? scrollTarget.messageId : undefined}
          />
        </ErrorBoundary>
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
      ) : sortedSessions.length > 0 ? (
        <div className="h-full" />
      ) : (
        <div className="h-full overflow-y-auto" data-main-scroll>
          <div className="max-w-4xl mx-auto px-4 py-4">
            <ErrorBoundary name="ActivityFeed" level="inline">
              <ActivityFeed mode="personal" compact onNavigate={handleNavigateToConversation} />
            </ErrorBoundary>
          </div>
        </div>
      )}
    </>
  );

  return (
    <DashboardLayout>
      <InboxShortcuts />
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
                <SessionListPanel onSessionSelect={handleSessionSelect} activeSessionId={viewingDismissedId ?? currentSessionId} />
              </div>
            </>
          )}
        </div>
      ) : (
        <div className="flex-1 min-h-0">{inboxContent}</div>
      )}
      {showShortcuts && !isMobileInbox && (
        <div className="flex-shrink-0 px-3 py-1 border-t border-sol-border/30 bg-sol-bg-alt/30 flex items-center gap-3 text-[10px] text-sol-text-dim">
          <span className="flex items-center gap-1">
            <span className="flex items-center gap-[2px]"><KeyCap size="xs">{"\u2303"}</KeyCap><KeyCap size="xs">J</KeyCap><span className="text-sol-text-dim/40">/</span><KeyCap size="xs">K</KeyCap></span> nav
          </span>
          <span className="flex items-center gap-1">
            <span className="flex items-center gap-[2px]"><KeyCap size="xs">{"\u2303"}</KeyCap><KeyCap size="xs">I</KeyCap></span> idle
          </span>
          <span className="flex items-center gap-1">
            <span className="flex items-center gap-[2px]"><KeyCap size="xs">{"\u2303"}</KeyCap><KeyCap size="xs">{"\u232b"}</KeyCap></span> dismiss
          </span>
          <button onClick={() => useInboxStore.getState().toggleShortcutsPanel()} className="ml-auto flex items-center gap-1 hover:text-sol-text-muted transition-colors">
            <KeyCap size="xs">?</KeyCap> all shortcuts
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
