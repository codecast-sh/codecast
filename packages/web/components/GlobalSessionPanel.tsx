import React, { useState, useCallback, useRef, memo, useMemo } from "react";
import { useWatchEffect } from "../hooks/useWatchEffect";
import { useMutation, useQuery } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { Id } from "@codecast/convex/convex/_generated/dataModel";
import { ConversationDiffLayout } from "./ConversationDiffLayout";
import { ConversationData } from "./ConversationView";
import { useConversationMessages } from "../hooks/useConversationMessages";
import { useInboxStore, InboxSession, getSessionRenderKey, isConvexId, categorizeSessions, isInterruptControlMessage, getProjectName, isFork } from "../store/inboxStore";
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from "./ui/tooltip";
import { cleanTitle } from "../lib/conversationProcessor";
import { SharePopover } from "./SharePopover";
import { PlanContextPanel } from "./PlanContextPanel";
import { WorkflowContextPanel } from "./WorkflowContextPanel";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { undoableStashSession } from "../store/undoActions";
import { formatShortcutLabel } from "../shortcuts";
import { X, ChevronsLeft, ChevronsRight } from "lucide-react";
import { TaskStatusBadge } from "./TaskStatusBadge";
import { useTipActions, checkMilestone } from "../tips";
import { TeamIcon, IconColorPicker, getSessionIconDefaults, type TeamIconName, type TeamColorName } from "./TeamIcon";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
} from "./ui/dropdown-menu";

const NOISE_PREFIXES = ["[Request interrupted", "This session is being continued", "Your task is to create a detailed summary", "Please continue the conversation", "<task-notification>", "Implement the following plan"];

const NOISE_PATTERNS = [
  /toolu_[A-Za-z0-9_-]+/,
  /\/private\/tmp\/claude/,
  /\/tmp\/claude-\d+\//,
  /\.output<\/out/,
  /tasks\/[a-z0-9]+\.output/,
];

export function cleanUserMessage(raw: string | null | undefined): string | null {
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

export function formatIdleDuration(updatedAt: number): string {
  const diff = Date.now() - updatedAt;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export { getProjectName } from "../store/inboxStore";

// -- InboxConversation (shared) --

export const InboxConversation = memo(function InboxConversation({ sessionId, isIdle, onSendAndAdvance, onSendAndDismiss, lastUserMessage, sessionError, onBack, targetMessageId, backHref, onExpandToMain, onClose }: { sessionId: string; isIdle: boolean; onSendAndAdvance: () => void; onSendAndDismiss?: () => void; lastUserMessage?: string | null; sessionError?: string; onBack?: () => void; targetMessageId?: string; backHref?: string; onExpandToMain?: () => void; onClose?: () => void }) {
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
  const repairSessionMutation = useMutation(api.conversations.repairSession);
  const setPrivacy = useMutation(api.conversations.setPrivacy);
  const setTeamVisibility = useMutation(api.conversations.setTeamVisibility);
  const generateShareLink = useMutation(api.conversations.generateShareLink);
  const [resumeState, setResumeState] = useState<"idle" | "resuming" | "sent" | "reconstituting" | "failed">("idle");
  const forceRestartAttemptedRef = useRef(false);
  const reconstitutionAttemptedRef = useRef(false);

  const lastMsg = conversation?.messages?.[conversation.messages.length - 1];
  const lastRoleIsUser = lastMsg?.role === "user";
  const isStale = (Date.now() - (conversation?.updated_at || 0)) > 5 * 60 * 1000;
  const looksAbandoned = isIdle && lastRoleIsUser && !isInterruptControlMessage(lastMsg?.content) && isStale;

  useWatchEffect(() => {
    if (!isIdle && (resumeState === "sent" || resumeState === "resuming" || resumeState === "reconstituting")) {
      setResumeState("idle");
      forceRestartAttemptedRef.current = false;
      reconstitutionAttemptedRef.current = false;
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
      } else if (!reconstitutionAttemptedRef.current && isConvexId(sessionId)) {
        reconstitutionAttemptedRef.current = true;
        setResumeState("reconstituting");
        try {
          await repairSessionMutation({ conversation_id: sessionId as Id<"conversations"> });
          setResumeState("reconstituting");
        } catch {
          setResumeState("failed");
        }
      } else {
        setResumeState("failed");
      }
    }, 90_000);
    return () => clearTimeout(timeout);
  }, [resumeState, sessionId, restartSessionMutation, repairSessionMutation]);

  useWatchEffect(() => {
    if (resumeState !== "reconstituting") return;
    const timeout = setTimeout(() => {
      setResumeState("failed");
    }, 60_000);
    return () => clearTimeout(timeout);
  }, [resumeState]);

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

  const activePlanId = (conversation as any)?.active_plan_id;
  const workflowRunId = (conversation as any)?.workflow_run_id;

  return (
    <div className="relative h-full flex flex-col">
      {(resumeState === "resuming" || resumeState === "sent") && (
        <div className="absolute top-0 left-0 right-0 z-10 flex items-center gap-2 px-4 py-1.5 bg-sol-orange/90 text-sol-bg text-xs backdrop-blur-sm">
          <span className="w-1.5 h-1.5 rounded-full bg-sol-bg animate-pulse" />
          Resuming session...
        </div>
      )}
      {resumeState === "reconstituting" && (
        <div className="absolute top-0 left-0 right-0 z-10 flex items-center gap-2 px-4 py-1.5 bg-sol-orange/90 text-sol-bg text-xs backdrop-blur-sm">
          <span className="w-1.5 h-1.5 rounded-full bg-sol-bg animate-pulse" />
          Reconstituting session from database...
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
      <div className="h-full">
        <ConversationDiffLayout
          conversation={conversation as ConversationData}
          embedded
          headerExtra={shareControls}
          headerEnd={onClose ? (
            <button onClick={onClose} className="p-1 rounded text-sol-text-dim hover:text-sol-text transition-colors" title="Close">
              <X className="w-3.5 h-3.5" />
            </button>
          ) : undefined}
          headerLeft={onExpandToMain ? (
            <button onClick={onExpandToMain} className="p-0.5 rounded text-sol-text-dim hover:text-sol-cyan transition-colors flex-shrink-0" title="Go to inbox">
              <ChevronsLeft className="w-4 h-4" />
            </button>
          ) : undefined}
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
          onSendAndDismiss={onSendAndDismiss}
          autoFocusInput
          backHref={backHref}
          onBack={onBack}
          fallbackStickyContent={cleanUserMessage(lastUserMessage)}
          targetMessageId={targetMessageId}
          subHeaderContent={<>
            {activePlanId && <PlanContextPanel planId={activePlanId} />}
            {workflowRunId && <WorkflowContextPanel workflowRunId={workflowRunId} />}
          </>}
        />
      </div>
    </div>
  );
});

// -- SessionCard (shared) --

export function SessionCard({
  session,
  isActive,
  isParentActive,
  globalIndex,
  onSelect,
  onDismiss,
  onDefer,
  onPin,
  onRestore,
  onKill,
  onNavigateToSession,
  variant = "default",
}: {
  session: InboxSession;
  isActive: boolean;
  isParentActive?: boolean;
  globalIndex: number;
  onSelect: (index: number) => void;
  onDismiss?: (id: string) => void;
  onDefer?: (id: string) => void;
  onPin?: (id: string) => void;
  onRestore?: (id: string) => void;
  onKill?: (id: string) => void;
  onNavigateToSession?: (id: string) => void;
  variant?: "default" | "working" | "dismissed";
}) {
  const tipActions = useTipActions();
  const project = getProjectName(session.git_root, session.project_path);
  const isWorking = variant === "working";
  const isDismissed = variant === "dismissed";
  const isSubagent = !!session.is_subagent || !!session.parent_conversation_id || !!session.worktree_name;
  const displayTitle = cleanTitle(session.title || "New Session");
  const isSlashCommand = displayTitle.startsWith("/");
  const cleanedUserMsg = cleanUserMessage(session.last_user_message);

  const setConversationIcon = useMutation(api.conversations.setConversationIcon);
  const iconDefaults = getSessionIconDefaults(session._id);
  const effectiveIcon = (session.icon || iconDefaults.icon) as TeamIconName;
  const effectiveColor = (session.icon_color || iconDefaults.color) as TeamColorName;

  const handleIconChange = useCallback(async (icon: string) => {
    try { await setConversationIcon({ conversation_id: session._id as Id<"conversations">, icon }); }
    catch { toast.error("Failed to update icon"); }
  }, [session._id, setConversationIcon]);

  const handleColorChange = useCallback(async (color: string) => {
    try { await setConversationIcon({ conversation_id: session._id as Id<"conversations">, icon_color: color }); }
    catch { toast.error("Failed to update color"); }
  }, [session._id, setConversationIcon]);

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
        data-session-id={session._id}
        onDragEnter={handleFileDragEnter}
        onDragOver={handleFileDragOver}
        onDragLeave={handleFileDragLeave}
        onDrop={handleFileDrop}
        className={`relative group transition-colors overflow-hidden ${isDragOver ? "ring-1 ring-inset ring-violet-400/40 bg-violet-500/10" : ""} ${
          isActive
            ? "bg-violet-500/[0.08] border-l-2 border-l-violet-400/60"
            : isParentActive
              ? "bg-sol-cyan/[0.10] border-l border-l-sol-cyan/40"
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
            <TeamIcon icon={effectiveIcon} color={effectiveColor} className="w-3 h-3 flex-shrink-0 opacity-50" />
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
              {!session.is_idle && !session.session_error && !session.is_unresponsive && !session.has_pending && (
                <span className="relative flex h-1.5 w-1.5" title="Live">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                  <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-emerald-400" />
                </span>
              )}
              {session.is_idle && !session.session_error && !session.is_unresponsive && !session.has_pending && session.message_count > 0 && (
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
        {(onRestore || onKill) && (
          <div className="absolute top-1 right-1.5 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
            {onKill && (
              <button
                onClick={(e) => { e.stopPropagation(); onKill(session._id); }}
                className="p-0.5 rounded text-gray-500 hover:text-sol-red transition-colors"
              >
                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            )}
            {onRestore && (
              <button
                onClick={(e) => { e.stopPropagation(); onRestore(session._id); }}
                className="p-0.5 rounded text-gray-500 hover:text-violet-400 transition-colors"
              >
                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 17L7 7M7 7h6M7 7v6" />
                </svg>
              </button>
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      data-session-id={session._id}
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
        <div className={`flex items-center gap-1.5 leading-tight ${
          isActive ? "text-sm text-sol-text font-semibold" : isWorking ? "text-sm text-sol-text font-medium" : isDismissed ? "text-sm text-sol-text-muted" : "text-sm text-sol-text"
        }`}>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                className="flex-shrink-0 rounded hover:bg-sol-bg-highlight/60 p-0.5 transition-colors"
                onClick={(e) => { e.stopPropagation(); }}
              >
                <TeamIcon icon={effectiveIcon} color={effectiveColor} className="w-4 h-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-56 p-3">
              <IconColorPicker currentIcon={effectiveIcon} currentColor={effectiveColor} onIconChange={handleIconChange} onColorChange={handleColorChange} />
            </DropdownMenuContent>
          </DropdownMenu>
          <span className="truncate">{isSlashCommand ? <span className="font-mono text-sol-cyan">{displayTitle}</span> : displayTitle}</span>
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
            {isFork(session) && (
              <span className="inline-flex items-center gap-0.5 px-1 py-0 rounded text-[9px] font-medium bg-sol-cyan/10 text-sol-cyan border border-sol-cyan/20" title="Fork">
                <svg className="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                  <circle cx="12" cy="18" r="3" />
                  <circle cx="6" cy="6" r="3" />
                  <circle cx="18" cy="6" r="3" />
                  <path d="M18 9v2c0 .6-.4 1-1 1H7c-.6 0-1-.4-1-1V9" />
                  <path d="M12 12v3" />
                </svg>
                fork
              </span>
            )}
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
            {session.is_workflow_primary && session.workflow_run_status === "paused" && (
              <span className="inline-flex items-center gap-0.5 px-1 py-0 rounded text-[9px] font-semibold bg-sol-magenta/10 text-sol-magenta border border-sol-magenta/30">
                <span className="w-1 h-1 rounded-full bg-sol-magenta animate-pulse" />
                Gate
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
                    onClick={(e) => { e.stopPropagation(); onPin(session._id); tipActions.whisper('session.pin', e); if (!session.is_pinned) checkMilestone('m-first-pin'); }}
                    className={`p-1 rounded transition-colors ${session.is_pinned ? 'text-sol-magenta' : 'text-sol-text-dim hover:text-sol-magenta'}`}
                  >
                    <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill={session.is_pinned ? "currentColor" : "none"} stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                      <path d="M12 17v5" />
                      <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76z" />
                    </svg>
                  </button>
                </TooltipTrigger>
                <TooltipContent side="left">{session.is_pinned ? "Unpin" : "Pin"} ({formatShortcutLabel('session.pin')})</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
          {onDefer && (
            <TooltipProvider delayDuration={300}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={(e) => { e.stopPropagation(); onDefer(session._id); tipActions.whisper('session.deferAdvance', e); }}
                    className="p-1 rounded text-sol-text-dim hover:text-sol-yellow transition-colors"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 3v14m0 0l-6-6m6 6l6-6M5 21h14" />
                    </svg>
                  </button>
                </TooltipTrigger>
                <TooltipContent side="left">Defer ({formatShortcutLabel('session.deferAdvance')})</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
          {onDismiss && (
            <TooltipProvider delayDuration={300}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={(e) => { e.stopPropagation(); onDismiss(session._id); tipActions.whisper('session.stash', e); checkMilestone('m-first-stash'); }}
                    className="p-1 rounded text-sol-text-dim hover:text-sol-red transition-colors"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 7l10 10M17 17h-6m6 0v-6" />
                    </svg>
                  </button>
                </TooltipTrigger>
                <TooltipContent side="left">Dismiss ({formatShortcutLabel('session.stash')})</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
        </div>
      )}
      {(onRestore || onKill) && (
        <div className="absolute top-1.5 right-1.5 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
          {onKill && (
            <TooltipProvider delayDuration={300}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={(e) => { e.stopPropagation(); onKill(session._id); }}
                    className="p-1 rounded-md text-sol-text-dim hover:text-sol-red bg-sol-bg/95 backdrop-blur-sm shadow-sm border border-sol-border/30"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </TooltipTrigger>
                <TooltipContent side="left">Kill ({formatShortcutLabel('session.kill')})</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
          {onRestore && (
            <TooltipProvider delayDuration={300}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={(e) => { e.stopPropagation(); onRestore(session._id); }}
                    className="p-1 rounded-md text-sol-text-dim hover:text-sol-cyan bg-sol-bg/95 backdrop-blur-sm shadow-sm border border-sol-border/30"
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
      )}
    </div>
  );
}

// -- SessionListPanel (shared) --

function NeedsAttentionSection() {
  const blockedTasks = useQuery(api.tasks.webList, { execution_status: "blocked", limit: 20 });
  const needsContextTasks = useQuery(api.tasks.webList, { execution_status: "needs_context", limit: 20 });
  const updateTask = useMutation(api.tasks.webUpdate);
  const [collapsed, setCollapsed] = useState(false);

  const tasks = useMemo(() => {
    const blockedItems = blockedTasks && "items" in blockedTasks ? blockedTasks.items : [];
    const needsContextItems = needsContextTasks && "items" in needsContextTasks ? needsContextTasks.items : [];
    const all = [...blockedItems, ...needsContextItems] as any[];
    const seen = new Set<string>();
    return all.filter(t => {
      if (seen.has(t.short_id)) return false;
      seen.add(t.short_id);
      return true;
    });
  }, [blockedTasks, needsContextTasks]);

  if (tasks.length === 0) return null;

  const handleRetry = async (shortId: string) => {
    try {
      await updateTask({ short_id: shortId, execution_status: "", status: "open" });
      toast.success("Task reset for retry");
    } catch {
      toast.error("Failed to reset task");
    }
  };

  return (
    <div className="border-b border-sol-red/20">
      <button
        onClick={() => setCollapsed(!collapsed)}
        className="w-full px-3 py-1.5 bg-sol-red/[0.06] border-b border-sol-red/15 flex items-center justify-between"
      >
        <span className="text-[10px] font-semibold uppercase tracking-wider text-sol-red">
          Needs Attention ({tasks.length})
        </span>
        <svg
          className={`w-3 h-3 text-sol-red/60 transition-transform ${collapsed ? "" : "rotate-180"}`}
          fill="none" stroke="currentColor" viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {!collapsed && tasks.map((task: any) => (
        <div
          key={task.short_id}
          className="group px-3 py-2 border-b border-sol-border/20 bg-sol-red/[0.03] hover:bg-sol-red/[0.06] transition-colors"
        >
          <div className="flex items-start gap-2">
            <div className="flex-1 min-w-0">
              <div className="text-sm text-sol-text truncate leading-tight">{task.title}</div>
              <div className="flex items-center gap-1.5 mt-1">
                <span className="text-[10px] text-sol-text-dim font-mono">{task.short_id}</span>
                <TaskStatusBadge status={task.execution_status || "blocked"} type="execution" size="sm" />
                {task.plan && (
                  <span className="text-[10px] text-sol-cyan/70 truncate max-w-[100px]" title={task.plan.title}>
                    {task.plan.title}
                  </span>
                )}
              </div>
            </div>
            <button
              onClick={() => handleRetry(task.short_id)}
              className="flex-shrink-0 px-1.5 py-0.5 rounded text-[10px] font-medium text-sol-orange border border-sol-orange/30 bg-sol-orange/10 hover:bg-sol-orange/20 transition-colors opacity-0 group-hover:opacity-100"
            >
              Retry
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

export function SessionListPanel({
  onSessionSelect,
  onForkSelect,
  activeSessionId,
  onCollapse,
}: {
  onSessionSelect?: (id: string) => void;
  onForkSelect?: (forkId: string, parentId: string, parentMessageUuid: string) => void;
  activeSessionId?: string | null;
  onCollapse?: () => void;
}) {
  const showAll = useInboxStore((s) => s.showAllSessions);
  const toggleShowAll = useInboxStore((s) => s.toggleShowAllSessions);
  const hiddenCount = useInboxStore((s) => s.hiddenSessionCount);
  const sessions = useInboxStore((s) => s.sessions);
  const stashSession = useInboxStore((s) => s.stashSession);
  const deferSession = useInboxStore((s) => s.deferSession);
  const pinSession = useInboxStore((s) => s.pinSession);
  const unstashSession = useInboxStore((s) => s.unstashSession);
  const dismissedSessions = useInboxStore((s) => s.dismissedSessions);
  const dismissedList = useMemo(() => Object.values(dismissedSessions), [dismissedSessions]);
  const killSessionMutation = useMutation(api.conversations.killSession);
  const handleKillDismissed = useCallback((id: string) => {
    if (isConvexId(id)) {
      killSessionMutation({ conversation_id: id as Id<"conversations">, mark_completed: true }).catch(() => {});
    }
    const newDismissed = { ...useInboxStore.getState().dismissedSessions };
    delete newDismissed[id];
    useInboxStore.setState({ dismissedSessions: newDismissed });
    toast.success(`Killed session`);
  }, [killSessionMutation]);

  const handleSelect = useCallback((session: InboxSession) => {
    if (isFork(session) && onForkSelect && session.forked_from && session.parent_message_uuid) {
      onForkSelect(session._id, session.forked_from, session.parent_message_uuid);
      return;
    }
    if (onSessionSelect) {
      onSessionSelect(session._id);
    }
  }, [onSessionSelect, onForkSelect]);

  const sessionsWithQueuedMessages = useInboxStore((s) => s.sessionsWithQueuedMessages);
  const activeForkHighlight = useInboxStore((s) => s.activeForkHighlight);
  const { sorted: sortedSessions, pinned, newSessions, needsInput, working, subsByParent: globalSubByParent } = useMemo(
    () => categorizeSessions(sessions, sessionsWithQueuedMessages),
    [sessions, sessionsWithQueuedMessages],
  );

  const projectFilter = useInboxStore((s) => s.activeProjectFilter);
  const setActiveProjectFilter = useInboxStore((s) => s.setActiveProjectFilter);

  const activeSessions = useMemo(() => [...pinned, ...newSessions, ...needsInput, ...working], [pinned, newSessions, needsInput, working]);

  const projectCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const s of activeSessions) {
      const name = getProjectName(s.git_root, s.project_path);
      if (name !== "unknown") counts[name] = (counts[name] || 0) + 1;
    }
    return Object.entries(counts).sort((a, b) => b[1] - a[1]);
  }, [activeSessions]);

  const projectPathByName = useMemo(() => {
    const map: Record<string, string> = {};
    for (const s of activeSessions) {
      const name = getProjectName(s.git_root, s.project_path);
      if (name !== "unknown" && !map[name]) {
        map[name] = s.git_root || s.project_path || "";
      }
    }
    return map;
  }, [activeSessions]);

  const filterByProject = useCallback((items: InboxSession[]) => {
    if (!projectFilter) return items;
    return items.filter((s) => getProjectName(s.git_root, s.project_path) === projectFilter);
  }, [projectFilter]);

  const filteredPinned = useMemo(() => filterByProject(pinned), [filterByProject, pinned]);
  const filteredNew = useMemo(() => filterByProject(newSessions), [filterByProject, newSessions]);
  const filteredNeedsInput = useMemo(() => filterByProject(needsInput), [filterByProject, needsInput]);
  const filteredWorking = useMemo(() => filterByProject(working), [filterByProject, working]);
  const filteredDismissed = useMemo(() => filterByProject(dismissedList), [filterByProject, dismissedList]);
  const filteredCount = filteredPinned.length + filteredNew.length + filteredNeedsInput.length + filteredWorking.length;

  const collapsedSections = useInboxStore((s) => s.collapsedSections);
  const toggleSection = useInboxStore((s) => s.toggleCollapsedSection);
  const [expandedSubSessions, setExpandedSubSessions] = useState<Record<string, boolean>>({});
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to the active session when it changes
  useWatchEffect(() => {
    if (!activeSessionId || !scrollContainerRef.current) return;
    const el = scrollContainerRef.current.querySelector(`[data-session-id="${activeSessionId}"]`);
    if (el) el.scrollIntoView({ block: "nearest" });
  }, [activeSessionId]);

  const renderSection = (label: string, items: InboxSession[], color: string, sectionVariant?: "working") => {
    if (items.length === 0) return null;
    const key = label.toLowerCase().replace(/\s+/g, "_");
    const collapsed = !!collapsedSections[key];
    return (
      <div>
        <button
          onClick={() => toggleSection(key)}
          className="w-full px-3 py-1.5 bg-sol-bg border-b border-sol-border/30 flex items-center justify-between"
        >
          <span className={`text-[10px] font-semibold uppercase tracking-wider ${color}`}>
            {label} ({items.length})
          </span>
          <svg className={`w-3 h-3 transition-transform ${color} ${collapsed ? "" : "rotate-180"}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </button>
        {!collapsed && <>
          {items.map((session) => {
            const subs = globalSubByParent.get(session._id) || [];
            const subsExpanded = !!expandedSubSessions[session._id];
            const visibleSubs = subs.length <= 2 ? subs : subsExpanded ? subs : subs.slice(0, 2);
            const hiddenCount = subs.length - visibleSubs.length;
            return (
              <React.Fragment key={session._id}>
                <SessionCard
                  session={session}
                  isActive={session._id === activeSessionId || session._id === activeForkHighlight}
                  globalIndex={0}
                  onSelect={() => handleSelect(session)}
                  onDismiss={stashSession}
                  onDefer={deferSession}
                  onPin={pinSession}
                  variant={sectionVariant || "default"}
                />
                {visibleSubs.map((sub) => (
                  <SessionCard
                    key={sub._id}
                    session={sub}
                    isActive={sub._id === activeSessionId || sub._id === activeForkHighlight}
                    isParentActive={session._id === activeSessionId || session._id === activeForkHighlight}
                    globalIndex={0}
                    onSelect={() => handleSelect(sub)}
                    onDismiss={stashSession}
                    variant={sectionVariant || "default"}
                  />
                ))}
                {hiddenCount > 0 && (
                  <button
                    onClick={() => setExpandedSubSessions((prev) => ({ ...prev, [session._id]: true }))}
                    className="w-full px-2 py-0.5 text-[10px] text-gray-500 hover:text-violet-400 transition-colors text-left pl-[26px]"
                  >
                    +{hiddenCount} more sub-session{hiddenCount > 1 ? "s" : ""}
                  </button>
                )}
                {subsExpanded && subs.length > 2 && (
                  <button
                    onClick={() => setExpandedSubSessions((prev) => ({ ...prev, [session._id]: false }))}
                    className="w-full px-2 py-0.5 text-[10px] text-gray-500 hover:text-violet-400 transition-colors text-left pl-[26px]"
                  >
                    collapse
                  </button>
                )}
              </React.Fragment>
            );
          })}
        </>}
      </div>
    );
  };

  return (
    <div className="h-full w-full flex flex-col bg-sol-bg-alt overflow-hidden">
      <div className="px-3 py-0.5 sm:py-1 border-b border-sol-border/50 flex-shrink-0 flex items-center gap-2 min-h-[31px] min-w-0">
        <span className="text-xs font-medium text-sol-text-dim uppercase tracking-wide flex-shrink-0">
          {projectFilter ? filteredCount : activeSessions.length} Session{(projectFilter ? filteredCount : activeSessions.length) !== 1 ? "s" : ""}
        </span>
        {projectCounts.length > 1 && (
          <div className="flex gap-1 overflow-x-auto min-w-0" style={{ scrollbarWidth: 'none' }}>
            {projectCounts.map(([name, count]) => (
              <button
                key={name}
                onClick={() => {
                  const next = projectFilter === name ? null : name;
                  setActiveProjectFilter(next, next ? (projectPathByName[next] || null) : null);
                }}
                className={`flex-shrink-0 px-2 py-0.5 rounded-full text-[10px] transition-all ${
                  projectFilter === name
                    ? "bg-sol-cyan/20 text-sol-cyan"
                    : "bg-gray-400/10 text-gray-400 hover:bg-gray-400/20 hover:text-gray-500"
                }`}
              >
                {name}
                <span className="ml-0.5 opacity-50">{count}</span>
              </button>
            ))}
          </div>
        )}
        <div className="flex-shrink-0 ml-auto">
          {hiddenCount > 0 && (
            <button onClick={toggleShowAll} className="text-[10px] text-sol-text-dim hover:text-sol-cyan transition-colors whitespace-nowrap">
              {showAll ? `−${hiddenCount} old` : `+${hiddenCount} old`}
            </button>
          )}
        </div>
      </div>
      <div ref={scrollContainerRef} className="flex-1 overflow-y-auto scrollbar-auto">
        {!projectFilter && <NeedsAttentionSection />}
        {renderSection("Pinned", filteredPinned, "text-sol-magenta")}
        {renderSection("New", filteredNew, "text-sol-blue")}
        {renderSection("Needs Input", filteredNeedsInput, "text-sol-yellow")}
        {renderSection("Working", filteredWorking, "text-sol-green", "working")}
        {sortedSessions.length === 0 && (
          <div className="px-3 py-8 text-center text-sm text-sol-text-dim">
            No active sessions
          </div>
        )}
        <div className="border-t border-sol-border/30">
          <button
            onClick={() => toggleSection("dismissed")}
            className="w-full px-3 py-1.5 bg-sol-bg border-b border-sol-border/30 flex items-center justify-between"
          >
            <span className="text-[10px] font-semibold uppercase tracking-wider text-sol-text-dim">
              Dismissed{filteredDismissed.length > 0 ? ` (${filteredDismissed.length})` : ""}
            </span>
            <svg className={`w-3 h-3 transition-transform text-sol-text-dim ${collapsedSections.dismissed ? "" : "rotate-180"}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </button>
          {!collapsedSections.dismissed && filteredDismissed.length > 0 && (() => {
            const allDismissedIds = new Set(filteredDismissed.map((s) => s._id));
            const subMap = new Map<string, InboxSession[]>();
            for (const s of filteredDismissed) {
              if (s.parent_conversation_id && allDismissedIds.has(s.parent_conversation_id)) {
                if (!subMap.has(s.parent_conversation_id)) subMap.set(s.parent_conversation_id, []);
                subMap.get(s.parent_conversation_id)!.push(s);
              }
            }
            for (const subs of subMap.values()) {
              subs.sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0));
            }
            const subsWithParent = new Set(Array.from(subMap.values()).flat().map((s) => s._id));
            const orphanedSub = (s: InboxSession) =>
              !subsWithParent.has(s._id) && s.parent_conversation_id && sessions[s.parent_conversation_id];
            const topLevel = filteredDismissed.filter((s) => !subsWithParent.has(s._id) && !orphanedSub(s));
            return (
            <div>
              {topLevel.map((session) => (
                <React.Fragment key={session._id}>
                  <SessionCard
                    session={session}
                    isActive={session._id === activeSessionId}
                    globalIndex={-1}
                    onSelect={() => handleSelect(session)}
                    onRestore={(id) => unstashSession(id)}
                    onKill={handleKillDismissed}
                    variant="dismissed"
                  />
                  {subMap.get(session._id)?.map((sub) => (
                    <SessionCard
                      key={sub._id}
                      session={sub}
                      isActive={sub._id === activeSessionId}
                      isParentActive={session._id === activeSessionId}
                      globalIndex={-1}
                      onSelect={() => handleSelect(sub)}
                      onRestore={(id) => unstashSession(id)}
                      onKill={handleKillDismissed}
                      variant="dismissed"
                    />
                  ))}
                </React.Fragment>
              ))}
            </div>
            );
          })()}
        </div>
      </div>
      {onCollapse && (
        <div className="flex-shrink-0 border-t border-sol-border/30 flex justify-center py-1">
          <button
            onClick={onCollapse}
            className="p-1 rounded text-sol-text-dim/40 hover:text-sol-text-dim transition-colors"
            title="Collapse to rail"
          >
            <ChevronsRight className="w-3.5 h-3.5" />
          </button>
        </div>
      )}
    </div>
  );
}

// -- CollapsedSessionRail --

export function CollapsedSessionRail() {
  const sessions = useInboxStore((s) => s.sessions);
  const selectPanelSession = useInboxStore((s) => s.selectPanelSession);
  const toggleSidePanel = useInboxStore((s) => s.toggleSidePanel);
  const queuedSet = useInboxStore((s) => s.sessionsWithQueuedMessages);

  const { pinned, needsInput, working, newSessions } = useMemo(
    () => categorizeSessions(sessions, queuedSet),
    [sessions, queuedSet],
  );

  const getStatusStyle = (s: InboxSession): { bg: string; pulse: boolean } => {
    if (s.session_error) return { bg: "#dc322f", pulse: false };
    if (s.is_unresponsive) return { bg: "#cb4b16", pulse: false };
    if (s.is_pinned && s.is_idle) return { bg: "#d33682", pulse: false };
    if (!s.is_idle && s.message_count > 0) return { bg: "#859900", pulse: true };
    if (s.is_idle && s.message_count > 0) return { bg: "#b58900", pulse: false };
    return { bg: "rgba(38, 139, 210, 0.4)", pulse: false };
  };

  const groups = [pinned, needsInput, working, newSessions].filter((g) => g.length > 0);
  const needsInputCount = needsInput.length;

  return (
    <div
      className="w-[30px] h-full flex-shrink-0 bg-sol-bg-alt/30 border-l border-sol-border/20 hover:bg-sol-bg-alt/60 transition-colors cursor-pointer flex flex-col"
      onClick={toggleSidePanel}
    >
      <TooltipProvider delayDuration={150}>
        <div className="flex flex-col items-center gap-[6px] pt-3">
          {groups.map((group, gi) => (
            <div key={gi} className={`flex flex-col items-center gap-[6px] ${gi > 0 ? "mt-2" : ""}`}>
              {group.map((s) => {
                const status = getStatusStyle(s);
                return (
                  <Tooltip key={s._id}>
                    <TooltipTrigger asChild>
                      <button
                        className={`w-1.5 h-1.5 rounded-full flex-shrink-0 transition-all hover:scale-[2] cursor-pointer ${status.pulse ? "animate-pulse" : ""}`}
                        style={{ backgroundColor: status.bg }}
                        onClick={(e) => { e.stopPropagation(); selectPanelSession(s._id); }}
                      />
                    </TooltipTrigger>
                    <TooltipContent side="left">{cleanTitle(s.title || "New Session")}</TooltipContent>
                  </Tooltip>
                );
              })}
            </div>
          ))}
        </div>
      </TooltipProvider>
      {needsInputCount > 0 && (
        <div className="mt-auto mb-1 flex justify-center">
          <div className="w-3.5 h-3.5 rounded-full flex items-center justify-center" style={{ backgroundColor: "#b58900" }}>
            <span className="text-[8px] font-bold text-sol-bg leading-none">{needsInputCount}</span>
          </div>
        </div>
      )}
      <div className={`${needsInputCount > 0 ? "" : "mt-auto"} mb-2 flex justify-center`}>
        <button
          onClick={(e) => { e.stopPropagation(); toggleSidePanel(); }}
          className="p-0.5 rounded text-sol-text-dim/30 hover:text-sol-text-dim transition-colors"
          title="Expand session list"
        >
          <ChevronsLeft className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}

// -- ConversationColumn (session panel for non-inbox pages) --

export const ConversationColumn = memo(function ConversationColumn() {
  const sidePanelSessionId = useInboxStore(s => s.sidePanelSessionId);
  const sessions = useInboxStore(s => s.sessions);
  const dismissedSessions = useInboxStore(s => s.dismissedSessions);
  const selectPanelSession = useInboxStore(s => s.selectPanelSession);
  const closeSidePanel = useInboxStore(s => s.closeSidePanel);
  const router = useRouter();

  const session = sidePanelSessionId ? (sessions[sidePanelSessionId] ?? dismissedSessions[sidePanelSessionId] ?? null) : null;
  const sessionRenderKey = getSessionRenderKey(session);

  useWatchEffect(() => {
    if (sidePanelSessionId && !session) selectPanelSession(null);
  });

  const handleBack = useCallback(() => {
    selectPanelSession(null);
  }, [selectPanelSession]);

  const handleExpand = useCallback(() => {
    if (!sidePanelSessionId) return;
    closeSidePanel();
    router.push(`/conversation/${sidePanelSessionId}`);
  }, [sidePanelSessionId, closeSidePanel, router]);

  const handleClose = useCallback(() => {
    selectPanelSession(null);
  }, [selectPanelSession]);

  const handleSendAndDismiss = useCallback(() => {
    if (sidePanelSessionId) undoableStashSession(sidePanelSessionId);
  }, [sidePanelSessionId]);

  if (!session || !sidePanelSessionId) return null;

  return (
    <div className="h-full flex flex-col">
      <div className="h-full">
        <InboxConversation
          key={sessionRenderKey || sidePanelSessionId}
          sessionId={sidePanelSessionId}
          isIdle={session.is_idle}
          onSendAndAdvance={() => {}}
          onSendAndDismiss={handleSendAndDismiss}
          lastUserMessage={session.last_user_message}
          sessionError={session.session_error}
          onBack={handleBack}
          onExpandToMain={handleExpand}
          onClose={handleClose}
        />
      </div>
    </div>
  );
});
