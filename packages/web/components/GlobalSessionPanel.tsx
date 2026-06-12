import React, { useState, useCallback, useRef, memo, useMemo } from "react";
import { useWatchEffect } from "../hooks/useWatchEffect";
import { useMutation, useQuery } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { Id } from "@codecast/convex/convex/_generated/dataModel";
import { useRouter } from "next/navigation";
import { ConversationDiffLayout } from "./ConversationDiffLayout";
import { ConversationData } from "./ConversationView";
import { FormattedSummary } from "./FormattedSummary";
import { sessionCardSummary } from "../lib/sessionSummary";
import { useConversationMessages } from "../hooks/useConversationMessages";
import { useInboxStore, useTrackedStore, InboxSession, getSessionRenderKey, isConvexId, categorizeSessions, isInterruptControlMessage, getProjectName, isFork, convHasPendingSend, isAgentActive, sessionsWithPendingSend, isSessionDismissed, resolveSessionAuthor, convBucketMap, groupSessionsForLabelView, sortLabels, BucketItem, BucketAssignmentItem } from "../store/inboxStore";
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from "./ui/tooltip";
import { cleanTitle, msgCountColor, formatModel } from "../lib/conversationProcessor";
import { getLabelColor } from "../lib/labelColors";
import { fmtDuration } from "./scheduleCadence";
import { isSessionMessage } from "./sessionMessage";
import { SharePopover } from "./SharePopover";
import { shareOrigin } from "../lib/utils";
import { PlanContextPanel } from "./PlanContextPanel";
import { WorkflowContextPanel } from "./WorkflowContextPanel";
import { toast } from "sonner";
import { animatedStashSession } from "../store/undoActions";
import { soundKill } from "../lib/sounds";
import { formatShortcutLabel } from "../shortcuts";
import { X, ChevronsLeft, ChevronsRight, List, Clock, Tag } from "lucide-react";
import { LabelChipsRow } from "./LabelChipsRow";
import { TaskStatusBadge } from "./TaskStatusBadge";
import { useTipActions, checkMilestone } from "../tips";

const NOISE_PREFIXES = ["[Request interrupted", "This session is being continued", "Your task is to create a detailed summary", "Please continue the conversation", "<task-notification>", "Implement the following plan", "[Codecast import]"];

const NOISE_PATTERNS = [
  /toolu_[A-Za-z0-9_-]+/,
  /\/private\/tmp\/claude/,
  /\/tmp\/claude-\d+\//,
  /\.output<\/out/,
  /tasks\/[a-z0-9]+\.output/,
];

export function cleanUserMessage(raw: string | null | undefined): string | null {
  if (!raw) return null;
  // An inbound session→session message (cast send) isn't the user's own prompt —
  // skip it so it never surfaces as the sticky fallback or the card preview.
  if (isSessionMessage(raw)) return null;
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
    jumpToTimestamp,
    isJumpingToTarget,
  } = useConversationMessages(sessionId, targetMessageId);

  const convCommand = useInboxStore((s) => s.convCommand);
  const setPrivacy = useInboxStore((s) => s.setPrivacy);
  const setTeamVisibility = useInboxStore((s) => s.setTeamVisibility);
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
          await convCommand(sessionId, "restartSession");
          setResumeState("sent");
        } catch {
          setResumeState("failed");
        }
      } else if (!reconstitutionAttemptedRef.current && isConvexId(sessionId)) {
        reconstitutionAttemptedRef.current = true;
        setResumeState("reconstituting");
        try {
          await convCommand(sessionId, "repairSession");
          setResumeState("reconstituting");
        } catch {
          setResumeState("failed");
        }
      } else {
        setResumeState("failed");
      }
    }, 90_000);
    return () => clearTimeout(timeout);
  }, [resumeState, sessionId, convCommand]);

  useWatchEffect(() => {
    if (resumeState !== "reconstituting") return;
    const timeout = setTimeout(() => {
      setResumeState("failed");
    }, 60_000);
    return () => clearTimeout(timeout);
  }, [resumeState]);

  const handleManualResume = useCallback(() => {
    setResumeState("resuming");
    convCommand(sessionId, "resumeSession")
      .then(() => setResumeState("sent"))
      .catch(() => setResumeState("failed"));
  }, [sessionId, convCommand]);

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
    ? `${shareOrigin()}/conversation/${convId}`
    : null;
  const shareControls = (
    <SharePopover
      isPrivate={conversation.is_private !== false}
      teamVisibility={(conversation as any).team_visibility || (conversation as any).effective_team_visibility}
      hasShareToken={!!conversation.share_token}
      hasTeam={!!(conversation as any).team_id}
      onSetPrivate={() => { setPrivacy(convId, true); toast.success("Made private"); }}
      onSetTeamVisibility={(mode) => { setTeamVisibility(convId, mode); toast.success(mode === "full" ? "Sharing full conversation with team" : "Sharing summary with team"); }}
      onGenerateShareLink={async () => { await generateShareLink({ conversation_id: convId }); return `${shareOrigin()}/conversation/${convId}`; }}
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
        // In normal flow (not an absolute overlay) so it can't be clipped behind
        // the conversation header's higher-z elements. Persistent until resolved,
        // unlike the transient resuming/failed bars above, so it earns its own row.
        <div className="shrink-0 flex items-center gap-2 px-4 py-1.5 bg-sol-red/90 text-sol-bg text-xs backdrop-blur-sm">
          <span className="w-1.5 h-1.5 rounded-full bg-sol-bg flex-shrink-0" />
          <span className="truncate min-w-0 flex-1" title={sessionError}>{sessionError}</span>
          <button onClick={handleManualResume} className="ml-1 px-1.5 py-0.5 rounded bg-sol-bg/20 hover:bg-sol-bg/30 transition-colors flex-shrink-0">
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
      <div className="flex-1 min-h-0">
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
            <button onClick={onExpandToMain} className="p-0.5 rounded text-sol-text-dim hover:text-sol-cyan transition-colors flex-shrink-0" title="Collapse sessions">
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
          onJumpToTimestamp={jumpToTimestamp}
          isOwner={true}
          onSendAndAdvance={onSendAndAdvance}
          onSendAndDismiss={onSendAndDismiss}
          autoFocusInput
          backHref={backHref}
          onBack={onBack}
          fallbackStickyContent={cleanUserMessage(lastUserMessage)}
          targetMessageId={targetMessageId}
          isJumpingToTarget={isJumpingToTarget}
          subHeaderContent={<>
            {activePlanId && <PlanContextPanel planId={activePlanId} />}
            {workflowRunId && <WorkflowContextPanel workflowRunId={workflowRunId} />}
          </>}
        />
      </div>
    </div>
  );
});

// -- Fork tree color --

const FORK_HUES = [30, 60, 120, 180, 200, 220, 260, 45, 90, 160, 240, 280];

function getForkColor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = ((h << 5) - h + id.charCodeAt(i)) | 0;
  const hue = FORK_HUES[((h % FORK_HUES.length) + FORK_HUES.length) % FORK_HUES.length];
  return `hsl(${hue}, 65%, 55%)`;
}

function ForkCorner({ colorKey }: { colorKey: string }) {
  const color = getForkColor(colorKey);
  return (
    <div
      className="absolute top-0 left-0 w-0 h-0"
      style={{
        borderTop: `10px solid ${color}`,
        borderRight: "10px solid transparent",
      }}
    />
  );
}

// Badge for a session parked on an unresolved Claude Code auth/API-error banner
// (signed out / rate-limited mid-turn). A distinct amber pill — "login" with a
// key glyph for auth banners, "limit" with an hourglass for usage-limit banners
// — set apart from the plain status dots so a stuck session reads at a glance.
// Shared by both SessionCard variants.
function AuthErrorBadge({ kind }: { kind?: string | null }) {
  if (kind === "limit") {
    return (
      <span
        className="inline-flex items-center gap-0.5 px-1 py-0 rounded text-[9px] font-semibold bg-amber-500/10 text-amber-500 border border-amber-500/30"
        title="Usage limit reached — the session can resume once the limit resets"
      >
        <svg className="w-2 h-2" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
          <path d="M6 3h12M6 21h12M8 3v3.5c0 2 4 4 4 5.5s-4 3.5-4 5.5V21M16 3v3.5c0 2-4 4-4 5.5s4 3.5 4 5.5V21" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        limit
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center gap-0.5 px-1 py-0 rounded text-[9px] font-semibold bg-amber-500/10 text-amber-500 border border-amber-500/30"
      title="Signed out — run /login in the terminal to re-authenticate"
    >
      <svg className="w-2 h-2" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
        <circle cx="7.5" cy="15.5" r="3.5" />
        <path d="M10 13L20 3M17 6l2 2M14 9l2 2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      login
    </span>
  );
}

type UpcomingSchedule = { run_at?: number; title: string; extra: number };

// Upcoming `cast schedule` follow-ups keyed by conversation, joined client-side
// from the same per-user webList the /schedules page reads (Convex dedupes the
// subscription across cards) so the hot inbox row query stays untouched. A task
// badges both the conversation that scheduled it and the one it will continue;
// the soonest timed run wins the label, extra armed tasks are counted.
function useUpcomingSchedule(conversationId: string): UpcomingSchedule | undefined {
  const tasks = useQuery(api.agentTasks.webList, {});
  const byConversation = useMemo(() => {
    const map = new Map<string, UpcomingSchedule>();
    for (const task of tasks ?? []) {
      if (task.status !== "scheduled") continue;
      for (const convId of new Set([task.originating_conversation_id, task.target_conversation_id])) {
        if (!convId) continue;
        const prev = map.get(convId);
        if (!prev) {
          map.set(convId, { run_at: task.run_at, title: task.title, extra: 0 });
        } else if (task.run_at !== undefined && (prev.run_at === undefined || task.run_at < prev.run_at)) {
          map.set(convId, { run_at: task.run_at, title: task.title, extra: prev.extra + 1 });
        } else {
          prev.extra += 1;
        }
      }
    }
    return map;
  }, [tasks]);
  return byConversation.get(conversationId);
}

// Badge for a session with a `cast schedule` follow-up armed: a future timed
// run ("2h 30m"), a due-but-unclaimed run ("due"), or an event-trigger task
// ("event"). sol-orange to match the schedule identity color used by the cast
// schedule command cards and cadence chips; still distinct from the amber-500
// login pills. Shared by both SessionCard variants.
function ScheduleBadge({ upcoming }: { upcoming: UpcomingSchedule }) {
  const msUntil = upcoming.run_at !== undefined ? upcoming.run_at - Date.now() : undefined;
  const label = msUntil === undefined ? "event" : msUntil > 0 ? fmtDuration(msUntil) : "due";
  const when = msUntil === undefined ? "runs on its event trigger" : msUntil > 0 ? `next run in ${fmtDuration(msUntil)}` : "run due now";
  const more = upcoming.extra > 0 ? ` (+${upcoming.extra} more)` : "";
  return (
    <span
      className="inline-flex items-center gap-0.5 px-1 py-0 rounded text-[9px] font-semibold tabular-nums bg-sol-orange/10 text-sol-orange border border-sol-orange/30"
      title={`Scheduled: "${upcoming.title}" — ${when}${more}`}
    >
      <svg className="w-2 h-2" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7.5V12l3 2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      {label}
    </span>
  );
}

// -- SessionCard (shared) --

export const SessionCard = memo(function SessionCard({
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
  forkColorKey,
}: {
  session: InboxSession;
  isActive: boolean;
  isParentActive?: boolean;
  globalIndex: number;
  onSelect: (session: InboxSession) => void;
  onDismiss?: (id: string) => void;
  onDefer?: (id: string) => void;
  onPin?: (id: string) => void;
  onRestore?: (id: string) => void;
  onKill?: (id: string) => void;
  onNavigateToSession?: (id: string) => void;
  variant?: "default" | "working" | "dismissed";
  forkColorKey?: string;
}) {
  const tipActions = useTipActions();
  const project = getProjectName(session.git_root, session.project_path);
  const isWorking = variant === "working";
  const isDismissed = variant === "dismissed";
  const isSubagent = !!session.is_subagent || !!session.parent_conversation_id || !!session.worktree_name;
  // Local-first "pending working": a message has been sent but the daemon
  // hasn't confirmed delivery yet (status not active). Reading the durable
  // pendingMessages map directly returns a stable boolean, so only this card
  // re-renders when its own pending state flips — not the whole list. Clears
  // the moment status goes active or the server echoes the message.
  const isPendingSend = useInboxStore((st) => convHasPendingSend(st.pendingMessages[session._id]));
  const isPendingWorking = isPendingSend && !isAgentActive(session);
  const showModelBadge = useInboxStore((st) => st.clientState?.ui?.show_model_badge === true);
  // The session's user label, if any. Selector returns a string so the card
  // only re-renders when ITS label changes, not on every assignment-map churn.
  const sessionLabel = useInboxStore((st) => {
    const assignment = (Object.values(st.bucketAssignments) as BucketAssignmentItem[])
      .find((a) => a.conversation_id === session._id);
    const bucket = assignment?.bucket_id ? st.buckets[assignment.bucket_id] : null;
    return bucket && !bucket.archived_at ? bucket.name : null;
  });
  const displayTitle = cleanTitle(session.title || "New Session");
  const isSlashCommand = displayTitle.startsWith("/");
  const cleanedUserMsg = cleanUserMessage(session.last_user_message);
  const cardSummary = sessionCardSummary(session);
  // "Working" = the agent is actively running right now (mirrors
  // sessionLivenessState's "active"). The green pulse keys off this ACTUAL state
  // rather than the section the card lives in, so pinned and flat-view cards —
  // which always render with the "default" variant — still distinguish working
  // from idle instead of showing nothing for a busy pinned session.
  const isLive = !session.is_idle && session.message_count > 0;

  // Author of THIS session — shown only when it isn't the current user's own. The
  // inbox cache is user-scoped, so a teammate's session is here only because it was
  // opened (deep-link / search / palette). The conversation meta (written on every
  // view: is_own + user) covers rows cached before injection carried author fields;
  // the roster keys display off user_id so a teammate rename/avatar shows instantly.
  const currentUser = useInboxStore((s) => s.currentUser);
  const teamMembers = useInboxStore((s) => s.teamMembers);
  const convMeta = useInboxStore((s) => s.conversations[session._id]);
  const author = useMemo(
    () => resolveSessionAuthor(session, convMeta, currentUser, teamMembers),
    [session.user_id, session.author_name, session.author_avatar, convMeta, currentUser, teamMembers],
  );
  const upcomingSchedule = useUpcomingSchedule(session._id);

  const [isDragOver, setIsDragOver] = useState(false);
  const dragCounter = useRef(0);
  const generateUploadUrl = useMutation(api.images.generateUploadUrl);
  const sendMessage = useMutation(api.pendingMessages.sendMessageToSession);

  // Session-card drags must pass THROUGH cards untouched — stopping them here
  // would shadow the label-section drop targets behind the card under the
  // pointer. These handlers exist for image-file drops only.
  const isSessionDrag = (e: React.DragEvent) => e.dataTransfer.types.includes("codecast/session-id");

  const handleFileDragEnter = useCallback((e: React.DragEvent) => {
    if (isSessionDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current++;
    if (e.dataTransfer.types.includes("Files")) setIsDragOver(true);
  }, []);

  const handleFileDragOver = useCallback((e: React.DragEvent) => {
    if (isSessionDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleFileDragLeave = useCallback((e: React.DragEvent) => {
    if (isSessionDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current--;
    if (dragCounter.current === 0) setIsDragOver(false);
  }, []);

  const handleFileDrop = useCallback(async (e: React.DragEvent) => {
    if (isSessionDrag(e)) return;
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

  // Card → label drag. Distinct dataTransfer type so the existing image-file
  // drop on cards and this session drag can't interfere. The native drag image
  // would be the full-width card and bury the drop targets — swap it for a
  // compact pill so the chip/section under the pointer stays visible, and dim
  // the source card while the drag is live.
  const [isDraggingCard, setIsDraggingCard] = useState(false);
  const handleCardDragStart = useCallback((e: React.DragEvent) => {
    e.dataTransfer.setData("codecast/session-id", session._id);
    e.dataTransfer.effectAllowed = "move";
    const ghost = document.createElement("div");
    ghost.className = "flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium bg-sol-bg text-sol-text border border-sol-cyan/60 shadow-xl";
    ghost.style.cssText = "position:fixed;top:-1000px;left:-1000px;max-width:220px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;z-index:9999";
    const dot = document.createElement("span");
    dot.className = `w-1.5 h-1.5 rounded-full flex-shrink-0 ${getLabelColor(project).dot}`;
    const text = document.createElement("span");
    text.textContent = displayTitle;
    text.style.cssText = "overflow:hidden;text-overflow:ellipsis";
    ghost.append(dot, text);
    document.body.appendChild(ghost);
    e.dataTransfer.setDragImage(ghost, 18, 14);
    // The browser snapshots the drag image synchronously on dragstart; the
    // element only needs to survive this frame.
    requestAnimationFrame(() => ghost.remove());
    setIsDraggingCard(true);
  }, [session._id, displayTitle, project]);
  const handleCardDragEnd = useCallback(() => setIsDraggingCard(false), []);

  if (isSubagent) {
    return (
      <div
        data-session-id={session._id}
        draggable
        onDragStart={handleCardDragStart}
        onDragEnd={handleCardDragEnd}
        onDragEnter={handleFileDragEnter}
        onDragOver={handleFileDragOver}
        onDragLeave={handleFileDragLeave}
        onDrop={handleFileDrop}
        className={`relative group transition-all overflow-hidden ${isDraggingCard ? "opacity-35 scale-[0.99]" : ""} ${isDragOver ? "ring-1 ring-inset ring-violet-400/40 bg-violet-500/10" : ""} ${
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
        {forkColorKey && <ForkCorner colorKey={forkColorKey} />}
        <div
          role="button"
          tabIndex={0}
          onClick={() => onSelect(session)}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(session); } }}
          className="w-full text-left cursor-pointer px-2 py-1"
        >
          <div className="flex items-center gap-1.5">
            <span className={`truncate text-xs leading-tight flex-1 ${
              isActive ? "text-violet-300 font-medium" : "text-gray-400 font-normal"
            }`}>
              {isSlashCommand ? <span className="font-mono text-violet-400/80">{displayTitle}</span> : displayTitle}
            </span>
            <div className="flex items-center gap-1 flex-shrink-0">
              {upcomingSchedule && <ScheduleBadge upcoming={upcomingSchedule} />}
              {session.pending_api_error && <AuthErrorBadge kind={session.pending_api_error_kind} />}
              {session.session_error && (
                <span className="w-1.5 h-1.5 rounded-full bg-sol-red" title={session.session_error} />
              )}
              {session.is_unresponsive && !session.session_error && (
                <span className="w-1.5 h-1.5 rounded-full bg-sol-orange" title="Session unresponsive" />
              )}
              {session.has_pending && !session.is_unresponsive && (
                <span className="w-1.5 h-1.5 rounded-full bg-sol-yellow animate-pulse" title="Message pending" />
              )}
              {!session.is_idle && !session.pending_api_error && !session.session_error && !session.is_unresponsive && !session.has_pending && (
                <span className="relative flex h-1.5 w-1.5" title="Live">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-sol-green opacity-75" />
                  <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-sol-green" />
                </span>
              )}
              {session.is_idle && !session.pending_api_error && !session.session_error && !session.is_unresponsive && !session.has_pending && session.message_count > 0 && (
                <span className="w-1.5 h-1.5 rounded-full bg-gray-500/40 ring-1 ring-gray-500/20" title="Session idle" />
              )}
              {session.message_count > 0 && (
                <span className="text-[9px] tabular-nums text-sol-text-dim/50">{session.message_count}</span>
              )}
              <span className="text-[9px] text-gray-500 tabular-nums">
                {formatIdleDuration(session.updated_at)}
              </span>
            </div>
          </div>
          {cleanedUserMsg && (
            <div className="text-[10px] text-gray-500 mt-0.5 truncate leading-snug">
              <span className="text-gray-600 mr-0.5">&gt;</span>
              {cleanedUserMsg}
            </div>
          )}
          {session.active_task && (
            <div className="flex items-center gap-1 mt-0.5">
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
      draggable
      onDragStart={handleCardDragStart}
      onDragEnd={handleCardDragEnd}
      onDragEnter={handleFileDragEnter}
      onDragOver={handleFileDragOver}
      onDragLeave={handleFileDragLeave}
      onDrop={handleFileDrop}
      className={`relative group transition-all overflow-hidden ${isDraggingCard ? "opacity-35 scale-[0.99]" : ""} ${isDragOver ? "ring-1 ring-inset ring-sol-cyan bg-sol-cyan/10" : ""} ${
        isActive
          ? "bg-sol-cyan/15 border-l-[3px] border-l-sol-cyan shadow-[inset_0_0_16px_rgba(42,161,152,0.12)]"
          : isWorking
            ? "bg-sol-green/[0.04] border-l-2 border-l-sol-green/40 hover:bg-sol-green/[0.08]"
            : isDismissed
              ? "opacity-60 hover:opacity-80 hover:bg-sol-bg-alt/80"
              : "hover:bg-sol-bg-alt/80"
      }`}
    >
      {forkColorKey && <ForkCorner colorKey={forkColorKey} />}
      <div
        role="button"
        tabIndex={0}
        onClick={() => onSelect(session)}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(session); } }}
        className="w-full text-left cursor-pointer px-2.5 sm:px-3 py-1.5 sm:py-2"
      >
        <div className={`flex items-center gap-1.5 leading-tight ${
          isActive ? "text-sm text-sol-text font-semibold" : isWorking ? "text-sm text-sol-text font-medium" : isDismissed ? "text-sm text-sol-text-muted" : "text-sm text-sol-text"
        }`}>
          <span className="truncate">{isSlashCommand ? <span className="font-mono text-sol-cyan">{displayTitle}</span> : displayTitle}</span>
        </div>
        {cardSummary && !session.implementation_session && (
          <div className="text-[11px] text-sol-text-muted mt-0.5 line-clamp-2 leading-snug whitespace-pre-line">
            <FormattedSummary text={cardSummary} />
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
          {author && (
            <span className="flex items-center gap-1 flex-shrink-0 max-w-[130px]" title={`${author.name}'s session`}>
              {author.avatar ? (
                <img src={author.avatar} alt={author.name} className="w-3.5 h-3.5 rounded-full object-cover" />
              ) : (
                <span className="w-3.5 h-3.5 rounded-full bg-sol-violet/20 text-sol-violet flex items-center justify-center text-[8px] font-semibold leading-none">
                  {author.name.charAt(0).toUpperCase()}
                </span>
              )}
              <span className="text-[10px] font-medium text-sol-violet/80 truncate">{author.name.split(" ")[0]}</span>
            </span>
          )}
          {(project !== "unknown" || sessionLabel) && (
            // With a user label: label name in the label's color, but the dot
            // STAYS project-colored — provenance survives the relabel. Hover
            // reveals project + directory.
            <span
              className={`flex items-center gap-1 min-w-0 text-[10px] font-medium ${getLabelColor(sessionLabel ?? project).text}`}
              title={`${project} · ${session.git_root || session.project_path || "no directory"}`}
            >
              {project !== "unknown" && (
                <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${getLabelColor(project).dot}`} />
              )}
              <span className="truncate">{sessionLabel ?? project}</span>
            </span>
          )}
          {session.worktree_name && (
            <span className="text-[9px] text-sol-cyan font-mono truncate max-w-[80px]" title={session.worktree_branch || session.worktree_name}>
              {session.worktree_name}
            </span>
          )}
          {showModelBadge && session.model && (
            <span className="text-[9px] text-sol-text-dim/70 font-mono truncate max-w-[90px] flex-shrink-0" title={session.model}>
              {formatModel(session.model)}
            </span>
          )}
          {session.message_count > 0 && (
            <span className={`text-[10px] tabular-nums flex-shrink-0 ${msgCountColor(session.message_count)}`}>
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
            {upcomingSchedule && <ScheduleBadge upcoming={upcomingSchedule} />}
            {session.pending_api_error && <AuthErrorBadge kind={session.pending_api_error_kind} />}
            {session.session_error && (
              <span className="w-1.5 h-1.5 rounded-full bg-sol-red" title={session.session_error} />
            )}
            {session.is_unresponsive && !session.session_error && (
              <span className="w-1.5 h-1.5 rounded-full bg-sol-orange" title="Session unresponsive" />
            )}
            {session.has_pending && !session.is_unresponsive && !isPendingWorking && (
              <span className="w-1.5 h-1.5 rounded-full bg-sol-yellow animate-pulse" title="Message pending" />
            )}
            {!isWorking && !isLive && !isDismissed && session.is_idle && !session.pending_api_error && !session.session_error && !session.is_unresponsive && !session.has_pending && !isPendingWorking && session.message_count > 0 && (
              <span className="w-1.5 h-1.5 rounded-full bg-sol-text-dim/40 ring-1 ring-sol-text-dim/20" title="Session idle" />
            )}
            {isPendingWorking && (
              <span className="inline-flex items-center gap-0.5 px-1 py-0 rounded text-[9px] font-semibold bg-sol-yellow/10 text-sol-yellow border border-sol-yellow/30" title="Sent — waiting to confirm delivery">
                <span className="w-1 h-1 rounded-full bg-sol-yellow animate-pulse" />
                pending
              </span>
            )}
            {(isWorking || isLive) && !isPendingWorking && !session.pending_api_error && (
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
          <TooltipProvider delayDuration={300}>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    useInboxStore.getState().openPalette({ targets: [session], targetType: "session", mode: "bucket" });
                  }}
                  className="p-1 rounded text-sol-text-dim hover:text-sol-blue transition-colors"
                >
                  <Tag className="w-3.5 h-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="left">Label session ({formatShortcutLabel('session.moveToBucket')})</TooltipContent>
            </Tooltip>
          </TooltipProvider>
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
});

// -- SessionListPanel (shared) --

function NeedsAttentionSection() {
  const blockedTasks = useQuery(api.tasks.webList, { execution_status: "blocked", limit: 20 });
  const needsContextTasks = useQuery(api.tasks.webList, { execution_status: "needs_context", limit: 20 });
  const updateTask = useInboxStore((s) => s.updateTask);
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

  const handleRetry = (shortId: string) => {
    updateTask(shortId, { execution_status: "", status: "open" });
    toast.success("Task reset for retry");
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

// Inbox-clearing prompt: when more than this many active sessions haven't been
// touched in over a month, offer to bulk-dismiss them out of the working set.
const STALE_SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const STALE_PROMPT_THRESHOLD = 10;
// The Dismissed bucket only renders sessions dismissed within this window — a bulk
// sweep can dismiss thousands, and an unbounded list is noise.
const DISMISSED_VISIBLE_MS = 45 * 24 * 60 * 60 * 1000;

// Bring a session row into view: smooth, but never a long glide — when the
// row is more than one panel-height away, jump most of the distance first so
// the animation stays quick no matter how far the list has scrolled. Hand-rolled
// rAF tween instead of native behavior:"smooth" because the panel re-renders
// constantly (heartbeats, section resorts) and Chromium silently cancels native
// smooth scrolls on any concurrent scroll/layout change. Re-measuring the
// remaining distance every frame self-corrects through that churn.
function scrollRowIntoView(container: HTMLElement, el: Element) {
  const remainingDelta = () => {
    const c = container.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    return r.top < c.top ? r.top - c.top : r.bottom > c.bottom ? r.bottom - c.bottom : 0;
  };
  const delta = remainingDelta();
  if (delta === 0) return;
  // Hidden/occluded tabs get no animation frames — settle instantly so the
  // row can't be stranded mid-glide until the tab is next viewed.
  if (document.visibilityState !== "visible") {
    container.scrollTop += delta;
    return;
  }
  const maxGlide = container.clientHeight;
  if (Math.abs(delta) > maxGlide) {
    container.scrollTop += delta - Math.sign(delta) * maxGlide;
  }
  let aborted = false;
  const abort = () => { aborted = true; };
  const cleanup = () => {
    container.removeEventListener("wheel", abort);
    container.removeEventListener("touchstart", abort);
  };
  container.addEventListener("wheel", abort, { passive: true, once: true });
  container.addEventListener("touchstart", abort, { passive: true, once: true });
  let frames = 0;
  const step = () => {
    // Row unmounted mid-glide (panel remount/resort) — a detached node
    // measures as all-zeros, so stop rather than chase garbage.
    if (aborted || !el.isConnected) return cleanup();
    const remaining = remainingDelta();
    if (Math.abs(remaining) < 1 || ++frames > 60) {
      container.scrollTop += remaining;
      return cleanup();
    }
    container.scrollTop += remaining * 0.25;
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

export function SessionListPanel({
  onSessionSelect,
  activeSessionId,
  onCollapse,
}: {
  onSessionSelect?: (id: string) => void;
  activeSessionId?: string | null;
  onCollapse?: () => void;
}) {
  const s = useTrackedStore([
    s => s.clientState.ui,
    s => s.clientState.show_dismissed,
    s => s.hiddenSessionCount,
    s => s.sessions,
    s => s.sessionsWithQueuedMessages,
    s => s.pendingMessages,
    s => s.activeProjectFilter,
    s => s.activeBucketFilter,
    s => s.buckets,
    s => s.bucketAssignments,
    s => s.collapsedSections,
    s => s.currentSessionId,
    s => s.pendingSessionCreates,
  ]);
  const handleKillDismissed = useCallback((id: string) => {
    soundKill();
    if (isConvexId(id)) {
      const store = useInboxStore.getState();
      // session_id rides along so the daemon can still tear the backend down
      // when its local conversation mapping (or the server row) is gone.
      const sessionId = (store.sessions[id] as any)?.session_id;
      store.convCommand(id, "killSession", { mark_completed: true, session_id: sessionId })
        .catch((err: unknown) => toast.error(`Kill failed: ${err instanceof Error ? err.message : String(err)}`));
    }
    // Route the local removal through markKilling (an action that deletes the row
    // inside a draft) rather than a raw setState. The middleware then plants a
    // pending "exclude" for sessions:id, so the now-liberal delta cache won't
    // re-add the killed session on the next sync (the server still returns it,
    // marked completed, until it ages out of the window). Raw setState skipped
    // the middleware → no exclude → the card came back.
    useInboxStore.getState().markKilling(id);
  }, []);

  const handleSelect = useCallback((session: InboxSession) => {
    if (onSessionSelect) {
      onSessionSelect(session._id);
    }
  }, [onSessionSelect]);

  const pendingSendIds = useMemo(() => sessionsWithPendingSend(s.pendingMessages), [s.pendingMessages]);
  // The blank you're viewing (or one mid-create) stays visible in NEW; all
  // other never-engaged pre-warm blanks are hidden by categorizeSessions.
  const blankOpts = useMemo(
    () => ({ currentSessionId: activeSessionId ?? s.currentSessionId, pendingCreateIds: new Set(Object.keys(s.pendingSessionCreates)) }),
    [activeSessionId, s.currentSessionId, s.pendingSessionCreates],
  );
  const { sorted: sortedSessions, pinned, newSessions, needsInput, working, dismissed: dismissedList, subsByParent: globalSubByParent, forksByParent: globalForksByParent, orchestrationGroups: globalOrchestrationGroups } = useMemo(
    () => categorizeSessions(s.sessions, s.sessionsWithQueuedMessages, pendingSendIds, blankOpts),
    [s.sessions, s.sessionsWithQueuedMessages, pendingSendIds, blankOpts],
  );

  const orchestrationGroupMembers = useMemo(() => Array.from(globalOrchestrationGroups.values()).flat(), [globalOrchestrationGroups]);
  // Grouped workers are held out of the flat buckets; fold them back in for the
  // header count and project chips so totals stay accurate.
  const activeSessions = useMemo(() => [...pinned, ...newSessions, ...needsInput, ...working, ...orchestrationGroupMembers], [pinned, newSessions, needsInput, working, orchestrationGroupMembers]);

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

  const bucketByConv = useMemo(() => convBucketMap(s.bucketAssignments), [s.bucketAssignments]);
  const visibleBuckets = useMemo(() => sortLabels(s.buckets), [s.buckets]);
  const bucketCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const sess of activeSessions) {
      const b = bucketByConv[sess._id];
      if (b) counts[b] = (counts[b] || 0) + 1;
    }
    return counts;
  }, [activeSessions, bucketByConv]);

  // ONE filter pipeline for every list the panel renders. Project and bucket
  // chips are mutually exclusive (the setters clear each other) but apply both
  // defensively. Mid-create stubs pass the bucket filter so the session you
  // just summoned inside a focused bucket doesn't vanish before assignment.
  const filterByChip = useCallback((items: InboxSession[]) => {
    let out = items;
    if (s.activeProjectFilter) out = out.filter((sess) => getProjectName(sess.git_root, sess.project_path) === s.activeProjectFilter);
    if (s.activeBucketFilter) out = out.filter((sess) => bucketByConv[sess._id] === s.activeBucketFilter || !isConvexId(sess._id));
    return out;
  }, [s.activeProjectFilter, s.activeBucketFilter, bucketByConv]);

  const filteredPinned = useMemo(() => filterByChip(pinned), [filterByChip, pinned]);
  const filteredNew = useMemo(() => filterByChip(newSessions), [filterByChip, newSessions]);
  const filteredNeedsInput = useMemo(() => filterByChip(needsInput), [filterByChip, needsInput]);
  const filteredWorking = useMemo(() => filterByChip(working), [filterByChip, working]);
  const filteredDismissed = useMemo(() => {
    // Only surface dismissed sessions ACTIVE within the window — keyed on last
    // activity (updated_at), NOT when they were dismissed. A bulk cleanup dismisses
    // thousands of stale sessions all at once (dismissed_at = today), so filtering
    // by dismissal time would still show them all; filtering by recency hides that
    // old noise while keeping things you recently worked on but set aside. Hidden
    // ones stay searchable and reachable by direct link.
    const cutoff = Date.now() - DISMISSED_VISIBLE_MS;
    const filtered = filterByChip(dismissedList).filter(
      (sess) => (sess.updated_at ?? 0) >= cutoff,
    );
    return filtered.sort((a, b) => (b.dismissed_at || b.updated_at || 0) - (a.dismissed_at || a.updated_at || 0));
  }, [filterByChip, dismissedList]);
  const filteredCount = filteredPinned.length + filteredNew.length + filteredNeedsInput.length + filteredWorking.length;

  // Stale working set: EVERY non-dismissed session untouched for >30d, minus
  // pinned (explicit keep) and the one you're viewing. Computed from the full
  // session map — NOT the active buckets — on purpose: subagents nested under a
  // parent are held out of those buckets, but dismissing their parent promotes
  // them to top-level, so they must be in the dismiss set too or they refill the
  // inbox after a sweep.
  const staleSessions = useMemo(() => {
    const cutoff = Date.now() - STALE_SESSION_MS;
    return (Object.values(s.sessions) as InboxSession[]).filter(
      (sess) =>
        !isSessionDismissed(sess) &&
        !sess.is_pinned &&
        sess._id !== activeSessionId &&
        (sess.updated_at ?? 0) < cutoff,
    );
  }, [s.sessions, activeSessionId]);
  const [stalePromptSnoozed, setStalePromptSnoozed] = useState(false);
  const [dismissingStale, setDismissingStale] = useState(false);
  const dismissStaleMutation = useMutation(api.conversations.dismissStaleInboxSessions);
  const showStalePrompt = staleSessions.length > STALE_PROMPT_THRESHOLD && !stalePromptSnoozed;

  const handleDismissStale = useCallback(async () => {
    const ids = staleSessions.map((sess) => sess._id);
    const count = ids.length;
    // Instant, optimistic local dismiss (sync — no per-row dispatch storm). This
    // is the durable, user-visible clear; it persists to IDB on its own.
    useInboxStore.getState().markSessionsDismissed(ids);
    setStalePromptSnoozed(true);
    setDismissingStale(true);
    try {
      // Fire-once: schedules a background drainer that persists the dismissal
      // server-side / cross-device. Cheap and unlikely to fail — and even if it
      // does, the local clear above already stands, so we never alarm the user.
      await dismissStaleMutation({ older_than_days: 30 });
    } catch {
      // ignore — local clear persists; the server drain is best-effort.
    } finally {
      setDismissingStale(false);
      toast.success(`Dismissed ${count} old session${count === 1 ? "" : "s"} — still searchable anytime`);
    }
  }, [staleSessions, dismissStaleMutation]);

  const [expandedSubSessions, setExpandedSubSessions] = useState<Record<string, boolean>>({});
  const showSubagents = s.clientState.ui?.show_subagents ?? true;
  const showAllSessions = s.clientState.ui?.show_old_sessions ?? true;
  // Three-way view mode; the legacy boolean is honored when the mode is unset.
  const viewMode: "grouped" | "time" | "bucket" =
    s.clientState.ui?.inbox_view_mode ?? ((s.clientState.ui?.inbox_flat_view ?? false) ? "time" : "grouped");
  const flatView = viewMode === "time";
  // Flat "by creation time" view reuses the already-computed sortedSessions
  // (every non-dismissed session) and only swaps the comparator to newest-first
  // by started_at — the conversation's creation time. It still honors the
  // show_subagents toggle: when subagents are hidden, the same sessions the
  // grouped view nests away (subsByParent / globalSubByParent) are excluded
  // here — except the selected one, which always renders.
  const flatByCreation = useMemo(() => {
    const subIds = showSubagents
      ? null
      : new Set(Array.from(globalSubByParent.values()).flat().map((sess) => sess._id));
    const list = subIds
      ? sortedSessions.filter((sess) => !subIds.has(sess._id) || sess._id === activeSessionId)
      : [...sortedSessions];
    list.sort((a, b) => (b.started_at ?? b.updated_at ?? 0) - (a.started_at ?? a.updated_at ?? 0));
    return filterByChip(list);
  }, [sortedSessions, filterByChip, showSubagents, globalSubByParent, activeSessionId]);
  const headerCount = flatView ? flatByCreation.length : ((s.activeProjectFilter || s.activeBucketFilter) ? filteredCount : activeSessions.length);
  const totalSubagentCount = useMemo(() => {
    let count = 0;
    for (const subs of globalSubByParent.values()) count += subs.length;
    return count;
  }, [globalSubByParent]);

  // "By label" view: every active non-pinned top-level session grouped by its
  // manual label (orchestration workers folded in); unlabeled sessions group
  // by PROJECT — projects are a specific kind of label, auto-derived from the
  // directory. Pinned stays its own top section — pin is urgency, not theme.
  // The grouping fn is shared with the store's visualOrder so Ctrl+J/K walks
  // exactly this layout.
  const bucketView = useMemo(() => {
    if (viewMode !== "bucket") return null;
    return groupSessionsForLabelView(
      [...filteredNew, ...filteredNeedsInput, ...filteredWorking, ...filterByChip(orchestrationGroupMembers)],
      s.buckets,
      bucketByConv,
    );
  }, [viewMode, filteredNew, filteredNeedsInput, filteredWorking, orchestrationGroupMembers, filterByChip, bucketByConv, s.buckets]);

  // Shared drop sink for every label target — chips AND the "by label" view's
  // sections. bucketId null = remove the label (dropping onto a project group
  // sends the session back to its own project tier).
  const dropSessionOnLabel = useCallback((draggedId: string, bucketId: string | null) => {
    const store = useInboxStore.getState();
    const real = store.getConvexId(draggedId) ?? draggedId;
    if (!isConvexId(real)) {
      toast.error("Session is still being created — try again in a moment");
      return;
    }
    store.assignSessionToBucket(real, bucketId);
    if (bucketId) {
      const name = store.buckets[bucketId]?.name;
      if (name) toast.success(`Labeled ${name}`);
    } else {
      toast.success("Label removed");
    }
  }, []);

  // Section drop targets ("by label" view): whole group is droppable.
  const [dragOverSectionKey, setDragOverSectionKey] = useState<string | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const scrolledToRef = useRef<string | null>(null);

  // -- Dismiss & enter animations --
  const handleAnimatedDismiss = useCallback((id: string) => {
    animatedStashSession(id);
  }, []);

  // Auto-scroll to active session, retrying when sessions load and revealing hidden sections
  useWatchEffect(() => {
    if (!activeSessionId || !scrollContainerRef.current) {
      scrolledToRef.current = null;
      return;
    }
    if (scrolledToRef.current === activeSessionId) return;

    const container = scrollContainerRef.current;
    const el = container.querySelector(`[data-session-id="${activeSessionId}"]`);
    if (el) {
      scrollRowIntoView(container, el);
      scrolledToRef.current = activeSessionId;
      return;
    }

    // Card not rendered — try to reveal it by uncollapsing its section. A
    // subagent renders nested under its parent's card, so the parent's
    // membership decides which section hosts the row.
    const parentId = s.sessions[activeSessionId]?.parent_conversation_id;
    const inList = (items: InboxSession[]) => items.some(i => i._id === activeSessionId || (!!parentId && i._id === parentId));
    const sections: [InboxSession[], string][] = flatView
      ? [[flatByCreation, "all"]]
      : viewMode === "bucket" && bucketView
        ? [
            [filteredPinned, "pinned"],
            ...bucketView.labelGroups.map(({ bucket, items }) => [items, `bucket_${bucket._id}`] as [InboxSession[], string]),
            ...bucketView.projectGroups.map(({ name, items }) => [items, `bucketproj_${name}`] as [InboxSession[], string]),
          ]
        : [
            [filteredPinned, "pinned"], [filteredNew, "new"],
            [filteredNeedsInput, "needs_input"], [filteredWorking, "working"],
          ];
    for (const [items, key] of sections) {
      if (inList(items) && s.collapsedSections[key]) {
        s.toggleCollapsedSection(key);
        return;
      }
    }
    if (inList(filteredDismissed) && s.clientState.show_dismissed === false) {
      s.toggleShowDismissed();
    }
  }, [activeSessionId, sortedSessions, s.collapsedSections, s.clientState.show_dismissed, viewMode]);

  const renderSection = (
    label: string,
    items: InboxSession[],
    color: string,
    sectionVariant?: "working",
    flat?: boolean,
    opts?: {
      // Label/project sections pass an id-based key so a label named e.g.
      // "Working" can't share collapse state with the status section.
      key?: string;
      // Present (even as null) = the whole section is a drop target in the
      // "by label" view. A label id assigns it; null removes the label
      // (dropping onto a project group returns the session to its project).
      dropLabelId?: string | null;
    },
  ) => {
    if (items.length === 0) return null;
    const key = opts?.key ?? label.toLowerCase().replace(/\s+/g, "_");
    const collapsed = !!s.collapsedSections[key];
    const isDropTarget = opts !== undefined && "dropLabelId" in (opts ?? {});
    const isDragOverSection = dragOverSectionKey === key;
    const dropProps = isDropTarget
      ? {
          onDragOver: (e: React.DragEvent) => {
            if (!e.dataTransfer.types.includes("codecast/session-id")) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            setDragOverSectionKey(key);
          },
          onDragLeave: (e: React.DragEvent) => {
            // Child enter/leave churn fires dragleave constantly; only clear
            // when the pointer truly left this section's subtree.
            if (e.currentTarget.contains(e.relatedTarget as Node)) return;
            setDragOverSectionKey((cur) => (cur === key ? null : cur));
          },
          onDrop: (e: React.DragEvent) => {
            setDragOverSectionKey(null);
            const draggedId = e.dataTransfer.getData("codecast/session-id");
            if (!draggedId) return;
            e.preventDefault();
            dropSessionOnLabel(draggedId, opts!.dropLabelId ?? null);
          },
        }
      : {};
    return (
      <div
        {...dropProps}
        className={isDragOverSection ? "ring-1 ring-inset ring-sol-cyan/70 bg-sol-cyan/[0.04] transition-colors" : isDropTarget ? "transition-colors" : undefined}
      >
        <button
          onClick={() => s.toggleCollapsedSection(key)}
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
            // In flat view, subagents already appear as their own top-level
            // rows (they're in sortedSessions), so suppress the nested rendering
            // to avoid showing them twice.
            const allSubs = flat ? [] : (globalSubByParent.get(session._id) || []);
            // The selected subagent always renders — even when subagents are
            // globally hidden or fall past the "+N more" cutoff. The row being
            // viewed must never vanish from the list.
            const subs = showSubagents ? allSubs : allSubs.filter((sub) => sub._id === activeSessionId);
            const subsExpanded = !!expandedSubSessions[session._id];
            let visibleSubs = subs.length <= 2 || subsExpanded ? subs : subs.slice(0, 2);
            if (visibleSubs.length < subs.length && !visibleSubs.some((sub) => sub._id === activeSessionId)) {
              const activeSub = subs.find((sub) => sub._id === activeSessionId);
              if (activeSub) visibleSubs = [...visibleSubs, activeSub];
            }
            const hiddenCount = subs.length - visibleSubs.length;
            return (
              <div key={session._id} className="border-b border-sol-border/30">
                <SessionCard
                  session={session}
                  isActive={session._id === activeSessionId}
                  globalIndex={0}
                  onSelect={handleSelect}
                  onDismiss={handleAnimatedDismiss}
                  onDefer={s.deferSession}
                  onPin={s.pinSession}
                  variant={sectionVariant || "default"}
                  forkColorKey={globalForksByParent.has(session._id) ? session._id : (session.forked_from ?? undefined)}
                />
                {visibleSubs.map((sub) => (
                  <SessionCard
                    key={sub._id}
                    session={sub}
                    isActive={sub._id === activeSessionId}
                    isParentActive={session._id === activeSessionId}
                    globalIndex={0}
                    onSelect={handleSelect}
                    onDismiss={handleAnimatedDismiss}
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
              </div>
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
          {headerCount} Session{headerCount !== 1 ? "s" : ""}
        </span>
        <LabelChipsRow
          bucketCounts={bucketCounts}
          projectCounts={projectCounts}
          projectPathByName={projectPathByName}
          dropSessionOnLabel={dropSessionOnLabel}
        />
        <div className="flex items-center gap-1.5 flex-shrink-0 ml-auto">
          {/* View mode: icon segmented control — direct selection, no cycling.
              Ctrl+, still cycles for keyboard flow. Label segment appears only
              once at least one label exists. */}
          <div className="flex items-center rounded-md border border-sol-border/40 bg-sol-bg/70 p-px">
            {([
              { mode: "grouped" as const, Icon: List, title: "Grouped by status" },
              { mode: "time" as const, Icon: Clock, title: "By creation time" },
              ...(visibleBuckets.length > 0 ? [{ mode: "bucket" as const, Icon: Tag, title: "By label" }] : []),
            ]).map(({ mode, Icon, title }) => (
              <button
                key={mode}
                onClick={() => s.updateClientUI({ inbox_view_mode: mode, inbox_flat_view: mode === "time" })}
                title={`${title} (${formatShortcutLabel('inbox.toggleFlatView')})`}
                className={`px-1.5 py-[3px] rounded-[5px] transition-colors ${
                  viewMode === mode
                    ? "bg-sol-cyan/15 text-sol-cyan"
                    : "text-sol-text-dim/70 hover:text-sol-text"
                }`}
              >
                <Icon className="w-3 h-3" />
              </button>
            ))}
          </div>
          {totalSubagentCount > 0 && (
            <button
              onClick={() => s.updateClientUI({ show_subagents: !showSubagents })}
              title={showSubagents ? "Hide subagent sessions" : "Show subagent sessions"}
              className={`px-1.5 py-0.5 rounded-md text-[10px] tabular-nums whitespace-nowrap transition-colors border ${
                showSubagents
                  ? "text-sol-text-dim border-sol-border/40 bg-sol-bg/70 hover:text-sol-text"
                  : "text-sol-text-dim/60 border-transparent hover:text-sol-text hover:border-sol-border/40"
              }`}
            >
              {totalSubagentCount} sub
            </button>
          )}
          {s.hiddenSessionCount > 0 && (
            <button
              onClick={() => s.updateClientUI({ show_old_sessions: !showAllSessions })}
              title={showAllSessions ? "Hide old sessions" : "Show old sessions"}
              className={`px-1.5 py-0.5 rounded-md text-[10px] tabular-nums whitespace-nowrap transition-colors border ${
                showAllSessions
                  ? "text-sol-text-dim border-sol-border/40 bg-sol-bg/70 hover:text-sol-text"
                  : "text-sol-text-dim/60 border-transparent hover:text-sol-text hover:border-sol-border/40"
              }`}
            >
              {s.hiddenSessionCount} old
            </button>
          )}
        </div>
      </div>
      <div ref={scrollContainerRef} className="flex-1 overflow-y-auto scrollbar-auto">
        {showStalePrompt && (
          <div className="m-2 rounded-md border border-sol-yellow/30 bg-sol-yellow/[0.06] px-3 py-2.5">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="text-xs font-semibold text-sol-text">Clear out your working set?</div>
                <div className="mt-0.5 text-[11px] leading-snug text-sol-text-muted">
                  You have <span className="font-semibold text-sol-yellow">{staleSessions.length}</span> sessions
                  with no activity in over a month. Dismiss them to focus your inbox — they stay searchable and
                  accessible anytime.
                </div>
              </div>
              <button
                onClick={() => setStalePromptSnoozed(true)}
                className="shrink-0 rounded p-0.5 text-sol-text-dim hover:bg-sol-bg-alt hover:text-sol-text"
                title="Not now"
                aria-label="Dismiss this prompt"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
            <div className="mt-2 flex items-center gap-2">
              <button
                onClick={handleDismissStale}
                disabled={dismissingStale}
                className="rounded bg-sol-yellow/15 px-2.5 py-1 text-[11px] font-semibold text-sol-yellow transition-colors hover:bg-sol-yellow/25 disabled:opacity-60"
              >
                {dismissingStale ? "Dismissing…" : `Dismiss ${staleSessions.length} old sessions`}
              </button>
              <button
                onClick={() => setStalePromptSnoozed(true)}
                className="text-[11px] text-sol-text-dim transition-colors hover:text-sol-text"
              >
                Not now
              </button>
            </div>
          </div>
        )}
        {flatView ? (
          renderSection("All", flatByCreation, "text-sol-cyan", undefined, true)
        ) : viewMode === "bucket" && bucketView ? (
        <>
        {!s.activeProjectFilter && !s.activeBucketFilter && <NeedsAttentionSection />}
        {renderSection("Pinned", filteredPinned, "text-sol-magenta")}
        {bucketView.labelGroups.map(({ bucket, items }) => (
          <div key={bucket._id}>
            {renderSection(bucket.name, items, getLabelColor(bucket.name).text, undefined, undefined, { key: `bucket_${bucket._id}`, dropLabelId: bucket._id })}
          </div>
        ))}
        {/* Unlabeled sessions group by project — the auto-derived label tier.
            Dropping a card here strips its label (back to its own project). */}
        {bucketView.projectGroups.map(({ name, items }) => (
          <div key={`proj-${name}`}>
            {renderSection(name, items, name === "other" ? "text-sol-text-dim" : getLabelColor(name).text, undefined, undefined, { key: `bucketproj_${name}`, dropLabelId: null })}
          </div>
        ))}
        </>
        ) : (
        <>
        {!s.activeProjectFilter && !s.activeBucketFilter && <NeedsAttentionSection />}
        {renderSection("Pinned", filteredPinned, "text-sol-magenta")}
        {renderSection("New", filteredNew, "text-sol-blue")}
        {renderSection("Needs Input", filteredNeedsInput, "text-sol-yellow")}
        {renderSection("Working", filteredWorking, "text-sol-green", "working")}
        {Array.from(globalOrchestrationGroups.entries()).map(([label, members]) => {
          const visible = filterByChip(members);
          if (visible.length === 0) return null;
          const key = `grp:${label}`;
          const collapsed = !!s.collapsedSections[key];
          const needsCount = visible.filter((m) => m.awaiting_input).length;
          return (
            <div key={key}>
              <button
                onClick={() => s.toggleCollapsedSection(key)}
                className="w-full px-3 py-1.5 bg-sol-bg border-b border-sol-border/30 flex items-center justify-between gap-2"
                title={`Orchestration workers: ${label}`}
              >
                <span className="text-[10px] font-semibold uppercase tracking-wider text-teal-500 flex items-center gap-1.5 min-w-0">
                  <span className="truncate normal-case font-mono text-teal-400/90">{label}</span>
                  <span className="opacity-70">({visible.length})</span>
                  {needsCount > 0 && <span className="text-sol-yellow normal-case">· {needsCount} needs input</span>}
                </span>
                <svg className={`w-3 h-3 transition-transform text-teal-500 shrink-0 ${collapsed ? "" : "rotate-180"}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </button>
              {!collapsed && visible.map((session) => (
                <div key={session._id} className="border-b border-sol-border/30">
                  <SessionCard
                    session={session}
                    isActive={session._id === activeSessionId}
                    globalIndex={0}
                    onSelect={handleSelect}
                    onDismiss={handleAnimatedDismiss}
                    onDefer={s.deferSession}
                    onPin={s.pinSession}
                    variant={"default"}
                    forkColorKey={globalForksByParent.has(session._id) ? session._id : (session.forked_from ?? undefined)}
                  />
                </div>
              ))}
            </div>
          );
        })}
        </>
        )}
        {sortedSessions.length === 0 && (
          <div className="px-3 py-8 text-center text-sm text-sol-text-dim">
            No active sessions
          </div>
        )}
        <div className="border-t border-sol-border/30">
          <button
            onClick={() => s.toggleShowDismissed()}
            className="w-full px-3 py-1.5 bg-sol-bg border-b border-sol-border/30 flex items-center justify-between"
          >
            <span className="text-[10px] font-semibold uppercase tracking-wider text-sol-text-dim">
              Dismissed{filteredDismissed.length > 0 ? ` (${filteredDismissed.length})` : ""}
            </span>
            <svg className={`w-3 h-3 transition-transform text-sol-text-dim ${s.clientState.show_dismissed === false ? "" : "rotate-180"}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </button>
          {s.clientState.show_dismissed !== false && filteredDismissed.length > 0 && (() => {
            const allDismissedIds = new Set(filteredDismissed.map((sess) => sess._id));
            const subMap = new Map<string, InboxSession[]>();
            for (const sess of filteredDismissed) {
              if (sess.parent_conversation_id && allDismissedIds.has(sess.parent_conversation_id)) {
                if (!subMap.has(sess.parent_conversation_id)) subMap.set(sess.parent_conversation_id, []);
                subMap.get(sess.parent_conversation_id)!.push(sess);
              }
            }
            for (const subs of subMap.values()) {
              subs.sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0));
            }
            const subsWithParent = new Set(Array.from(subMap.values()).flat().map((sess) => sess._id));
            const orphanedSub = (sess: InboxSession) =>
              !subsWithParent.has(sess._id) && sess.parent_conversation_id && s.sessions[sess.parent_conversation_id];
            const topLevel = filteredDismissed.filter((sess) => !subsWithParent.has(sess._id) && !orphanedSub(sess));
            return (
            <div>
              {topLevel.map((session) => (
                <div key={session._id} className="border-b border-sol-border/30">
                  <SessionCard
                    session={session}
                    isActive={session._id === activeSessionId}
                    globalIndex={-1}
                    onSelect={handleSelect}
                    onRestore={s.unstashSession}
                    onKill={handleKillDismissed}
                    variant="dismissed"
                    forkColorKey={globalForksByParent.has(session._id) ? session._id : (session.forked_from ?? undefined)}
                  />
                  {(subMap.get(session._id) ?? []).filter((sub) => showSubagents || sub._id === activeSessionId).map((sub) => (
                    <SessionCard
                      key={sub._id}
                      session={sub}
                      isActive={sub._id === activeSessionId}
                      isParentActive={session._id === activeSessionId}
                      globalIndex={-1}
                      onSelect={handleSelect}
                      onRestore={s.unstashSession}
                      onKill={handleKillDismissed}
                      variant="dismissed"
                    />
                  ))}
                </div>
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

export function CollapsedSessionRail({ onSelect }: { onSelect?: (sessionId: string) => void } = {}) {
  const s = useTrackedStore([
    s => s.sessions,
    s => s.sessionsWithQueuedMessages,
    s => s.pendingMessages,
    s => s.currentSessionId,
    s => s.pendingSessionCreates,
  ]);
  // Clicking a dot should switch to the session the same way clicking a row in
  // the expanded list does. The caller passes the page-aware select handler
  // (leave / inbox-in-place / peek). Fall back to peek when used standalone.
  const handleSelect = onSelect ?? s.selectPanelSession;

  const pendingSendIds = useMemo(() => sessionsWithPendingSend(s.pendingMessages), [s.pendingMessages]);
  const { pinned, needsInput, working, newSessions } = useMemo(
    () => categorizeSessions(s.sessions, s.sessionsWithQueuedMessages, pendingSendIds, { currentSessionId: s.currentSessionId, pendingCreateIds: new Set(Object.keys(s.pendingSessionCreates)) }),
    [s.sessions, s.sessionsWithQueuedMessages, pendingSendIds, s.currentSessionId, s.pendingSessionCreates],
  );

  const getStatusStyle = (sess: InboxSession): { bg: string; pulse: boolean } => {
    if (sess.session_error) return { bg: "#dc322f", pulse: false };
    if (sess.is_unresponsive) return { bg: "#cb4b16", pulse: false };
    // Pending send not yet confirmed by the daemon → amber, pulsing.
    if (pendingSendIds.has(sess._id) && !isAgentActive(sess)) return { bg: "#b58900", pulse: true };
    if (sess.is_pinned && sess.is_idle) return { bg: "#d33682", pulse: false };
    if (!sess.is_idle && sess.message_count > 0) return { bg: "#859900", pulse: true };
    if (sess.is_idle && sess.message_count > 0) return { bg: "#b58900", pulse: false };
    return { bg: "rgba(38, 139, 210, 0.4)", pulse: false };
  };

  const groups = [pinned, needsInput, working, newSessions].filter((g) => g.length > 0);
  const needsInputCount = needsInput.length;

  return (
    <div
      className="w-[30px] h-full flex-shrink-0 bg-sol-bg-alt/30 border-l border-sol-border/20 hover:bg-sol-bg-alt/60 transition-colors cursor-pointer flex flex-col"
      onClick={s.toggleSidePanel}
    >
      <TooltipProvider delayDuration={150}>
        <div className="flex flex-col items-center gap-[6px] pt-3">
          {groups.map((group, gi) => (
            <div key={gi} className={`flex flex-col items-center gap-[6px] ${gi > 0 ? "mt-2" : ""}`}>
              {group.map((sess) => {
                const status = getStatusStyle(sess);
                return (
                  <Tooltip key={sess._id}>
                    <TooltipTrigger asChild>
                      <button
                        className={`w-1.5 h-1.5 rounded-full flex-shrink-0 transition-all hover:scale-[2] cursor-pointer ${status.pulse ? "animate-pulse" : ""}`}
                        style={{ backgroundColor: status.bg }}
                        onClick={(e) => { e.stopPropagation(); handleSelect(sess._id); }}
                      />
                    </TooltipTrigger>
                    <TooltipContent side="left">{cleanTitle(sess.title || "New Session")}</TooltipContent>
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
          onClick={(e) => { e.stopPropagation(); s.toggleSidePanel(); }}
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
  const s = useTrackedStore([
    s => s.sidePanelSessionId,
    s => s.sessions,
  ]);
  const router = useRouter();

  const session = s.sidePanelSessionId ? (s.sessions[s.sidePanelSessionId] ?? null) : null;
  const sessionRenderKey = getSessionRenderKey(session);

  useWatchEffect(() => {
    if (s.sidePanelSessionId && !session) s.selectPanelSession(null);
  }, [s.sidePanelSessionId, session]);

  const handleBack = useCallback(() => {
    s.selectPanelSession(null);
  }, [s.selectPanelSession]);

  const handleExpand = useCallback(() => {
    if (!s.sidePanelSessionId) return;
    s.navigateToSession(s.sidePanelSessionId);
    router.push('/inbox');
  }, [s.sidePanelSessionId, s.navigateToSession, router]);

  const handleClose = useCallback(() => {
    s.selectPanelSession(null);
  }, [s.selectPanelSession]);

  const handleSendAndDismiss = useCallback(() => {
    if (s.sidePanelSessionId) animatedStashSession(s.sidePanelSessionId);
  }, [s.sidePanelSessionId]);

  if (!session || !s.sidePanelSessionId) return null;

  return (
    <div className="h-full flex flex-col">
      <div className="h-full">
        <InboxConversation
          key={sessionRenderKey || s.sidePanelSessionId}
          sessionId={s.sidePanelSessionId}
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
