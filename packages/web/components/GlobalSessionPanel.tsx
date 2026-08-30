import React, { useState, useCallback, useEffect, useRef, memo, useMemo } from "react";
import { useWatchEffect } from "../hooks/useWatchEffect";
import { AvatarImg } from "../lib/avatarCache";
import { imageBytes } from "../lib/imageByteCache";
import { useConvex, useMutation, useQuery } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { Id } from "@codecast/convex/convex/_generated/dataModel";
import { useRouter } from "next/navigation";
import { ConversationDiffLayout } from "./ConversationDiffLayout";
import { ContextMenu, useContextMenu, CtxItem, CtxHeader, CtxSeparator } from "./ui/context-menu";
import { SessionMenuItems } from "./menus/ObjectContextMenus";
import { copyToClipboard, formatRelative, formatDateFull } from "../lib/utils";
import { ImageLightbox } from "./ImageGallery";
import { SessionErrorBanner } from "./SessionErrorBanner";
import { AppLoader } from "./AppLoader";
import { ConversationData } from "./ConversationView";
import { FormattedSummary } from "./FormattedSummary";
import { sessionCardSummary } from "../lib/sessionSummary";
import { threadStateView, THREAD_STATE_PIN_CLASS, THREAD_STATE_STATUS_META } from "../lib/threadState";
import { sessionStartupState } from "../lib/sessionLifecycle";
import { compressImage } from "../lib/compressImage";
import { useConversationMessages } from "../hooks/useConversationMessages";
import { useInboxStore, useTrackedStore, InboxSession, InboxViewMode, flatViewComparator, flatViewSessions, chipMatchesSession, computeManualSortKey, getSessionRenderKey, isConvexId, categorizeSessions, partitionOldSessions, filterInboxScope, isInterruptControlMessage, getProjectName, isFork, convHasPendingSend, isAgentActive, sessionsWithPendingSend, freshReviveRequestIds, isSessionHidden, resolveSessionAuthor, convBucketMap, groupSessionsForLabelView, groupSessionsByPlan, selectFavoriteSessions, sortLabels, computeChipCounts, BucketItem } from "../store/inboxStore";
import { sessionsWakeSig, resolveShowOld, showsBlockedBadge } from "../store/inboxStore";
import { makeCollectionSig } from "../store/wakeSig";
import { useCoarseNow, useNowWhen } from "../hooks/useCoarseNow";
import { useTriggerKillNotice } from "../hooks/useTriggerKillNotice";
import { actedBlockedConversations, isBlockedConversation, isSubagentConversation, isUsageExhausted, nestParentIdOf, worstUsagePercent, LOGIN_FLOW_STALE_MS, type CcUsage } from "@codecast/convex/convex/ccAccountsShared";
import { isLivenessStale, blockedContinueClientId, rankByHeadroom, CONTINUE_BANNER_KINDS } from "@codecast/shared/contracts";
import { TooltipProvider } from "./ui/tooltip";
import { cleanTitle, msgCountColor, formatModel } from "../lib/conversationProcessor";
import { getLabelColor } from "../lib/labelColors";
import { useWorkspaceCollection } from "../hooks/useWorkspaceCollection";
import { useTeamRosterIdentity } from "../hooks/useTeamRoster";
import Link from "next/link";
import { fmtClock, fmtDuration, describeTaskCadence, isTaskOverdue, taskStateLabel } from "./triggerCadence";
import { isWatchHostDead, liveWatchRowsFor } from "./monitorRows";
import { partitionTriggerInbox, groupSessionsByTrigger, taskDisplayTitle, latestLoadedTriggerMessage, type TriggerRow, type TaskRow } from "./triggerTasks";
import { useTriggers, fetchTriggerRuns } from "../hooks/useSyncTriggers";
import { TriggerRunList, useTriggerRuns, openRunInStore, type TriggerRun } from "./TriggerRunHistory";
import { cleanUserMessage } from "./sessionMessage";
import { liftQuestions } from "../lib/decisionQueue";
import { AgentTypeIcon, formatAgentType } from "./AgentTypeIcon";
import { AnchorGlyph, AnchorScopePill } from "./anchor/AnchorIdentity";
import { useAnchorIdentity } from "../hooks/useSyncAnchors";
import { SharePopover } from "./SharePopover";
import { shareOrigin } from "../lib/utils";
import { PlanContextPanel } from "./PlanContextPanel";
import { WorkflowContextPanel } from "./WorkflowContextPanel";
import { toast } from "sonner";
import { animatedHideSession } from "../store/undoActions";
import { soundKill } from "../lib/sounds";
import { ShortcutTooltip } from "./KeyboardShortcutsHelp";
import { X, ChevronsLeft, ChevronsRight, ChevronRight, ChevronDown, List, Clock, Tag, GitFork, History, Star, Activity, Workflow, Play, Pause, Settings2, Users, UserCheck, Zap, ZapOff, Pin, Copy, ArrowUp, ArrowDown } from "lucide-react";
import { FilterOptionList } from "./FilterDropdown";
import { LabelChipsRow } from "./LabelChipsRow";
import { TaskStatusBadge } from "./TaskStatusBadge";
import { useTipActions, checkMilestone } from "../tips";
import { RESTART_GIVE_UP_AFTER_MS } from "../hooks/useSessionRestart";
import { isParkedDispatchError } from "../store/mutativeMiddleware";
import { useTitlebarHead } from "../hooks/useTitlebarHead";
import { useAckAssignment } from "../hooks/useAckAssignment";
import { sessionPanePath, startPaneDrag } from "../lib/stage";

function formatIdleDuration(updatedAt: number): string {
  const diff = Date.now() - updatedAt;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}


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
        } catch (err) {
          // A parked restart is still pending. Keep the recovery state and let
          // the liveness/timeout ladder decide whether it ultimately worked.
          if (isParkedDispatchError(err)) return;
          setResumeState("failed");
        }
      } else if (!reconstitutionAttemptedRef.current && isConvexId(sessionId)) {
        reconstitutionAttemptedRef.current = true;
        setResumeState("reconstituting");
        try {
          await convCommand(sessionId, "repairSession");
          setResumeState("reconstituting");
        } catch (err) {
          if (isParkedDispatchError(err)) return;
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
      .catch((err) => {
        if (isParkedDispatchError(err)) {
          setResumeState("sent");
          return;
        }
        setResumeState("failed");
      });
  }, [sessionId, convCommand]);

  if (!conversation) {
    return (
      <AppLoader className="min-h-0 h-full bg-transparent" size={32} />
    );
  }

  const convId = conversation._id as Id<"conversations">;
  // The public link must PRESENT the token (?share=) — a bare conversation id
  // grants nothing to anonymous viewers or link unfurlers (issue #27).
  const shareUrl = conversation.share_token
    ? `${shareOrigin()}/conversation/${convId}?share=${encodeURIComponent(conversation.share_token)}`
    : null;
  // Owner-only: a team viewer's payload carries share_token, and rendering the
  // popover for them would hand out a working world-readable link one click
  // from a session they don't own (mirrors QueuePageClient's gate).
  const isOwnSession = (conversation as any).is_own !== false;
  const shareControls = isOwnSession ? (
    <SharePopover
      isPrivate={conversation.is_private !== false}
      teamVisibility={(conversation as any).team_visibility || (conversation as any).effective_team_visibility}
      hasShareToken={!!conversation.share_token}
      hasTeam={!!(conversation as any).team_id}
      onSetPrivate={() => { setPrivacy(convId, true); toast.success("Made private"); }}
      onSetTeamVisibility={(mode) => { setTeamVisibility(convId, mode); toast.success(mode === "full" ? "Sharing full conversation with team" : "Sharing summary with team"); }}
      onGenerateShareLink={async () => { const token = await generateShareLink({ conversation_id: convId }); return `${shareOrigin()}/conversation/${convId}?share=${encodeURIComponent(token)}`; }}
      shareUrl={shareUrl}
      forwardUrl={`${shareOrigin()}/conversation/${convId}`}
      forwardLabel="session"
    />
  ) : null;

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
        <SessionErrorBanner
          // Remount per session: the dismiss state is keyed by error TEXT, and
          // two sessions can fail with the identical message.
          key={conversation._id}
          error={sessionError}
          projectPath={conversation.project_path || conversation.git_root}
          ownerDeviceId={(conversation as any).owner_device_id}
          onResume={handleManualResume}
        />
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
            <button onClick={onClose} className="cc-panel__btn is-close" title="Close">
              <X className="w-3.5 h-3.5" />
            </button>
          ) : undefined}
          headerLeft={onExpandToMain ? (
            <button onClick={onExpandToMain} className="cc-panel__btn flex-shrink-0" title="Open full — take the stage">
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
          fallbackStickyContent={lastUserMessage}
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

// The corner color is keyed by the ROOT of the fork tree so every session in
// the same tree — parent, forks, forks-of-forks — renders the same color.
// Walk forked_from as far as the loaded cache allows; an unloaded ancestor's
// id is still a key all of its visible descendants agree on.
function forkTreeRootId(session: InboxSession, sessions: Record<string, InboxSession>): string {
  let cur = session;
  const seen = new Set([cur._id]);
  while (cur.forked_from) {
    const parent = sessions[cur.forked_from];
    if (!parent || seen.has(parent._id)) return cur.forked_from;
    cur = parent;
    seen.add(cur._id);
  }
  return cur._id;
}

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
// (signed out / rate-limited / connection dropped mid-turn). A distinct amber
// pill — "login" with a key glyph for auth banners, "limit" with an hourglass
// for usage-limit banners, "dropped" with a bolt for connection drops — set
// apart from the plain status dots so a stuck session reads at a glance.
// Shared by both SessionCard variants.
function AuthErrorBadge({ kind, agentType }: { kind?: string | null; agentType?: string | null }) {
  // Only the parked-and-won't-heal kinds get a badge. kind "error" (statusful
  // 429/5xx provider failures) self-retries — badging it paints a healthy
  // session as blocked.
  if (kind !== "limit" && kind !== "auth" && kind !== "connection" && kind !== "fatal") return null;
  if (kind === "fatal") {
    return (
      <span
        className="inline-flex items-center gap-0.5 px-1 py-0 rounded text-[9px] font-semibold bg-amber-500/10 text-amber-500 border border-amber-500/30"
        title="API request failed and won't auto-retry — send continue (or any message) to retry the turn"
      >
        <svg className="w-2 h-2" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 8v4M12 15.5v.5" strokeLinecap="round" />
        </svg>
        failed
      </span>
    );
  }
  if (kind === "connection") {
    return (
      <span
        className="inline-flex items-center gap-0.5 px-1 py-0 rounded text-[9px] font-semibold bg-amber-500/10 text-amber-500 border border-amber-500/30"
        title="Connection dropped mid-response — send continue (or any message) to resume"
      >
        <svg className="w-2 h-2" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
          <path d="M13 2L3 14h7l-1 8 10-12h-7l1-8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        dropped
      </span>
    );
  }
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
  // opencode and grok re-auth via their own CLI in a terminal; pi / Claude / Codex
  // via /login in the session — name the right one in the tooltip.
  const authTip = agentType === "opencode"
    ? "Provider not authenticated — run `opencode auth login` in a terminal, then retry"
    : agentType === "grok"
      ? "Signed out — run `grok login` in a terminal (browser OAuth), then retry"
      : "Signed out — run /login in the terminal to re-authenticate";
  return (
    <span
      className="inline-flex items-center gap-0.5 px-1 py-0 rounded text-[9px] font-semibold bg-amber-500/10 text-amber-500 border border-amber-500/30"
      title={authTip}
    >
      <svg className="w-2 h-2" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
        <circle cx="7.5" cy="15.5" r="3.5" />
        <path d="M10 13L20 3M17 6l2 2M14 9l2 2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      login
    </span>
  );
}

// The login flow's device-row state, as listAccountProfiles reports it.
type LoginFlowState = {
  status: "pending" | "confirmed" | "rejected";
  email?: string;
  reason?: string;
  started_at: number;
  finished_at?: number;
  revived?: number;
};

// The big sign-in call to action for auth-blocked sessions. Clicking asks the
// primary daemon to run `claude auth login` (requestLoginFlow), which pops the
// OAuth page in the machine's browser pre-filled with the expired account's
// email. The device row's cc_login_flow field is the whole state channel:
// pending renders the waiting spinner, confirmed announces the revive the
// server already kicked off, rejected says why and brings the button back.
export function SignInCta({
  device,
  authSessionIds,
  disabled,
}: {
  device: { device_id: string; label?: string; active_email?: string; login_flow?: LoginFlowState };
  authSessionIds: string[];
  disabled: boolean;
}) {
  const requestLogin = useMutation(api.accountSwitch.requestLoginFlow);
  const [launching, setLaunching] = useState(false);
  const now = useCoarseNow(5_000);
  const flow = device.login_flow;

  // The moment the daemon confirms, mirror the server's revive locally: stamp
  // the auth-blocked sessions as revive-in-flight so the counts drop on the
  // spot instead of on the kill/continue round trip.
  const handledConfirmRef = useRef(0);
  useEffect(() => {
    if (flow?.status !== "confirmed" || !flow.finished_at) return;
    if (handledConfirmRef.current === flow.finished_at) return;
    handledConfirmRef.current = flow.finished_at;
    // Only a confirm from THIS incident revives — an old row from last week's
    // flow must not clear a fresh outage's counts.
    if (now - flow.finished_at < 3 * 60 * 1000) {
      useInboxStore.getState().markBlockedReviveRequested(authSessionIds);
    }
  }, [flow?.status, flow?.finished_at, now, authSessionIds]);

  const pending =
    (flow?.status === "pending" && now - flow.started_at < LOGIN_FLOW_STALE_MS) || launching;
  const confirmedRecent =
    flow?.status === "confirmed" && !!flow.finished_at && now - flow.finished_at < 3 * 60 * 1000;
  const rejectedRecent =
    flow?.status === "rejected" && !!flow.finished_at && now - flow.finished_at < 10 * 60 * 1000;

  // The button always launches a sign-in for the machine's CURRENT login
  // (requestLoginFlow stamps active_email at click time), so it is labeled
  // with the live active_email — an account switch under the banner, or a
  // cc_login_flow row left over from an earlier incident, must not pin the
  // old address. flow.email only labels the flow it belongs to: the pending
  // spinner and the confirmed panel.
  const email = device.active_email ?? flow?.email;
  const who = email ?? "your Claude account";
  const flowWho = flow?.email ?? who;

  const handleClick = async (force = false) => {
    setLaunching(true);
    try {
      await requestLogin({ device_id: device.device_id, ...(force ? { force: true } : {}) });
      // The device row's pending stamp echoes back through listAccountProfiles;
      // keep the local flag briefly so the button can't double-fire meanwhile.
      setTimeout(() => setLaunching(false), 5_000);
    } catch (err) {
      setLaunching(false);
      toast.error(err instanceof Error ? err.message : "Couldn't start the sign-in");
    }
  };

  if (pending) {
    return (
      <div className="mt-2 flex items-center gap-2.5 rounded-md border border-amber-500/25 bg-amber-500/[0.08] px-3 py-2.5">
        <span className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-amber-500/30 border-t-amber-500" aria-hidden />
        <div className="min-w-0 text-[11px] leading-snug">
          <div className="font-semibold text-sol-text">Finish signing in as {flowWho} in your browser</div>
          <div className="text-sol-text-dim">
            The sign-in page opened on {device.label || "your machine"} — the blocked sessions restart on their own once it completes.
          </div>
          <button
            onClick={() => handleClick(true)}
            disabled={disabled}
            title={`Kill the running sign-in on ${device.label || "your machine"} and open a fresh browser page`}
            className="mt-1 font-medium text-amber-500 underline underline-offset-2 transition-colors hover:text-amber-400 disabled:opacity-60"
          >
            Page didn&apos;t open? Relaunch the sign-in
          </button>
        </div>
      </div>
    );
  }

  if (confirmedRecent) {
    const revived = flow?.revived ?? authSessionIds.length;
    return (
      <div className="mt-2 flex items-center gap-2.5 rounded-md border border-sol-green/30 bg-sol-green/[0.08] px-3 py-2.5">
        <svg className="h-3.5 w-3.5 shrink-0 text-sol-green" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5} aria-hidden>
          <path d="M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <div className="min-w-0 text-[11px] leading-snug">
          <div className="font-semibold text-sol-text">Signed in{flow?.email ? ` as ${flow.email}` : ""}</div>
          <div className="text-sol-text-dim">
            {revived > 0
              ? `Restarting ${revived} blocked session${revived === 1 ? "" : "s"} on the fresh login.`
              : "The blocked sessions restart on their own."}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="mt-2 rounded-md border border-amber-500/25 bg-amber-500/[0.08] px-3 py-2.5">
      {rejectedRecent && (
        <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium text-sol-red">
          <X className="h-3 w-3 shrink-0" />
          <span className="min-w-0 truncate">
            Sign-in didn&apos;t complete{flow?.reason ? ` — ${flow.reason}` : ""}
          </span>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <button
          onClick={() => handleClick()}
          disabled={disabled}
          title={`Run /login on ${device.label || "your machine"} — opens the browser sign-in${email ? ` for ${email}` : ""}`}
          className="inline-flex items-center gap-1.5 rounded-md bg-amber-500 px-3.5 py-1.5 text-[12px] font-bold text-sol-bg shadow-sm transition-colors hover:bg-amber-400 disabled:opacity-60"
        >
          <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5} aria-hidden>
            <circle cx="7.5" cy="15.5" r="3.5" />
            <path d="M10 13L20 3M17 6l2 2M14 9l2 2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          {rejectedRecent ? `Try signing in as ${who} again` : `Sign in as ${who}`}
        </button>
        <span className="text-[11px] leading-snug text-sol-text-dim">
          Opens your browser to re-authenticate, then restarts the signed-out session{authSessionIds.length === 1 ? "" : "s"} automatically.
        </span>
      </div>
    </div>
  );
}

// When several sessions are parked on an API-error banner at once (the classic
// "the whole fleet hit the Max usage limit together"), surface ONE fleet-level
// action instead of N per-card errors: send "continue" to them all. Signed-out
// sessions are the exception — their processes hold a dead token, so the
// restart path (requestAccountSwitch with no profile, which degrades to
// kill + continue; see convex/accountSwitch.ts) reaches them. Account
// switching itself lives in settings/auto-switch, not in this banner. Own
// component so its account query stays out of the hot panel render.
function BlockedSessionsBanner({
  blocked,
  onOpen,
  forced,
  onClearForced,
  fresh,
}: {
  blocked: InboxSession[];
  onOpen?: (session: InboxSession) => void;
  // The header's blocked-pill is the PERMANENT trigger for this banner: it
  // force-shows it past the snooze and the 2-session floor, so the actions are
  // always reachable while any session is blocked (the banner alone is
  // transient — it snoozes on X and after acting).
  forced?: boolean;
  onClearForced?: () => void;
  // A live 0→N transition of the blocked set (not a page-load hydration):
  // replay the entrance with the attention glow so the incident lands.
  fresh?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [includeSubs, setIncludeSubs] = useState(false);
  // Which account the continue runs on: "" = the account the machine is signed
  // into now (the default — no switch, no restart unless a session needs one).
  const [onAccount, setOnAccount] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const requestSwitch = useMutation(api.accountSwitch.requestAccountSwitch);
  const acknowledgeMutation = useMutation(api.accountSwitch.acknowledgeBlocked);
  // The X is a durable, cross-device snooze (24h) — a banner that resurrects
  // on every reload isn't dismissible. Permanent removal is per-session:
  // acknowledge clears the flag itself.
  const clientStateInitialized = useInboxStore((st) => st.clientStateInitialized);
  const snoozedTs = useInboxStore((st) => st.clientState.dismissed?.blocked_sessions_banner ?? 0);
  const updateDismissed = useInboxStore((st) => st.updateClientDismissed);
  const accountData = useQuery(api.accountSwitch.listAccountProfiles, blocked.length >= (forced ? 1 : 2) ? {} : "skip");
  // Ticking clock for the "Xm ago" times — a static Date.now() would freeze
  // them at whatever the last unrelated re-render happened to read.
  const now = useCoarseNow(30_000);

  const snoozed = snoozedTs > 0 && Date.now() - snoozedTs < 24 * 60 * 60 * 1000;
  if (!clientStateInitialized || blocked.length === 0) return null;
  if (!forced && (blocked.length < 2 || snoozed)) return null;

  // Subagent workers default OUT of the acted set: their parent has usually
  // moved on, so reviving them spends the fresh account on work nobody is
  // waiting for. Same predicate the server selection uses, so the counts on
  // the buttons are exactly what the mutations will touch.
  const subagents = blocked.filter(isSubagentConversation);
  // Workers join the acted set only through the checkbox — never because they
  // are all that is blocked. Continuing an in-process worker cannot reach it;
  // it resumes a standalone copy that reruns its brief for nobody (the
  // 2026-08-20 fleet: 53 copies running stale briefs in the shared checkout).
  // Left unticked, the banner offers nothing to continue and says so.
  const acted = actedBlockedConversations(blocked, includeSubs);
  const authCount = acted.filter((sess) => sess.pending_api_error_kind === "auth").length;
  const connCount = acted.filter((sess) => sess.pending_api_error_kind === "connection").length;
  const fatalCount = acted.filter((sess) => sess.pending_api_error_kind === "fatal").length;
  const limitCount = acted.length - authCount - connCount - fatalCount;
  // When a session's block landed: the banner message's own timestamp, with
  // updated_at standing in for rows flagged before the field existed. The
  // headline shows the newest one — the moment the incident (last) grew.
  const blockAt = (sess: InboxSession) => sess.pending_api_error_at ?? sess.updated_at ?? 0;
  const latestBlockAt = blocked.reduce((max, sess) => Math.max(max, blockAt(sess)), 0);

  // Newest-flagged first — the same order the revive acts on (and the order
  // that answers "which sessions?" most usefully: fresh casualties on top).
  const blockedSorted = [...blocked].sort((a, b) => blockAt(b) - blockAt(a));

  // The sign-in CTA's executor: the online primary (non-remote) machine — the
  // one whose keychain holds the login and whose browser the OAuth flow opens
  // in. Remotes run a pushed credential copy and can never sign in themselves.
  const loginDevice = (accountData?.devices ?? []).find((d) => d.online && !d.is_remote);
  const actedAuthIds = acted
    .filter((sess) => sess.pending_api_error_kind === "auth")
    .map((sess) => sess._id);

  // The account picker's inventory. Accounts are DEVICE-SPECIFIC: a saved
  // profile is a keychain snapshot on one machine, so the only accounts worth
  // offering are the ones saved on the machines that will EXECUTE the revive —
  // each blocked session's online owner, or the primary standing in for an
  // offline or remote owner (the same routing insertSwitchCommands applies).
  // Options are keyed by email (the identity); a profile name is that
  // machine's alias and may differ or be absent elsewhere. The whole banner
  // asks ONE question — which account does the fleet continue on? — so
  // accounts render as a single select, ranked by live headroom.
  const devices = accountData?.devices ?? [];
  const deviceById = new Map(devices.map((d) => [d.device_id, d]));
  const executorFor = (sess: InboxSession) => {
    const owner = sess.owner_device_id ? deviceById.get(sess.owner_device_id) : undefined;
    return owner && owner.online && !owner.is_remote ? owner : loginDevice;
  };
  const executors = [...new Map(acted.map((sess) => executorFor(sess)).filter((d) => !!d).map((d) => [d!.device_id, d!])).values()];
  const activeEmails = [...new Set(executors.map((d) => d.active_email).filter((e): e is string => !!e))];
  const activeEmail = activeEmails.length === 1 ? activeEmails[0] : undefined;
  type AccountOption = { key: string; name: string; email?: string; usage?: CcUsage; missingOn: string[] };
  const accountOptions: AccountOption[] = [];
  for (const device of executors) {
    for (const p of device.profiles) {
      // The account a machine is signed into now is "this account", not a switch.
      if (p.email && device.active_email === p.email) continue;
      const key = p.email ? `email:${p.email}` : `name:${p.name}`;
      const existing = accountOptions.find((t) => t.key === key);
      if (!existing) accountOptions.push({ key, name: p.name, email: p.email, usage: p.usage, missingOn: [] });
      else if (!existing.usage && p.usage) existing.usage = p.usage;
    }
  }
  for (const opt of accountOptions) {
    opt.missingOn = executors
      .filter((d) => !d.profiles.some((p) => (opt.email ? p.email === opt.email : p.name === opt.name)))
      .map((d) => d.label);
  }
  const rankedAccounts = rankByHeadroom(accountOptions, now);
  // Usage of what the executing machines run now — the account that parked
  // these sessions, not whatever the machine at the desk is signed into.
  const activeUsage = executors
    .flatMap((d) => d.profiles.filter((p) => p.email && p.email === d.active_email))
    .map((p) => p.usage)
    .find((u) => !!u);
  const selectedAccount = rankedAccounts.find((t) => t.key === onAccount);
  const switchTarget = (opt: AccountOption) => (opt.email ? { email: opt.email } : { profile: opt.name });
  // "82% used" / "at limit" — enough to steer the pick, nothing more.
  const usageNote = (usage?: CcUsage): string => {
    if (isUsageExhausted(usage, now)) return " — at limit";
    const pct = usage ? worstUsagePercent(usage, now) : null;
    return pct != null ? ` — ${Math.round(pct)}% used` : "";
  };

  // Every way the banner closes goes through here: snooze 24h AND drop the
  // forced-open flag, so the header pill (which never hides while sessions
  // are blocked) is the one durable way back in.
  const closeBanner = () => {
    updateDismissed("blocked_sessions_banner", Date.now());
    onClearForced?.();
  };

  // Local-first: queue "continue" through the store's own send path (optimistic
  // bubble + outbox-durable sendMessage), the exact machinery a hand-typed
  // "continue" in each composer would use. The sessions flip to WORKING with
  // the amber pending pill synchronously — no server round trip gates the UI —
  // and delivery/retry/failure honesty is inherited from the outbox. Same
  // selection and same minute-bucketed client id as the server's
  // continueAllBlocked (the CLI path), so a racing CLI run or double-click
  // dedups server-side into a single send.
  const handleContinueAll = () => {
    const store = useInboxStore.getState();
    const targets = acted.filter((sess) =>
      CONTINUE_BANNER_KINDS.includes(sess.pending_api_error_kind ?? ""),
    );
    const at = Date.now();
    for (const sess of targets) {
      const clientId = blockedContinueClientId(sess._id, at);
      store.addOptimisticMessage(sess._id, "continue", undefined, clientId);
      store.sendMessage(sess._id, "continue", undefined, clientId);
    }
    // Stamp so the banner/pill drop these instantly too (their server blocked
    // flag stays set until the agent actually resumes).
    store.markBlockedReviveRequested(targets.map((sess) => sess._id));
    toast.success(`Queued "continue" to ${targets.length} blocked session${targets.length === 1 ? "" : "s"}`);
    closeBanner();
  };

  // Revive on the account the machine is signed into NOW: no swap — the
  // no-profile switch command degrades to kill (the blocked processes hold
  // the dead token in memory) + continue, so a re-login on the same account
  // doesn't force a switch to a different one.
  // The daemon work (keychain swap, kill, restart, re-queue) is inherently
  // remote, but the user's gesture renders instantly, in every acted session at
  // once: the "continue" each one is about to receive is painted into its local
  // message cache NOW, and the sessions are stamped as revive-in-flight
  // (classification moves them to WORKING, the pill count and the blocked chips
  // drop). Both land before anything is awaited; the await only powers the
  // outcome toast.
  //
  // The daemon still OWNS delivery here — it has to kill the process holding
  // the dead token before the continue lands, an ordering the web can't
  // reproduce from a plain send. So we hand it the client ids we painted with
  // (continue_client_ids -> the command's client_ids), and its enqueue carries
  // them: the server echo replaces each painted bubble instead of doubling it.
  // The nonce makes the ids unique to THIS gesture, so a revive seconds after a
  // continue-all can't dedupe itself away against that earlier send's row.
  //
  // If the mutation itself fails, take the whole gesture back — bubbles, stamps
  // and the snooze — so the banner resurfaces for a retry. If a daemon is merely
  // unreachable, the stamps age out (BLOCKED_REVIVE_TTL_MS) and those sessions
  // honestly return to blocked.
  const runRevive = async (target: { email?: string; profile?: string } | undefined) => {
    const ids = acted.map((sess) => sess._id);
    const store = useInboxStore.getState();
    const nonce = Math.random().toString(36).slice(2, 10);
    const clientIds: Record<string, string> = {};
    for (const id of ids) {
      clientIds[id] = `acct-revive-${nonce}-${id}`;
      store.addOptimisticMessage(id, "continue", undefined, clientIds[id]);
    }
    store.markBlockedReviveRequested(ids);
    closeBanner();
    const targetLabel = target?.email ?? target?.profile;
    setBusy(targetLabel ?? "revive");
    try {
      const res = await requestSwitch({
        ...target,
        include_subagents: includeSubs,
        continue_client_ids: clientIds,
      });
      // Sessions on a machine that lacks the account got no command: their
      // painted "continue" and revive stamp must not stand.
      const unswitchable = (res as { unswitchable?: number; unswitchable_devices?: string[] }).unswitchable ?? 0;
      const unswitchableDevices = (res as { unswitchable_devices?: string[] }).unswitchable_devices ?? [];
      if (unswitchable > 0) {
        const stranded = acted
          .filter((sess) => unswitchableDevices.includes(executorFor(sess)?.label ?? ""))
          .map((sess) => sess._id);
        for (const id of stranded) store.removeOptimisticMessage(id, clientIds[id]);
        store.clearBlockedReviveRequested(stranded);
      }
      toast.success(
        (targetLabel
          ? `Switching to ${targetLabel} — ${res.conversations} blocked session${res.conversations === 1 ? "" : "s"} will continue on it`
          : `Restarting ${res.conversations} blocked session${res.conversations === 1 ? "" : "s"} on the current account`) +
          (res.unreachable > 0 ? ` (${res.unreachable} unreachable: daemon offline)` : "") +
          (unswitchable > 0
            ? ` (${unswitchable} skipped: ${unswitchableDevices.join(", ")} ${unswitchableDevices.length === 1 ? "does" : "do"} not have that account saved)`
            : ""),
      );
    } catch (err) {
      for (const id of ids) store.removeOptimisticMessage(id, clientIds[id]);
      store.clearBlockedReviveRequested(ids);
      updateDismissed("blocked_sessions_banner", 0);
      toast.error(err instanceof Error ? err.message : targetLabel ? "Account switch failed" : "Failed to restart blocked sessions");
    } finally {
      setBusy(null);
    }
  };

  // ONE verb, one decision. Every blocked session needs the same thing — a
  // "continue" — so the banner offers exactly that, on a choice of account.
  // Which DELIVERY each session needs (a plain message, or a restart first
  // because its process holds a dead token, or a credential swap) is the
  // machinery's problem, resolved here per click, never a menu the user picks
  // from. The button therefore always acts on the whole acted set and always
  // says the full count.
  const handleContinue = () => {
    if (selectedAccount) return void runRevive(switchTarget(selectedAccount));
    if (authCount > 0) return void runRevive(undefined);
    handleContinueAll();
  };
  // "all" only when the button truly covers the headline count — when
  // subagents are skipped the label drops to a plain number and the breakdown
  // line right above accounts for the difference.
  const countLabel =
    acted.length === 1 ? "it" : acted.length === blocked.length ? `all ${acted.length}` : `${acted.length}`;
  const continueTitle = selectedAccount
    ? `Switch ${executors.length === 1 ? executors[0].label : "the machines owning these sessions"} to ${selectedAccount.email ?? selectedAccount.name}, restart the blocked sessions, and continue them on it`
    : authCount > 0
      ? `Send "continue" to each blocked session — ${authCount === acted.length ? "they are" : `the ${authCount} signed out are`} restarted first (their processes hold an expired login), no account change`
      : `Send "continue" to each blocked session — no restart, no account change${limitCount > 0 ? "; they resume once the limit resets" : ""}`;

  // The permanent decision: clear the banner flag on these sessions so they
  // leave the blocked set for good (only a NEW banner re-flags them). Local
  // store first — the count drops instantly — then one persisting mutation.
  const handleAcknowledge = async (ids: string[]) => {
    useInboxStore.getState().markBlockedAcknowledged(ids);
    try {
      await acknowledgeMutation({ conversation_ids: ids as any });
    } catch {
      // The optimistic clear stands; the next server sync re-flags anything
      // that genuinely didn't persist.
    }
  };

  return (
    <div className={`m-2 rounded-md border border-amber-500/30 bg-amber-500/[0.06] px-3 py-2.5 cc-blocked-banner-in ${fresh ? "cc-blocked-banner-glow" : ""}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <button
            onClick={() => setExpanded((v) => !v)}
            className="flex items-center gap-1 text-left text-xs font-semibold text-sol-text hover:text-amber-500 transition-colors"
            title={expanded ? "Hide the affected sessions" : "Show which sessions are blocked"}
          >
            <ChevronRight className={`h-3 w-3 shrink-0 transition-transform ${expanded ? "rotate-90" : ""}`} />
            {/* Headline names the LARGEST slice — a fleet that is mostly
                signed out shouldn't read "blocked on usage limits" because a
                couple of stragglers also hit a limit. */}
            {blocked.length} session{blocked.length === 1 ? "" : "s"} blocked on{" "}
            {([
              [limitCount, "usage limits"],
              [authCount, "login"],
              [connCount, "dropped connections"],
              [fatalCount, "api errors"],
            ] as const).reduce((best, cur) => (cur[0] > best[0] ? cur : best))[1]}
          </button>
          {/* The breakdown items always sum to the headline count: when the
              checkbox excludes subagents from the acted set, the excluded
              slice appears here as its own item instead of silently vanishing
              from the math. Every button below reuses these exact counts. */}
          <div className="mt-0.5 text-[11px] leading-snug text-sol-text-muted">
            {[
              limitCount > 0 ? `${limitCount} hit a usage limit` : null,
              connCount > 0 ? `${connCount} dropped mid-response` : null,
              fatalCount > 0 ? `${fatalCount} failed on an api error` : null,
              authCount > 0 ? `${authCount} signed out` : null,
              !includeSubs && subagents.length > 0
                ? `${subagents.length} subagent worker${subagents.length === 1 ? "" : "s"} skipped`
                : null,
              acted.length > 30 ? "each pass acts on the 30 most recent" : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </div>
          {subagents.length > 0 && (
            <label
              className="mt-1 flex w-fit cursor-pointer items-center gap-1.5 text-[11px] text-sol-text-dim hover:text-sol-text"
              title="Subagent workers are skipped by default — their parent session has usually moved on, so reviving them spends the account on work nobody is waiting for"
            >
              <input
                type="checkbox"
                checked={includeSubs}
                onChange={(e) => setIncludeSubs(e.target.checked)}
                className="h-3 w-3 shrink-0 accent-amber-500"
              />
              include the {subagents.length} skipped worker{subagents.length === 1 ? "" : "s"}
            </label>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {latestBlockAt > 0 && (
            <span
              className="text-[10px] tabular-nums text-sol-text-dim whitespace-nowrap"
              title={`${blocked.length > 1 ? "Most recent block: " : "Blocked "}${new Date(latestBlockAt).toLocaleString()}`}
            >
              {blocked.length > 1 ? "latest " : ""}{fmtDuration(Math.max(0, now - latestBlockAt))} ago
            </span>
          )}
          <button
            onClick={closeBanner}
            className="rounded p-0.5 text-sol-text-dim hover:bg-sol-bg-alt hover:text-sol-text"
            title="Hide for 24h — the amber pill in the header brings it back anytime"
            aria-label="Snooze this banner"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
      {/* The big sign-in CTA belongs only to a LOGIN incident — the same
          condition that makes the headline read "blocked on login". In a
          mixed fleet (limits + a few signed out) the remedy the banner leads
          with is continue/switch; a loud sign-in button under a "usage
          limits" headline reads as the wrong fix. */}
      {authCount > 0 && limitCount === 0 && connCount === 0 && fatalCount === 0 && loginDevice && (
        <SignInCta device={loginDevice} authSessionIds={actedAuthIds} disabled={busy !== null} />
      )}
      {expanded && (
        <div className="mt-2 max-h-56 overflow-y-auto scrollbar-auto rounded border border-amber-500/15 bg-sol-bg/40 divide-y divide-sol-border/30">
          {blockedSorted.map((sess) => (
            <div
              key={sess._id}
              className="group flex w-full items-center gap-2 px-2 py-1.5 hover:bg-amber-500/10 transition-colors"
            >
              <button
                onClick={() => onOpen?.(sess)}
                className="flex min-w-0 flex-1 items-center gap-2 text-left"
                title="Open this session"
              >
                <AuthErrorBadge kind={sess.pending_api_error_kind} agentType={sess.agent_type} />
                <span className={`min-w-0 flex-1 truncate text-[11px] ${isSubagentConversation(sess) && !includeSubs ? "text-sol-text-dim" : "text-sol-text"}`}>
                  {cleanTitle(sess.title || "") || "Untitled session"}
                </span>
                {isSubagentConversation(sess) && (
                  <span className="shrink-0 rounded border border-sol-border/50 px-1 text-[9px] text-sol-text-dim" title="Subagent worker — excluded from revive unless included above">
                    sub
                  </span>
                )}
                <span className="shrink-0 text-[10px] text-sol-text-dim">{getProjectName(sess.git_root, sess.project_path)}</span>
                <span
                  className="shrink-0 text-[10px] tabular-nums text-sol-text-dim"
                  title={`Blocked ${new Date(blockAt(sess)).toLocaleString()}`}
                >
                  {fmtDuration(Math.max(0, now - blockAt(sess)))} ago
                </span>
              </button>
              <button
                onClick={() => handleAcknowledge([sess._id])}
                className="shrink-0 rounded p-0.5 text-sol-text-dim opacity-0 group-hover:opacity-100 hover:bg-sol-bg-alt hover:text-sol-text transition-opacity"
                title="Never restart this session — remove it from the blocked set permanently"
                aria-label="Dismiss this session from the banner permanently"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
      )}
      {/* The whole action surface: [Continue all N] on [account ▾] … dismiss.
          One solid button, one quiet select, one quiet escape hatch — nothing
          folded away, nothing competing. */}
      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1.5">
        <button
          onClick={handleContinue}
          disabled={busy !== null || acted.length === 0}
          title={acted.length === 0 ? "Only subagent workers are blocked — tick the box above to include them" : continueTitle}
          className="rounded bg-amber-500 px-3 py-1 text-[11px] font-bold text-sol-bg shadow-sm transition-colors hover:bg-amber-400 disabled:opacity-60"
        >
          {busy !== null
            ? selectedAccount
              ? "Switching…"
              : "Continuing…"
            : selectedAccount
              ? `Switch & continue ${countLabel}`
              : `Continue ${countLabel}`}
        </button>
        {rankedAccounts.length > 0 && (
          <label
            className="flex min-w-0 items-center gap-1.5 text-[11px] text-sol-text-dim"
            title={`Which Claude account the sessions continue on${activeEmail ? ` — currently ${activeEmail}` : activeEmails.length > 1 ? ` — currently ${activeEmails.join(" / ")}` : ""}; only accounts saved on ${executors.length === 1 ? executors[0].label : "the machines owning these sessions"} are offered`}
          >
            on
            <select
              value={onAccount}
              onChange={(e) => setOnAccount(e.target.value)}
              disabled={busy !== null}
              className="max-w-[220px] rounded border border-amber-500/25 bg-sol-bg px-1.5 py-0.5 text-[11px] text-sol-text outline-none hover:border-amber-500/50 focus:border-amber-500 disabled:opacity-60"
            >
              <option value="">
                {activeEmail ? `this account (${activeEmail})` : activeEmails.length > 1 ? `current accounts (${activeEmails.join(" / ")})` : "this account"}
                {usageNote(activeUsage)}
              </option>
              {rankedAccounts.map((t) => (
                <option key={t.key} value={t.key}>
                  {t.email ?? t.name}{usageNote(t.usage)}{t.missingOn.length > 0 ? ` — not on ${t.missingOn.join(", ")}` : ""}
                </option>
              ))}
            </select>
          </label>
        )}
        <button
          onClick={() => handleAcknowledge(blocked.map((sess) => sess._id))}
          disabled={busy !== null}
          title="Never restart these — clear all of them from the blocked set permanently"
          className="ml-auto rounded px-2 py-1 text-[11px] text-sol-text-dim hover:text-sol-text transition-colors disabled:opacity-60"
        >
          {blocked.length === 1 ? "Dismiss it" : `Dismiss all ${blocked.length}`}
        </button>
      </div>
    </div>
  );
}

// -- The TRIGGERS section (every armed schedule, schedule-first) --

// One row per armed schedule — recurring, once, or event; inject or spawn; no
// distinction the user must learn. The row IS the schedule's identity in the
// inbox: name, cadence, live countdown, last outcome, lightweight verbs.
// Clicking opens the conversation behind it (home session or latest run — the
// dismissed-peek path handles folded runs). Everything a schedule does stays
// behind its row; escalations and human-driven turns are ordinary cards.
// Two INDEPENDENT facts a schedule row carries, kept separate so their colors
// can't blur into each other:
//   • the LEFT ACCENT = health/liveness — red ONLY when a run failed or the
//     agent flagged it (red always means "look at this"); green while running;
//     dim when paused; else the calm schedule-amber.
//   • the BADGE = the NEXT fire — a soft orange tint at rest (orange is the
//     trigger accent, but a resting countdown is furniture, so tint not solid),
//     brighter when imminent (<10m), and never red: "about to fire" is not
//     "went wrong".
type SchedAccent = "running" | "attention" | "paused" | "normal";
function schedAccent(task: { status: string; last_run_failed?: boolean; last_run_needs_attention?: boolean }): SchedAccent {
  if (task.status === "running") return "running";
  if (task.last_run_failed || task.last_run_needs_attention) return "attention";
  if (task.status === "paused") return "paused";
  return "normal";
}
const SCHED_ACCENT: Record<SchedAccent, string> = {
  running: "border-l-sol-green",
  attention: "border-l-sol-red",
  paused: "border-l-sol-border",
  normal: "border-l-sol-amber/50",
};
function schedBadgeTone(task: { status: string; run_at?: number }, now: number): string {
  if (task.status === "paused") return "bg-sol-bg-alt text-sol-text-dim border-sol-border/50";
  if (task.status === "running") return "bg-sol-green/10 text-sol-green border-sol-green/30";
  // Stuck-due is the one badge state that earns red: the daemon should claim
  // due work within seconds, so minutes overdue means nothing is listening.
  if (isTaskOverdue(task, now)) return "bg-sol-red/10 text-sol-red border-sol-red/40 font-bold";
  const ms = task.run_at !== undefined ? task.run_at - now : undefined;
  if (ms !== undefined && ms <= 10 * 60_000) return "bg-sol-amber/20 text-sol-amber border-sol-amber/50 font-bold";
  return "bg-sol-amber/[0.08] text-sol-amber/90 border-sol-amber/25";
}

// The ↳ corner arrow an attached schedule row/strip wears — the SAME glyph the
// subagent rows carry (in schedule-amber, not subagent violet), so the child
// connectors line up under a card and the amber alone says "schedule".
function SchedChildArrow({ label, className }: { label: string; className?: string }) {
  return (
    <span className={`flex items-center mt-[2px] shrink-0 ${className ?? "text-sol-amber/70"}`} role="img" aria-label={label}>
      <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
        <title>{label}</title>
        <path strokeLinecap="round" strokeLinejoin="round" d="M6 4v12h12" />
        <path strokeLinecap="round" strokeLinejoin="round" d="M14 12l4 4-4 4" />
      </svg>
    </span>
  );
}

// The health dot beside a schedule's name: green pulse while a run is live,
// red when the last run failed or flagged itself; nothing at rest. Shared by
// the full row and the folded strip so the two never disagree on "look here".
function SchedHealthDot({ accent, task }: { accent: SchedAccent; task: { last_run_failed?: boolean } }) {
  if (accent === "running") {
    return (
      <ShortcutTooltip label="Running now">
        <span className="relative flex h-2 w-2 shrink-0 items-center justify-center">
          <span className="absolute inline-flex h-2 w-2 rounded-full bg-sol-green/40 animate-ping motion-reduce:animate-none" />
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-sol-green" />
        </span>
      </ShortcutTooltip>
    );
  }
  if (accent === "attention") {
    return (
      <ShortcutTooltip label={task.last_run_failed ? "Last run failed" : "Flagged for attention"}>
        <span className="w-1.5 h-1.5 rounded-full bg-sol-red shrink-0" />
      </ShortcutTooltip>
    );
  }
  return null;
}

// The next-fire badge — one tone function, one label function, so the strip and
// the row show the same countdown for the same schedule.
// Memoized with its own label-keyed clock: ~80 badges used to re-render on
// every parent pass and every 30s tick, each paying toLocale* formatting and a
// tooltip. Now a badge re-renders only when its text would change.
const SchedFireBadge = memo(function SchedFireBadge({ task, className = "" }: { task: TaskRow; className?: string }) {
  const now = useNowWhen((t) => taskStateLabel(task, t), 30_000);
  const badge = (
    <span className={`${className} shrink-0 inline-flex items-center justify-center min-w-[46px] px-1 py-0 rounded text-[9px] font-semibold tabular-nums border transition-colors ${schedBadgeTone(task, now)}`}>
      {taskStateLabel(task, now)}
    </span>
  );
  if (task.status !== "scheduled") return badge;
  // Cadence lives here, not on the row: "in 5h 57m" already says the schedule
  // is armed; how often it repeats is detail you hover for.
  const cadence = describeTaskCadence(task);
  return (
    <ShortcutTooltip label={task.run_at !== undefined ? `Fires at ${fmtClock(task.run_at)}` : `Fires ${cadence}`} hint={task.run_at !== undefined ? cadence : undefined}>
      {badge}
    </ShortcutTooltip>
  );
});

// One schedule row, used EVERYWHERE a schedule renders as a row: the dock
// roster and the bars stacked under a session card (attached). One anatomy so
// the surfaces can't drift: readable name, one-sentence gist of what each run
// does (Haiku-distilled display fields), cadence + live countdown, last
// outcome, and hover verbs (history / open / run now / pause) on every
// surface. Cancel is destructive and rare, so it lives in the right-click menu
// and on /triggers, not one slip away on the hover rail.
const TriggerRowItem = memo(function TriggerRowItem({ row, activeSessionId, onOpen, attached, highlighted, projectChip, onNavigated }: {
  row: TriggerRow;
  activeSessionId?: string | null;
  onOpen: (row: TriggerRow) => void;
  // Rendered under its owning session card — tinted like the subagent stack
  // and top-joined to the card instead of list-bordered below.
  attached?: boolean;
  // Keyboard cursor (roster arrow-nav) — visual only; Enter acts on it.
  highlighted?: boolean;
  // Short project name, shown when the roster spans several projects so
  // cross-project schedules stop being indistinguishable.
  projectChip?: string;
  // Called after a run-history click navigated away — the dock roster passes
  // its close() so the overlay doesn't linger over the new conversation.
  onNavigated?: () => void;
}) {
  const { task, unread } = row;
  const router = useRouter();
  // Pseudo rows (harness loops) wear the same anatomy but carry no server
  // verbs — there's no agent_tasks row to pause or cancel, and no run history
  // to query. See triggerTasks.ts.
  const isPseudo = !!row.kind;
  const now = useCoarseNow(30_000);
  // Every verb is a store action (local-first): the agent_tasks row flips on
  // the draft the instant it's clicked and the dispatch side effect runs the
  // real mutation. Same actions the triggers page and the strip use.
  const triggerAction = useInboxStore((st) => st.triggerAction);
  const taskId = task._id as Id<"agent_tasks">;
  const runNow = () => triggerAction(taskId, "runNow");
  const pause = () => triggerAction(taskId, "pause");
  const resume = () => triggerAction(taskId, "resume");
  const cancel = () => triggerAction(taskId, "cancel");
  const reactivate = () => triggerAction(taskId, "reactivate");
  const paused = task.status === "paused";
  const isActive = !!row.openId && row.openId === activeSessionId;
  const accent = schedAccent(task);
  const gist = task.display_summary?.trim() || task.prompt;
  // Click feedback: an orange wash that fades (keyed so re-clicks re-trigger).
  // Selection alone can't confirm the click — the row's session is often
  // already active, and the resting selected tint is the shared cyan — so the
  // schedule-amber pulse is what says "this schedule heard you".
  const [clickFlash, setClickFlash] = useState(0);
  // Inline run history (the hover rail's History verb). Query only while
  // open, so a resting roster costs nothing; each entry navigates to the
  // message that triggered that run.
  const [runsOpen, setRunsOpen] = useState(false);
  const runs = useTriggerRuns(runsOpen && !isPseudo ? task._id : null);
  // Right-click mirrors the hover rail verb-for-verb; pseudo rows (harness
  // loops) have no server verbs, so they get no menu.
  const ctxMenu = useContextMenu<void>();
  return (
    <div
      data-schedrow={task._id}
      data-attached={attached || undefined}
      data-row-active={isActive || undefined}
      onContextMenu={!isPseudo ? (e) => ctxMenu.open(e, undefined) : undefined}
      className={`group/schedrow relative transition-colors ${
        // Attached rows sit flush under their card — no separator line above and
        // no left accent bar. The ↳ arrow carries the parent/child connection,
        // and health/liveness stays readable via the title dots + "retrying"
        // text, so a colored (esp. red) left rail would only add noise here.
        attached ? "" : "border-b border-sol-border/30"
      } ${
        isActive
          ? attached
            ? "bg-sol-cyan/[0.10]"
            : "border-l border-l-sol-cyan/40 bg-sol-cyan/[0.10]"
          : attached
            ? ""
            : `border-l-2 ${SCHED_ACCENT[accent]}`
      } ${
        highlighted ? "bg-[color-mix(in_srgb,var(--sol-bg-alt)_70%,transparent)] ring-1 ring-inset ring-sol-amber/40" : ""
      }`}
    >
      {/* Inner relative wrapper: the click-flash and the hover verb rail size
          to the ROW line only, so an expanded run history below never sits
          under the rail's gradient or its hover targets. */}
      <div className="relative">
      <button
        className={`w-full text-left cursor-pointer pr-3 ${attached ? "pl-2 py-1" : "pl-2.5 py-1.5"} hover:bg-sol-amber/[0.05] transition-[background-color,opacity] ${paused ? "opacity-55 hover:opacity-90" : ""}`}
        onClick={() => {
          setClickFlash((n) => n + 1);
          onOpen(row);
        }}
      >
        {/* Attached rows wear the subagent child idiom: the SAME ↳ corner arrow
            the subagent rows below carry (in schedule-amber, not subagent
            violet), so the connectors line up and the row reads as this card's
            child instead of a glyph floating in indented space. The orange
            alone marks it as a schedule — no extra identity icon. */}
        <div className="flex gap-1.5 min-w-0">
        {attached && <SchedChildArrow label={row.kind === "loop" ? "Loop — the agent wakes itself in this session" : "Trigger — fires into this session"} />}
        <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 min-w-0">
          <SchedHealthDot accent={accent} task={task} />
          {/* Attached rows recede to the SAME muted title treatment the subagent
              child rows below use (text-gray-400, normal weight) so the parent
              card stays the primary read and the two child idioms match in both
              themes; the roster version keeps full prominence. */}
          <span className={`text-xs truncate min-w-0 ${attached ? "text-gray-400 font-normal" : "text-sol-text font-medium"}`}>{taskDisplayTitle(task)}</span>
          {projectChip && (
            <ShortcutTooltip label={task.project_path || projectChip}>
              <span className={`shrink-0 px-1 rounded text-[9px] font-medium border ${getLabelColor(projectChip).bg} ${getLabelColor(projectChip).text} ${getLabelColor(projectChip).border}`}>
                {projectChip}
              </span>
            </ShortcutTooltip>
          )}
          {/* Same pill as the dock bar's "N new" count, so opening the roster
              shows exactly which rows that number pointed at. Roster only: a
              bar under a card is always in view, so "since you last opened the
              roster" means nothing there. */}
          {unread && !attached && (
            <ShortcutTooltip label="Outcome landed since you last opened this list">
              <span className="shrink-0 px-1 rounded-full bg-sol-amber/15 text-sol-amber text-[9px] font-medium">new</span>
            </ShortcutTooltip>
          )}
          {/* Cadence text stays on roster rows (the roster is the place to scan
              "what runs how often"); attached rows keep only the countdown and
              tuck the cadence into its tooltip. */}
          {(row.kind === "loop" || !attached) && (
            <span className="ml-auto shrink-0 text-[10px] font-medium text-sol-text-muted">
              {row.kind === "loop" ? "loop" : describeTaskCadence(task)}
            </span>
          )}
          <SchedFireBadge task={task} className={attached && row.kind !== "loop" ? "ml-auto" : ""} />
        </div>
        {/* Attached rows are TWO lines, always: the gist shares its line with
            the last-outcome meta (retrying, recency) so a bar under a card
            never grows a third line. The roster has room to let the sentence
            breathe across two, with the outcome report on its own line below.
            A fresh schedule whose Haiku gist hasn't landed yet shows the raw
            prompt with a pulse. */}
        {(() => {
          const sparkle = !isPseudo && !task.display_summary && now - task.created_at < 5 * 60_000 && (
            <ShortcutTooltip label="Haiku is distilling a summary of this prompt">
              <span className="text-sol-amber/70 animate-pulse motion-reduce:animate-none">✦ </span>
            </ShortcutTooltip>
          );
          const ago = task.last_run_at !== undefined ? `${fmtDuration(Math.max(0, now - task.last_run_at))} ago` : undefined;
          const retrying = (task.retry_count ?? 0) > 0 && (
            <ShortcutTooltip label="The last run errored; the daemon is retrying">
              <span className="shrink-0 text-[10px] text-sol-red/80 font-medium">retrying ×{task.retry_count}</span>
            </ShortcutTooltip>
          );
          if (attached) {
            // Two lines, ALWAYS — an attached bar never grows a third. When
            // the last run left a report, the report IS the second line: the
            // robot speaking (same voice idiom as the card's blue "> message"
            // line) outranks the static gist, which retreats into the report's
            // tooltip. A schedule that hasn't reported yet shows the gist.
            const agoEl = ago ? (
              <span className={`shrink-0 text-[10px] tabular-nums ${task.last_run_failed ? "text-sol-red/80" : "text-sol-text-dim"}`}>{ago}</span>
            ) : null;
            return (
              <div className="flex items-baseline gap-1.5 mt-0.5 min-w-0">
                {task.last_run_summary ? (
                  <ShortcutTooltip label={gist} hint="the trigger's standing prompt">
                    <span className={`flex-1 min-w-0 truncate text-[11px] leading-snug font-semibold ${task.last_run_failed ? "text-sol-red/90" : "text-sol-green"}`}>
                      <span className={`mr-0.5 ${task.last_run_failed ? "text-sol-red/50" : "text-sol-green/50"}`}>&gt;</span>
                      {task.last_run_summary}
                    </span>
                  </ShortcutTooltip>
                ) : (
                  <span className="flex-1 min-w-0 truncate text-[11px] leading-snug text-sol-text-dim">
                    {sparkle}
                    {gist}
                  </span>
                )}
                {retrying}
                {agoEl}
              </div>
            );
          }
          // Where a fire lands: an injecting schedule wakes its home session —
          // named, so the roster row isn't a mystery verb. Hidden when the home
          // session is just named after the schedule itself (says nothing).
          const target =
            task.originating_conversation_title &&
            task.originating_conversation_title.trim().toLowerCase() !== taskDisplayTitle(task).trim().toLowerCase()
              ? task.originating_conversation_title
              : undefined;
          const meta = [
            task.run_count > 0 ? `${task.run_count} run${task.run_count === 1 ? "" : "s"}` : undefined,
            ago,
          ].filter(Boolean).join(" · ");
          return (
            <>
              <div className="mt-0.5 text-[11px] leading-snug text-sol-text-dim min-w-0 line-clamp-2">
                {sparkle}
                {gist}
              </div>
              {(task.run_count > 0 || task.last_run_summary || (task.retry_count ?? 0) > 0 || target) && (
                <div className="flex items-baseline gap-1.5 mt-0.5 min-w-0">
                  {target && (
                    <ShortcutTooltip label={`Fires into: ${target}`}>
                      <span className="shrink-0 max-w-[40%] truncate text-[10px] text-sol-text-dim">→ {target}</span>
                    </ShortcutTooltip>
                  )}
                  {retrying}
                  {/* The last run's report in the same voice idiom as the
                      attached rows (and the card's blue "> message" line):
                      semibold, status-tinted, dim ">" prefix. */}
                  {task.last_run_summary && (
                    <span className={`truncate min-w-0 text-[11px] font-semibold ${task.last_run_failed ? "text-sol-red/90" : "text-sol-green"}`}>
                      <span className={`mr-0.5 ${task.last_run_failed ? "text-sol-red/50" : "text-sol-green/50"}`}>&gt;</span>
                      {task.last_run_summary}
                    </span>
                  )}
                  {meta && <span className="ml-auto shrink-0 text-[10px] text-sol-text-dim tabular-nums">{meta}</span>}
                </div>
              )}
            </>
          );
        })()}
        </div>
        </div>
      </button>
      {/* Keyed remount replays the animation on every click; it ends fully
          transparent (fill-mode forwards), so the spent span can just stay —
          no animationend cleanup, which never fires in occluded windows. */}
      {clickFlash > 0 && (
        <span key={clickFlash} aria-hidden className="sched-click-flash absolute inset-0 pointer-events-none" />
      )}
      {/* Hover action rail — same idiom as the inbox session cards: a right-hand
          strip that fades in over a gradient (so it reads as "revealed", not a
          box dropped on top), holding compact icon verbs. Absolute + full-height
          so revealing it never changes the row's height. Pseudo rows (loops)
          have no rail: their verbs live inside the session itself. */}
      {!isPseudo && (
      <div className="absolute top-0 bottom-0 right-0 flex items-center gap-0.5 pl-12 pr-2 opacity-0 group-hover/schedrow:opacity-100 transition-opacity duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] bg-gradient-to-r from-transparent via-[color-mix(in_srgb,var(--sol-bg-alt)_80%,transparent)] to-sol-bg-alt">
        <ShortcutTooltip label={runsOpen ? "Hide run history" : "Run history"} hint="every run links to its trigger message" side="top">
          <button
            aria-label={runsOpen ? "Hide run history" : "Show run history"}
            aria-expanded={runsOpen}
            onClick={(e) => { e.stopPropagation(); setRunsOpen((v) => !v); }}
            className={`p-1 rounded transition-[color,background-color,transform] duration-100 active:scale-90 ${
              runsOpen ? "text-sol-amber bg-sol-amber/10" : "text-sol-text-dim hover:text-sol-text hover:bg-sol-bg-alt"
            }`}
          >
            <History className="w-3.5 h-3.5" />
          </button>
        </ShortcutTooltip>
        <ShortcutTooltip label="Open trigger page" hint="full detail, history, edit" side="top">
          <Link
            href={`/triggers/${task._id}`}
            aria-label="Open in Triggers"
            onClick={(e) => e.stopPropagation()}
            className="p-1 rounded text-sol-text-dim hover:text-sol-text hover:bg-sol-bg-alt transition-[color,background-color,transform] duration-100 active:scale-90"
          >
            <Settings2 className="w-3.5 h-3.5" />
          </Link>
        </ShortcutTooltip>
        {task.status !== "running" && (
          <ShortcutTooltip label="Run now" side="top">
            <button
              aria-label="Run now"
              onClick={(e) => { e.stopPropagation(); runNow(); toast.success("Run queued"); }}
              className="p-1 rounded text-sol-text-dim hover:text-sol-amber hover:bg-sol-amber/10 transition-[color,background-color,transform] duration-100 active:scale-90"
            >
              <Play className="w-3.5 h-3.5" fill="currentColor" strokeWidth={0} />
            </button>
          </ShortcutTooltip>
        )}
        <ShortcutTooltip label={paused ? "Resume trigger" : "Pause trigger"} side="top">
          <button
            aria-label={paused ? "Resume trigger" : "Pause trigger"}
            onClick={(e) => {
              e.stopPropagation();
              if (paused) resume(); else pause();
            }}
            className="p-1 rounded text-sol-text-dim hover:text-sol-text hover:bg-sol-bg-alt transition-[color,background-color,transform] duration-100 active:scale-90"
          >
            {paused ? <Play className="w-3.5 h-3.5" fill="currentColor" strokeWidth={0} /> : <Pause className="w-3.5 h-3.5" fill="currentColor" strokeWidth={0} />}
          </button>
        </ShortcutTooltip>
      </div>
      )}
      </div>
      {/* Past runs, inline: every run of this schedule, newest first, each
          entry landing on the message that triggered it. */}
      {runsOpen && !isPseudo && (
        <div className={`${attached ? "pl-6" : "pl-2.5"} pr-2 pb-1.5`} onClick={(e) => e.stopPropagation()}>
          {runs === undefined ? (
            <div className="text-[10px] text-sol-text-dim py-1 pl-1.5">Loading runs…</div>
          ) : runs.length === 0 ? (
            <div className="text-[10px] text-sol-text-dim py-1 pl-1.5">No runs recorded yet</div>
          ) : (
            <TriggerRunList
              runs={runs}
              now={now}
              currentConversationId={activeSessionId}
              onOpened={onNavigated}
            />
          )}
        </div>
      )}
      {!isPseudo && (
        <ContextMenu state={ctxMenu}>
          {() => (
            <>
              <CtxHeader title={taskDisplayTitle(task)} id={(task as any).short_id} />
              {task.status !== "running" && (
                <CtxItem
                  icon={Play}
                  onSelect={() => { runNow(); toast.success("Run queued"); }}
                >
                  Run now
                </CtxItem>
              )}
              <CtxItem
                icon={paused ? Play : Pause}
                onSelect={() => { if (paused) resume(); else pause(); }}
              >
                {paused ? "Resume trigger" : "Pause trigger"}
              </CtxItem>
              <CtxItem icon={History} onSelect={() => setRunsOpen((v) => !v)}>
                {runsOpen ? "Hide run history" : "Run history"}
              </CtxItem>
              <CtxItem icon={Settings2} onSelect={() => router.push(`/triggers/${task._id}`)}>
                Open trigger page
              </CtxItem>
              <CtxSeparator />
              <CtxItem
                icon={Copy}
                onSelect={() => { copyToClipboard(task.prompt || ""); toast.success("Prompt copied"); }}
              >
                Copy prompt
              </CtxItem>
              <CtxSeparator />
              <CtxItem
                danger
                icon={X}
                onSelect={() => {
                  cancel();
                  toast("Trigger canceled", { description: taskDisplayTitle(task), action: { label: "Undo", onClick: () => { reactivate(); } } });
                }}
              >
                Cancel trigger
              </CtxItem>
            </>
          )}
        </ContextMenu>
      )}
    </div>
  );
})

// The folded form of the bars under a card — the resting state (card_bars
// "strip", the default). ONE line for every bar family the card carries:
// triggers, a workflow run in flight, live monitors / background commands. The
// trigger part speaks for the most urgent row (running > flagged > next to
// fire > paused); the other families append compact segments in their own
// accent so the strip still says what kind of machinery the card runs.
// Clicking opens the primary trigger's row the way its full row would, or the
// session itself when the card has no triggers. The pill's ⚡ toggle unfolds
// every strip into full rows (or hides them); nothing here is a second way to
// expand.
type CardBarsMode = "strip" | "full" | "hidden";
const SCHED_ACCENT_RANK: Record<SchedAccent, number> = { running: 0, attention: 1, normal: 2, paused: 3 };
function primaryTriggerRow(rows: TriggerRow[]): TriggerRow {
  return rows.reduce((best, r) => {
    const d = SCHED_ACCENT_RANK[schedAccent(r.task)] - SCHED_ACCENT_RANK[schedAccent(best.task)];
    if (d !== 0) return d < 0 ? r : best;
    return (r.task.run_at ?? Infinity) < (best.task.run_at ?? Infinity) ? r : best;
  });
}
const CardBarStrip = memo(function CardBarStrip({ session, rows, activeSessionId, onOpen, onOpenSession }: {
  session: InboxSession;
  rows: TriggerRow[];
  activeSessionId?: string | null;
  onOpen: (row: TriggerRow) => void;
  onOpenSession: (session: InboxSession) => void;
}) {
  const now = useCoarseNow(30_000);
  const watching = useLiveWatchRows(session, now);
  const workflow = workflowBarVisible(session);
  if (rows.length === 0 && !workflow && watching.length === 0) return null;
  const primary = rows.length > 0 ? primaryTriggerRow(rows) : null;
  const isActive = session._id === activeSessionId;
  // A card whose only bars are paused schedules rests dimmer; anything live
  // (a workflow, a watch) keeps the strip at full presence.
  const paused = !!primary && rows.every((r) => r.task.status === "paused") && !workflow && watching.length === 0;
  const bgCount = watching.filter((r) => r.kind === "background").length;
  const monCount = watching.length - bgCount;
  const label = primary
    ? rows.length === 1
      ? "Trigger — fires into this session"
      : `${rows.length} triggers fire into this session`
    : workflow
      ? "Workflow — running inside this session"
      : "Background work — running inside this session";
  return (
    <button
      data-schedstrip={primary ? session._id : undefined}
      onClick={() => (primary ? onOpen(primary) : onOpenSession(session))}
      className={`w-full flex items-center gap-1.5 text-left cursor-pointer pl-2 pr-3 py-[3px] transition-[background-color,opacity] hover:bg-sol-amber/[0.05] ${
        isActive ? "bg-sol-cyan/[0.10]" : ""
      } ${paused ? "opacity-55 hover:opacity-90" : ""}`}
    >
      <SchedChildArrow label={label} className={primary ? undefined : "text-sol-blue/70"} />
      {primary && (
        <>
          <Zap className="w-2.5 h-2.5 shrink-0 text-sol-amber/70" fill="currentColor" strokeWidth={0} />
          <SchedHealthDot accent={schedAccent(primary.task)} task={primary.task} />
          <span className="text-[11px] text-gray-400 truncate min-w-0">
            {rows.length === 1 ? taskDisplayTitle(primary.task) : `${rows.length} triggers`}
          </span>
          {rows.length > 1 && (
            <span className="text-[10px] text-sol-text-dim truncate min-w-0">
              {rows.map((r) => taskDisplayTitle(r.task)).join(" · ")}
            </span>
          )}
        </>
      )}
      {workflow && (
        <span className="text-[10px] text-sol-cyan/80 truncate min-w-0 shrink-[2]">
          {primary ? "· " : ""}{session.workflow_run_name || "workflow"}
        </span>
      )}
      {watching.length > 0 && (
        <span className="text-[10px] text-sol-blue/80 whitespace-nowrap shrink-0">
          {primary || workflow ? "· " : ""}
          {bgCount > 0 ? `${bgCount} running` : ""}
          {bgCount > 0 && monCount > 0 ? " · " : ""}
          {monCount > 0 ? `${monCount} watching` : ""}
        </span>
      )}
      {primary ? (
        <SchedFireBadge task={primary.task} className="ml-auto" />
      ) : (
        <span className="ml-auto shrink-0 inline-flex items-center gap-1 justify-center min-w-[46px] px-1 py-0 rounded text-[9px] font-semibold border bg-sol-green/10 text-sol-green border-sol-green/30">
          <span className="w-1 h-1 rounded-full bg-sol-green animate-pulse motion-reduce:animate-none" />
          running
        </span>
      )}
    </button>
  );
});

// -- Monitor bars (live background watches) --
// A live Monitor (the harness background-watch tool) or background command
// stacks under its session card exactly like the schedule bars above: same ↳
// child idiom and two-line header + subrow anatomy, in monitor blue so it
// can't blur into schedule orange or subagent violet. Rows come from two
// sources merged (liveWatchRowsFor): the conversation's loaded message window
// (the watch's own lifecycle) and the daemon's verified open-task report on
// the row (open_tasks — draws the row without messages, and retires a watch
// the daemon found dead). "Watching" is only claimed while the session can
// still host the watch (isWatchHostDead: not killed, not stopped, spoken for
// by a daemon) — NOT the card's status-trust decay, which would hide a live
// poll on a long build the moment the session went quiet for an hour.
// A card with many live watchers (a deploy fanning out `until grep` shells
// can stand eight at once) would stack that many bars — cap the stack and
// fold the rest behind a count row.
const MAX_MONITOR_BARS = 3;

// Message-derived watch rows (own lifecycle + restart fence) merged with the
// daemon's verified report — the report supplies rows the loaded window lacks
// and retires rows the daemon found dead (liveWatchRowsFor). One hook so the
// full bars, the folded strip and the dormant fallback all read the same rows.
function useLiveWatchRows(session: InboxSession, now: number) {
  const messages = useInboxStore((st) => st.messages[session._id]);
  return useMemo(
    () => (isWatchHostDead(session, now) ? [] : liveWatchRowsFor(session, messages, now)),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the row fields the merge reads
    [messages, now, session.open_tasks, session.open_tasks_at, session.agent_started_at, session.agent_status, session.inbox_killed_at, session.updated_at],
  );
}

// A dynamic-workflow run in flight inside the card above — the session's turn
// has ended but it is WAITING on the fleet, so the run gets the same ↳ child
// bar the schedule and monitor families wear, in workflow cyan. Rendered from
// the row's enriched scalars (conversations.workflow_run_id → workflow_runs),
// so it shows even when the launch message isn't in the loaded window. Paused
// runs stay the card's magenta Gate chip; this bar carries running/pending.
// Whether the card wears the workflow bar — shared with the Dormant fallback
// row so the two can't disagree about "this card already shows its wake".
function workflowBarVisible(session: InboxSession): boolean {
  if (!session.is_workflow_primary || !session.workflow_run_id) return false;
  return session.workflow_run_status === "running" || session.workflow_run_status === "pending";
}

function WorkflowBar({ session, isActive }: { session: InboxSession; isActive: boolean }) {
  const router = useRouter();
  const now = useCoarseNow(30_000);
  if (!workflowBarVisible(session)) return null;
  const done = session.workflow_run_agents_done ?? 0;
  const total = session.workflow_run_agents_total ?? 0;
  const ariaLabel = "Workflow — running inside this session";
  return (
    <div className={`group/wfrow relative transition-colors ${isActive ? "bg-sol-cyan/[0.10]" : ""}`}>
      <button
        className="w-full text-left cursor-pointer pr-3 pl-2 py-1 hover:bg-sol-cyan/[0.05] transition-colors"
        onClick={() => router.push(`/workflows/runs/${session.workflow_run_id}`)}
        title="Open the live run — phases, agents, results"
      >
        <div className="flex gap-1.5 min-w-0">
          <span className="flex items-center mt-[2px] shrink-0 text-sol-cyan/70" role="img" aria-label={ariaLabel}>
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <title>{ariaLabel}</title>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 4v12h12" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M14 12l4 4-4 4" />
            </svg>
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5 min-w-0">
              <span className="text-[9px] font-semibold uppercase tracking-wider text-sol-cyan/70 shrink-0">Workflow</span>
              <span className="text-xs truncate min-w-0 text-gray-400 font-normal">{session.workflow_run_name || "workflow run"}</span>
              <span className="ml-auto shrink-0 inline-flex items-center gap-1 justify-center min-w-[46px] px-1 py-0 rounded text-[9px] font-semibold border bg-sol-green/10 text-sol-green border-sol-green/30">
                <span className="w-1 h-1 rounded-full bg-sol-green animate-pulse motion-reduce:animate-none" />
                running
              </span>
            </div>
            <div className="flex items-baseline gap-1.5 mt-0.5 min-w-0">
              {session.workflow_run_activity ? (
                <span className="flex-1 min-w-0 truncate text-[11px] leading-snug font-medium text-sol-text-muted">
                  <span className="mr-0.5 text-sol-cyan/50">&gt;</span>
                  {session.workflow_run_activity}
                </span>
              ) : (
                <span className="flex-1 min-w-0 truncate text-[11px] leading-snug font-mono text-sol-text-dim">
                  multi-agent workflow
                </span>
              )}
              <span className="shrink-0 text-[10px] tabular-nums text-sol-text-dim">
                {total > 0 ? `${done}/${total} agents` : ""}
                {session.workflow_run_started_at ? `${total > 0 ? " · " : ""}${fmtDuration(Math.max(0, now - session.workflow_run_started_at))}` : ""}
              </span>
            </div>
          </div>
        </div>
      </button>
    </div>
  );
}

function MonitorBars({ session, isActive, onOpen }: {
  session: InboxSession;
  isActive: boolean;
  onOpen: (session: InboxSession) => void;
}) {
  const now = useCoarseNow(30_000);
  const [expanded, setExpanded] = useState(false);
  const watching = useLiveWatchRows(session, now);
  if (watching.length === 0) return null;
  const shown = expanded ? watching : watching.slice(0, MAX_MONITOR_BARS);
  const hiddenCount = watching.length - shown.length;
  return (
    <>
      {shown.map((row) => {
        const isBackground = row.kind === "background";
        const family = isBackground ? "Background" : "Monitor";
        const ariaLabel = isBackground
          ? "Background command — running inside this session"
          : "Monitor — watching inside this session";
        return (
        <div key={row.toolUseId} className={`group/monrow relative transition-colors ${isActive ? "bg-sol-cyan/[0.10]" : ""}`}>
          <button
            className="w-full text-left cursor-pointer pr-3 pl-2 py-1 hover:bg-sol-blue/[0.05] transition-colors"
            onClick={() => {
              // Land on the tool call that armed this watch, not the tail —
              // the click means "show me this watch in context". Rows always
              // derive from the loaded window, so the id is normally present;
              // fall back to a plain open if it somehow isn't.
              // requestNavigate's pending pointer is consumed ONLY by the
              // inbox surface: fired from any other page it no-ops now and
              // yanks the view on the user's next inbox visit. Off-inbox,
              // onOpen carries the page's own correct open behavior.
              const onInboxSurface = window.location.pathname.startsWith("/inbox");
              if (row.startMessageId && onInboxSurface) {
                useInboxStore.getState().requestNavigate(session._id, {
                  scrollToMessageId: row.startMessageId,
                  scrollToMessageTimestamp: row.startedAt,
                });
              } else {
                onOpen(session);
              }
            }}
          >
            <div className="flex gap-1.5 min-w-0">
              {/* Same corner arrow the schedule/subagent child rows carry, in
                  monitor blue: this watch runs inside the card above. */}
              <span className="flex items-center mt-[2px] shrink-0 text-sol-blue/70" role="img" aria-label={ariaLabel}>
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                  <title>{ariaLabel}</title>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 4v12h12" />
                  <path strokeLinecap="round" strokeLinejoin="round" d="M14 12l4 4-4 4" />
                </svg>
              </span>
              <div className="min-w-0 flex-1">
                {/* Header line: identity eyebrow, what's being watched, and the
                    live badge with how long the watch has been standing. */}
                <div className="flex items-center gap-1.5 min-w-0">
                  <span className="text-[9px] font-semibold uppercase tracking-wider text-sol-blue/70 shrink-0">{family}</span>
                  <span className="text-xs truncate min-w-0 text-gray-400 font-normal">{row.description}</span>
                  {/* Header carries ONLY identity + badge — the bar is
                      space-starved (esp. with the panel narrow), so event/time
                      meta lives on the subrow and the persistent chip rides
                      the badge tooltip; the conversation block keeps the chip. */}
                  <ShortcutTooltip label={isBackground ? "Background command — runs until it exits or is stopped, then wakes the agent" : row.persistent ? "Persistent watch — runs until TaskStop or session end" : `One-shot watch${row.timeoutMs !== undefined ? ` — times out after ${fmtDuration(row.timeoutMs)}` : ""}`}>
                    <span className="ml-auto shrink-0 inline-flex items-center gap-1 justify-center min-w-[46px] px-1 py-0 rounded text-[9px] font-semibold border bg-sol-green/10 text-sol-green border-sol-green/30">
                      <span className="w-1 h-1 rounded-full bg-sol-green animate-pulse motion-reduce:animate-none" />
                      {isBackground ? "running" : "watching"}
                    </span>
                  </ShortcutTooltip>
                </div>
                {/* Subrow: the last thing the watch saw (machine voice), or the
                    command it's running while nothing has fired yet — plus the
                    watch's clock (event count / age) on the right. */}
                <div className="flex items-baseline gap-1.5 mt-0.5 min-w-0">
                  {row.lastEvent ? (
                    <span className="flex-1 min-w-0 truncate text-[11px] leading-snug font-medium text-sol-text-muted">
                      <span className="mr-0.5 text-sol-blue/50">&gt;</span>
                      {row.lastEvent}
                    </span>
                  ) : (
                    <span className="flex-1 min-w-0 truncate text-[11px] leading-snug font-mono text-sol-text-dim">
                      {row.command.split("\n").find((l) => l.trim()) || "background watch"}
                    </span>
                  )}
                  <span className="shrink-0 text-[10px] tabular-nums text-sol-text-dim">
                    {row.eventCount > 0
                      ? `${row.eventCount} event${row.eventCount === 1 ? "" : "s"}${row.lastEventAt !== undefined ? ` · ${fmtDuration(Math.max(0, now - row.lastEventAt))} ago` : ""}`
                      : `for ${fmtDuration(Math.max(0, now - row.startedAt))}`}
                  </span>
                </div>
              </div>
            </div>
          </button>
        </div>
        );
      })}
      {(hiddenCount > 0 || watching.length > MAX_MONITOR_BARS) && (
        <button
          className="w-full text-left cursor-pointer pr-3 pl-7 py-0.5 text-[10px] text-sol-text-dim hover:text-sol-text-muted transition-colors"
          onClick={() => setExpanded((v) => !v)}
        >
          {hiddenCount > 0 ? `+${hiddenCount} more running` : "show fewer"}
        </button>
      )}
    </>
  );
}

// -- Dormant reason row --
// A card in DORMANT is parked on a machine wake, and the wake must be visible
// as a ↳ child row: the trigger bar for an armed schedule, the workflow bar
// for a run in flight, a Background/Monitor bar for an open watch. When none
// of those has anything to draw — the messages that would show the watch are
// not loaded and no daemon report exists, the agent declared dormancy on a
// wake outside this session (another session's reply, an external job), or
// the user parked the card — this row states the reason from what the row
// itself carries, so a Dormant card never sits there unexplained.
function DormantReasonRow({ session, isActive, hasOtherRows, onOpen }: {
  session: InboxSession;
  isActive: boolean;
  hasOtherRows: boolean;
  onOpen: (session: InboxSession) => void;
}) {
  const now = useCoarseNow(30_000);
  const watchRows = useLiveWatchRows(session, now).length;
  if (hasOtherRows || watchRows > 0) return null;
  const ts = threadStateView(session, session.message_count ?? 0, now);
  let family: string;
  let title: string;
  let detail: string;
  if (session.agent_status === "waiting") {
    family = "Background";
    title = "waiting on background work";
    detail = "the turn ended on an open task — the agent resumes when it finishes";
  } else if (session.agent_status === "dormant") {
    family = "Dormant";
    title = ts?.headline || "parked on a machine wake";
    detail = ts?.provenance ? `declared by the agent · ${ts.provenance}` : "declared by the agent";
  } else if (session.is_dormant) {
    family = "Parked";
    title = "parked by you";
    detail = "a machine wake resumes it; open it to un-park";
  } else {
    family = "Dormant";
    title = ts?.headline || "waiting on a machine wake";
    detail = ts?.provenance || "";
  }
  const ariaLabel = `${family} — why this session is parked`;
  return (
    <div className={`group/dormrow relative transition-colors ${isActive ? "bg-sol-cyan/[0.10]" : ""}`}>
      <button
        className="w-full text-left cursor-pointer pr-3 pl-2 py-1 hover:bg-sol-blue/[0.05] transition-colors"
        onClick={() => onOpen(session)}
        title="Open the session"
      >
        <div className="flex gap-1.5 min-w-0">
          <span className="flex items-center mt-[2px] shrink-0 text-sol-blue/70" role="img" aria-label={ariaLabel}>
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <title>{ariaLabel}</title>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 4v12h12" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M14 12l4 4-4 4" />
            </svg>
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5 min-w-0">
              <span className="text-[9px] font-semibold uppercase tracking-wider text-sol-blue/70 shrink-0">{family}</span>
              <span className="text-xs truncate min-w-0 text-gray-400 font-normal">{title}</span>
              <span className="ml-auto shrink-0 inline-flex items-center gap-1 justify-center min-w-[46px] px-1 py-0 rounded text-[9px] font-semibold border bg-sol-blue/10 text-sol-blue border-sol-blue/30">
                parked
              </span>
            </div>
            {detail && (
              <div className="flex items-baseline gap-1.5 mt-0.5 min-w-0">
                <span className="flex-1 min-w-0 truncate text-[11px] leading-snug font-mono text-sol-text-dim">{detail}</span>
              </div>
            )}
          </div>
        </div>
      </button>
    </div>
  );
}

// Every bar a card stacks beneath itself — triggers, a workflow run, live
// monitors / background commands, the dormant fallback — rendered behind ONE
// control (the footer ⚡ pill): "strip" folds them all to a single line,
// "full" gives each its own row, "hidden" removes them the way the subagent
// toggle hides subagent rows. The dormant invariant (a parked card explains
// its wake) holds in strip and full; "hidden" is an explicit opt-out and wins.
function CardBars({ session, mode, scheduleRows, activeSessionId, dormant, onOpen, onOpenSchedule }: {
  session: InboxSession;
  mode: CardBarsMode;
  scheduleRows: TriggerRow[];
  activeSessionId?: string | null;
  dormant?: boolean;
  onOpen: (session: InboxSession) => void;
  onOpenSchedule: (row: TriggerRow) => void;
}) {
  if (mode === "hidden") return null;
  const isActive = session._id === activeSessionId;
  const bound = scheduleRows.map((r) => ({ ...r, openId: session._id }));
  const dormantRow = dormant ? (
    <DormantReasonRow
      session={session}
      isActive={isActive}
      hasOtherRows={bound.length > 0 || workflowBarVisible(session)}
      onOpen={onOpen}
    />
  ) : null;
  if (mode === "strip") {
    return (
      <>
        <CardBarStrip session={session} rows={bound} activeSessionId={activeSessionId} onOpen={onOpenSchedule} onOpenSession={onOpen} />
        {dormantRow}
      </>
    );
  }
  return (
    <>
      {bound.map((r) => (
        <TriggerRowItem key={r.task._id} row={r} activeSessionId={activeSessionId} onOpen={onOpenSchedule} attached />
      ))}
      <WorkflowBar session={session} isActive={isActive} />
      <MonitorBars session={session} isActive={isActive} onOpen={onOpen} />
      {dormantRow}
    </>
  );
}

// The TRIGGERS section. Expanded: one TriggerRowItem per armed schedule.
// Collapsed: the header itself is the briefing — count, soonest next fire, and
// how many outcomes landed since the section was last toggled ("N new").
// -- The schedule dock --
// The schedules' home. The session list stays a list of ONE kind of thing
// (conversations); every armed schedule lives in this single always-visible
// line docked under the list. The line is the briefing: how many are armed,
// when the next fires, how many outcomes landed since you last looked, and a
// red accent when one failed or flagged itself. Expanding opens a roster
// overlay of full schedule rows (same anatomy as /schedules); CLOSING it marks
// the briefing read (schedules_seen_at) — while open, the per-row "new" pills
// stay visible so the count on the bar points at something.
function TriggerDock({ rows, unreadCount, nextRunAt, activeSessionId, onOpen }: {
  rows: TriggerRow[];
  unreadCount: number;
  nextRunAt?: number;
  activeSessionId?: string | null;
  onOpen: (row: TriggerRow) => void;
}) {
  const [open, setOpen] = useState(false);
  // Keyboard cursor into the roster: −1 = nothing selected (mouse mode).
  const [cursor, setCursor] = useState(-1);
  const now = useCoarseNow(30_000);
  // Mark the briefing read on CLOSE, not open: the per-row "new" pills are
  // derived from schedules_seen_at, so stamping on open erased them the moment
  // the roster appeared — you'd see "4 new" on the bar and nothing marked
  // inside. While open, the pills stay; every exit path funnels through here.
  const close = useCallback(() => {
    useInboxStore.getState().updateClientUI({ schedules_seen_at: Date.now() });
    setOpen(false);
  }, []);
  // The roster is a popup, and popups owe the keyboard everything the mouse
  // gets: Esc exits, arrows move a cursor, Enter opens the selected schedule.
  // Arrow keys only bind once the roster is open, so global shortcuts and the
  // session list's own nav never contend with it.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        close();
        return;
      }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setCursor((c) => {
          const next = e.key === "ArrowDown" ? Math.min(c + 1, rows.length - 1) : Math.max(c - 1, 0);
          const id = rows[next]?.task._id;
          if (id) {
            document.querySelector(`[data-schedrow="${id}"]`)?.scrollIntoView({ block: "nearest" });
          }
          return next;
        });
        return;
      }
      if (e.key === "Enter") {
        const target = rows[cursor];
        if (target) {
          e.preventDefault();
          close();
          onOpen(target);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, rows, cursor, onOpen, close]);
  // A closed roster has no cursor — reopening starts fresh in mouse mode.
  useEffect(() => {
    if (!open) setCursor(-1);
  }, [open]);
  if (rows.length === 0) return null;
  // Real triggers keep the recurring/one-time split; loops get their own word
  // — calling a self-pacing loop "recurring" would be a lie about what the
  // user can edit.
  const realRows = rows.filter((r) => !r.kind);
  const loopCount = rows.filter((r) => r.kind === "loop").length;
  const recurringCount = realRows.filter((r) => r.task.schedule_type !== "once").length;
  const oneTimeCount = realRows.length - recurringCount;
  const overdueCount = rows.filter((r) => !r.kind && isTaskOverdue(r.task, now)).length;
  const runningCount = rows.filter((r) => r.task.status === "running").length;
  // Project chips only when the roster actually mixes projects — a
  // single-project roster doesn't need every row stamped with the same name.
  const projects = new Set(rows.map((r) => r.task.project_path).filter(Boolean));
  const chipFor = (p?: string) => (projects.size > 1 && p ? p.split("/").filter(Boolean).pop() : undefined);
  const nextIn = nextRunAt !== undefined ? Math.max(0, nextRunAt - now) : undefined;
  // Name WHAT fires next, not just when — "next in 1h" says nothing. Running
  // state lives in its own pill, so this slot is purely the next fire.
  const nextTask = rows.find((r) => r.task.status === "scheduled" && r.task.run_at === nextRunAt)?.task;
  const attention = rows.some((r) => r.task.last_run_failed || r.task.last_run_needs_attention);
  const toggle = () => (open ? close() : setOpen(true));
  return (
    <div className="relative shrink-0 border-t border-sol-border/40">
      {open && (
        <>
          {/* Click-away backdrop: anywhere outside the roster closes it. */}
          <div className="fixed inset-0 z-10" onClick={close} aria-hidden />
          <div className="animate-sched-roster-in absolute bottom-full left-0 right-0 max-h-[55vh] overflow-y-auto bg-sol-bg border-t border-sol-border/60 shadow-[0_-8px_24px_rgba(0,0,0,0.18)] z-20">
            {/* Roster header: what this popup holds and the two exits — the
                full page, and creating a new schedule without hunting for it.
                Solid alt band (not the row background) so the popup's edge
                reads against the session list it floats over. */}
            <div className="sticky top-0 z-10 flex items-center gap-2 px-3 py-1.5 bg-sol-bg-alt/95 backdrop-blur-sm border-b border-sol-border/60 text-[10px]">
              <span className="font-medium text-sol-text-muted">
                {rows.length} armed
                {recurringCount > 0 ? ` · ${recurringCount} recurring` : ""}
                {oneTimeCount > 0 ? ` · ${oneTimeCount} one-time` : ""}
                {loopCount > 0 ? ` · ${loopCount} loop${loopCount === 1 ? "" : "s"}` : ""}
              </span>
              <span className="ml-auto flex items-center gap-2.5">
                <Link href="/triggers?new=1" onClick={close} className="text-sol-cyan hover:underline">+ New</Link>
                <Link href="/triggers" onClick={close} className="text-sol-cyan hover:underline">Manage</Link>
              </span>
            </div>
            {rows.map((r, i) => (
              <TriggerRowItem
                key={r.task._id}
                row={r}
                activeSessionId={activeSessionId}
                onOpen={(r) => { close(); onOpen(r); }}
                onNavigated={close}
                highlighted={i === cursor}
                projectChip={chipFor(r.task.project_path)}
              />
            ))}
          </div>
        </>
      )}
      <button
        onClick={toggle}
        aria-expanded={open}
        aria-haspopup="true"
        aria-label={`Triggers: ${rows.length} armed`}
        className="w-full flex items-center gap-1.5 px-3 py-1.5 bg-sol-bg hover:bg-sol-bg-alt/60 transition-colors"
      >
        <svg className={`w-3 h-3 shrink-0 ${attention ? "text-sol-red" : "text-sol-amber"}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7.5V12l3 2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span className="shrink-0 whitespace-nowrap text-[10px] font-semibold uppercase tracking-wider text-sol-amber">
          Triggers <span className="text-sol-amber/60 tabular-nums">{rows.length}</span>
        </span>
        {nextIn !== undefined && (
          <span className="text-[10px] text-sol-text-dim truncate min-w-0">
            · next{nextTask ? <> <span className="text-sol-text-muted">{taskDisplayTitle(nextTask)}</span></> : null}{" "}
            <span className="tabular-nums">{nextIn > 0 ? `in ${fmtDuration(nextIn)}` : "due"}</span>
          </span>
        )}
        {unreadCount > 0 && (
          <ShortcutTooltip label={`${unreadCount} outcome${unreadCount === 1 ? "" : "s"} landed since you last opened this list`} hint="marked inside">
            <span className="shrink-0 inline-flex items-center whitespace-nowrap px-1.5 py-0 rounded-full text-[9px] font-semibold bg-sol-amber/15 text-sol-amber border border-sol-amber/30">
              {unreadCount} new
            </span>
          </ShortcutTooltip>
        )}
        {runningCount > 0 && (
          <span className="shrink-0 inline-flex items-center whitespace-nowrap gap-1 px-1.5 py-0 rounded-full text-[9px] font-semibold bg-sol-green/10 text-sol-green border border-sol-green/30">
            <span className="w-1 h-1 rounded-full bg-sol-green animate-pulse motion-reduce:animate-none" />
            {runningCount} running
          </span>
        )}
        {overdueCount > 0 && (
          <ShortcutTooltip label="Due but unclaimed for over 2 minutes — is the daemon for that machine running?">
            <span className="shrink-0 inline-flex items-center whitespace-nowrap px-1.5 py-0 rounded-full text-[9px] font-semibold bg-sol-red/15 text-sol-red border border-sol-red/30">
              {overdueCount} overdue
            </span>
          </ShortcutTooltip>
        )}
        {attention && (
          <span className="shrink-0 inline-flex items-center whitespace-nowrap gap-1 px-1.5 py-0 rounded-full text-[9px] font-semibold bg-sol-red/15 text-sol-red border border-sol-red/30">
            <span className="w-1 h-1 rounded-full bg-sol-red" />
            needs attention
          </span>
        )}
        <svg className={`ml-auto shrink-0 w-3 h-3 transition-transform duration-200 ease-[cubic-bezier(0.23,1,0.32,1)] text-sol-text-dim ${open ? "rotate-180" : ""}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
        </svg>
      </button>
    </div>
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
  onStash,
  onDefer,
  onPin,
  onRestore,
  onKill,
  onNavigateToSession,
  onCardContextMenu,
  variant = "default",
  forkColorKey,
  sessionLabel,
  isFavorite,
  subRow,
}: {
  session: InboxSession;
  isActive: boolean;
  isParentActive?: boolean;
  globalIndex: number;
  onSelect: (session: InboxSession) => void;
  onDismiss?: (id: string) => void;
  onStash?: (id: string) => void;
  onDefer?: (id: string) => void;
  onPin?: (id: string) => void;
  onRestore?: (id: string) => void;
  onKill?: (id: string) => void;
  onNavigateToSession?: (id: string) => void;
  /** Right-click: the panel owns ONE cursor-anchored menu for all cards. */
  onCardContextMenu?: (e: React.MouseEvent, session: InboxSession, isForeign: boolean) => void;
  variant?: "default" | "working" | "dismissed" | "stashed";
  forkColorKey?: string;
  // Force the compact child-row look for a session that isn't itself a
  // subagent — the trigger view renders a trigger's sessions as sub rows under
  // the trigger's own row. The ↳ arrow goes schedule-amber there (child of a
  // trigger, not of a parent session).
  subRow?: "trigger";
  // Label + favorite state are derived ONCE in the parent (SessionListPanel) and
  // passed as scalar props, so a card does O(1) work per render instead of the two
  // selectors scanning the whole bucketAssignments / favorites collection on every
  // store heartbeat notification (the selector runs per notification, not per render).
  sessionLabel: string | null;
  isFavorite: boolean;
}) {
  const tipActions = useTipActions();
  // The card's idle duration ("idle 3m") and trust-stale pulse read Date.now() at
  // render. Now that the panel no longer re-renders every heartbeat (it wakes on a
  // structural signature), subscribe to a shared 30s clock so those stay fresh on
  // their own cadence instead of riding data churn. One timer total for all cards
  // (see useCoarseNow); 30s granularity is plenty for a minutes-scale idle counter.
  // The amber blocked chip's revive stamp — read before the clock below so its
  // TTL participates in the clock's re-render signature.
  const reviveRequestedAtEarly = useInboxStore((st) => st.blockedReviveRequestedAt[session._id]);
  const reviveRequestedAtRef = useRef(reviveRequestedAtEarly);
  reviveRequestedAtRef.current = reviveRequestedAtEarly;
  // Threshold clock, not a raw tick: every card on screen shares the 30s
  // clock, so a plain useCoarseNow re-rendered the WHOLE list once per tick
  // forever. Project the clock onto what this card actually draws from time —
  // the idle-age label, liveness staleness, the blocked-badge TTL, and the
  // pinned-state age line — and re-render only when one of those flips.
  const coarseNow = useNowWhen(
    (t) =>
      `${formatIdleDuration(session.updated_at)}|${isLivenessStale(session, t) ? 1 : 0}|` +
      `${showsBlockedBadge(session.pending_api_error, false, reviveRequestedAtRef.current, t) ? 1 : 0}|` +
      `${threadStateView(session, session.message_count, t)?.cardLine ?? ""}`,
    30_000,
  );
  const project = getProjectName(session.git_root, session.project_path);
  const isWorking = variant === "working";
  const isStashed = variant === "stashed";
  // Stashed cards share the dismissed bucket's muted look — but NOT its
  // liveness suppression (a stashed agent is still running; see the idle-dot
  // gate below, which stays keyed on the real dismissed variant).
  const isDismissed = variant === "dismissed" || isStashed;
  // Compact sub-row look: Task subagents and agent-team teammates (via
  // nestParentIdOf) plus worktree workers. Teammates render this way even when
  // floating top-level (lead absent) — same as worktree rows, the ↳ arrow
  // carries the "child of something" reading on its own.
  const isSubagent = !!subRow || !!session.is_subagent || !!nestParentIdOf(session) || !!session.worktree_name;
  // Local-first "pending working": a message has been sent but the daemon
  // hasn't confirmed delivery yet (status not active). Reading the durable
  // pendingMessages map directly returns a stable boolean, so only this card
  // re-renders when its own pending state flips — not the whole list. Clears
  // the moment status goes active or the server echoes the message.
  const isPendingSend = useInboxStore((st) => convHasPendingSend(st.pendingMessages[session._id]));
  const isPendingWorking = isPendingSend && !isAgentActive(session);
  // The amber blocked chip drops the instant the user acts on the session —
  // see showsBlockedBadge. Scalar per-card selector, so only this card
  // re-renders when its own revive stamp lands; coarseNow keeps the stamp's TTL
  // live so an expired one brings the chip back on its own.
  const reviveRequestedAt = reviveRequestedAtEarly;
  const showBlockedBadge = showsBlockedBadge(
    session.pending_api_error,
    isPendingSend,
    reviveRequestedAt,
    coarseNow,
  );
  // Kill+restart in flight for this session (written by useSessionRestart).
  // Scalar per-card selector, so only this card re-renders when its own restart
  // begins/ends.
  const restartStartedAt = useInboxStore((st) => st.restartingSessions[session._id]);
  const showModelBadge = useInboxStore((st) => st.clientState?.ui?.show_model_badge === true);
  const showAgentIcon = useInboxStore((st) => st.clientState?.ui?.show_agent_icon !== false);
  // Row thumbnail for sessions that contain images (server-denormalized
  // image_preview_url). Independent of simple view — applies in both.
  // Clicking it zooms the image (ImageLightbox), not the session. It lives on
  // the RIGHT edge — a left thumb pushes the title column off the list's
  // shared text edge. The hover controls keep their right-edge anchor; the
  // THUMB slides left on row hover instead, far enough to clear whichever
  // control set this variant renders, so both stay visible and clickable.
  const showImageThumb = useInboxStore((st) => st.clientState?.ui?.inbox_image_thumbs === true);
  const [thumbZoom, setThumbZoom] = useState(false);
  // A preview URL whose image fails to load must drop the whole thumb slot —
  // an invisible broken img still reserves ~46px and wraps the text early.
  const [thumbBroken, setThumbBroken] = useState(false);
  useEffect(() => setThumbBroken(false), [session.image_preview_url]);
  // Cache-first bytes: a thumbnail seen once paints locally (and offline)
  // instead of re-fetching per scroll-through of the inbox.
  const thumbSrc = imageBytes.useSrc(showImageThumb ? session.image_preview_url : undefined);
  const hasThumb = showImageThumb && !!thumbSrc && !thumbBroken;
  // sessionLabel and isFavorite are now passed as scalar props (computed once in
  // the parent via labelByConv/cardIsFavorite) instead of per-card store scans —
  // see ct-37958. Only spawnedByTitle stays a local selector.
  //
  // Visible-child parent link (agent-team teammate → its lead). Selector
  // returns the parent's title string, so this card re-renders only when that
  // title changes — never on parent-row churn.
  const spawnedById = session.spawned_by_conversation_id || null;
  const spawnedByTitle = useInboxStore((st) =>
    spawnedById
      ? ((st.sessions[spawnedById]?.title || (st.conversations[spawnedById] as any)?.title) ?? null)
      : null,
  );
  const displayTitle = cleanTitle(session.title || "New Session");
  const isSlashCommand = displayTitle.startsWith("/");
  const cleanedUserMsg = cleanUserMessage(session.last_user_message);
  // A kept compose draft (see ComposeView) is a blank session the user chose to
  // save. Preview its unsent text instead of the pre-warm "Waiting for
  // connection" line — the draft IS the card's content.
  const draftPreview = useInboxStore((st) => (
    session._hasDraft ? (st.drafts[session._id]?.draft_message as string | undefined) ?? "" : ""
  ));
  const cardSummary = sessionCardSummary(session);
  // The agent's pinned thread state, when it wrote one. It REPLACES the
  // generated summary on the card rather than stacking with it: one is what the
  // agent says is true right now, the other is a description of the session, and
  // two summary lines on a card is one too many. Ages on the coarse clock, so a
  // state the thread has run past reads dim instead of confident.
  const stateView = threadStateView(session, session.message_count, coarseNow);
  // "Working" = the agent is actively running right now (mirrors
  // sessionLivenessState's "active"). The green pulse keys off this ACTUAL state
  // rather than the section the card lives in, so pinned and flat-view cards —
  // which always render with the "default" variant — still distinguish working
  // from idle instead of showing nothing for a busy pinned session.
  // Distrust a frozen live status the same way the bucket does: a row that aged
  // out of the liveness overlay keeps its last is_idle:false forever, so without
  // this an agent that finished 15 days ago still pulses green while sitting in
  // needs-input. Past the trust TTL (keyed on updated_at, which a real working
  // agent bumps far more often) the pulse goes dark — the dot and the bucket now
  // read the SAME staleness check, so they can't disagree.
  const isLive = !session.is_idle && session.message_count > 0 && !isLivenessStale(session, Date.now());
  // Age-gated because a restart navigated away from has no owner left to clear
  // its entry; liveness-gated so the green dot takes over the moment the
  // session is actually back. The coarse clock above keeps the age fresh.
  const isRowRestarting =
    !!restartStartedAt && Date.now() - restartStartedAt < RESTART_GIVE_UP_AFTER_MS && !isLive;

  // Author of THIS session — shown only when it isn't the current user's own. The
  // inbox cache is user-scoped, so a teammate's session is here only because it was
  // opened (deep-link / search / palette). The conversation meta (written on every
  // view: is_own + user) covers rows cached before injection carried author fields;
  // the roster keys display off user_id so a teammate rename/avatar shows instantly.
  // Only the viewer's id is read here (author resolution + foreign check), so
  // subscribe to that string, not the whole user doc — the doc's identity
  // churns on daemon heartbeat fields and would re-render every card.
  const meId = useInboxStore((s) => s.currentUser?._id?.toString?.() ?? null);
  const currentUser = useMemo(() => (meId ? ({ _id: meId } as any) : null), [meId]);
  const teamMembers = useTeamRosterIdentity();
  // Same for the conversation row: only the authorship fields matter, and the
  // whole row's identity flips on every liveness tick.
  const convMetaSig = useInboxStore((s) => {
    const c = s.conversations[session._id] as any;
    if (!c) return null;
    return `${c.user_id ?? ""}\u0000${c.is_own === undefined ? "" : c.is_own ? "1" : "0"}\u0000${c.acting_user_id ?? ""}\u0000${c.user?.name ?? ""}\u0000${c.user?.email ?? ""}\u0000${c.user?.avatar_url ?? ""}`;
  });
  const convMeta = useMemo(() => {
    if (convMetaSig === null) return null;
    const [user_id, is_own, acting_user_id, name, email, avatar_url] = convMetaSig.split("\u0000");
    return {
      user_id: user_id || undefined,
      is_own: is_own === "" ? undefined : is_own === "1",
      acting_user_id: acting_user_id || null,
      user: name || email || avatar_url ? { name: name || null, email: email || null, avatar_url: avatar_url || null } : null,
    };
  }, [convMetaSig]);
  const author = useMemo(
    () => resolveSessionAuthor(session, convMeta, currentUser, teamMembers),
    [session.user_id, session.author_name, session.author_avatar, session.acting_user_id, convMeta, currentUser, teamMembers],
  );
  // An anchor's own row is marked as such — the glyph in place of the agent
  // icon, and the scope pill (Personal / team name) beside the title — so a
  // standing member never reads as just another session.
  const anchorIdentity = useAnchorIdentity(session.is_anchor ? (session.anchor_id ?? null) : null);
  // A teammate's session (surfaced by team mode) is READ-ONLY here: dismiss /
  // stash / pin / kill all mutate GLOBAL conversation fields, so acting on a
  // foreign card would hide or tear down the session in the owner's inbox too.
  // Steering rights (owner) or your own authorship keep it triageable. Clicking
  // through to open/read the session is always allowed (team-visible).
  const isForeignSession = useMemo(() => {
    const meId = currentUser?._id?.toString?.();
    if (!meId || !session.user_id) return false;
    if (session.user_id === meId) return false;
    if (session.owned_by_me) return false;
    if (session.owner_user_id && session.owner_user_id === meId) return false;
    return true;
  }, [currentUser, session.user_id, session.owned_by_me, session.owner_user_id]);
  // On row hover the toolbar's gradient rises OVER the thumb (the thumb has
  // no z, the toolbar paints above but lets clicks through everywhere except
  // its buttons) while the thumb eases a few px left — ending half hidden
  // under the gradient and buttons, still clickable on its exposed half.
  // Stashed/killed rows don't animate at all: their restore cluster sits at
  // the title line, stacked above the thumb, and both stay clickable as-is.
  const thumbHoverShift =
    !isForeignSession && !(onRestore || onKill) && (onDismiss || onStash || onDefer || onPin)
      ? "group-hover:-translate-x-[14px]"
      : "";
  const [isDragOver, setIsDragOver] = useState(false);
  // Handoff note starts clamped; tapping the pill body reveals the full reason.
  const [pingExpanded, setPingExpanded] = useState(false);
  const dragCounter = useRef(0);
  const generateUploadUrl = useMutation(api.images.generateUploadUrl);
  const sendMessage = useMutation(api.pendingMessages.sendMessageToSession);
  const ackAssignment = useAckAssignment();

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
        const uploaded = await compressImage(file);
        const uploadUrl = await generateUploadUrl({});
        const result = await fetch(uploadUrl, { method: "POST", headers: { "Content-Type": uploaded.type }, body: uploaded });
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
    // The same drag is also a pane: dropped on the stage it splits in as this
    // conversation (lib/stage). The label drop keeps reading its own type.
    startPaneDrag(e, { path: sessionPanePath(session._id), title: displayTitle });
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
        onContextMenu={onCardContextMenu ? (e) => onCardContextMenu(e, session, isForeignSession) : undefined}
        className={`relative group transition-all overflow-hidden ${isDraggingCard ? "opacity-35 scale-[0.99]" : ""} ${isDragOver ? "ring-1 ring-inset ring-violet-400/40 bg-violet-500/10" : ""} ${
          isActive
            ? "bg-violet-500/[0.08] border-l-2 border-l-violet-400/60"
            : isParentActive
              ? "bg-sol-cyan/[0.10] border-l border-l-sol-cyan/40"
              : isWorking
                ? "hover:bg-violet-500/[0.06] border-l border-l-violet-400/25"
                : isStashed
                  ? "opacity-45 hover:opacity-65 hover:bg-violet-500/[0.04]"
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
            {/* Corner arrow (↳) — marks this row as a child of its parent
                session. The faint violet left-border alone reads as "indented"
                only when the parent is directly above; this makes the
                sub-of-parent relationship explicit even for a subagent floating
                as its own top-level row (flat view, or parent off-screen). */}
            <svg className={`w-3 h-3 flex-shrink-0 ${subRow ? "text-sol-amber/60" : "text-violet-400/60"}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5} role="img" aria-label={subRow ? "Trigger session" : "Subagent"}>
              <title>{subRow ? "Session driven by the trigger above" : "Subagent — child of its parent session"}</title>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 4v12h12" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M14 12l4 4-4 4" />
            </svg>
            {showAgentIcon && (
              <span className="flex-shrink-0 flex items-center opacity-70" title={formatAgentType(session.agent_type || "claude_code")}>
                <AgentTypeIcon agentType={session.agent_type || "claude_code"} className="w-3 h-3" />
              </span>
            )}
            <span className={`truncate text-xs leading-tight flex-1 ${
              isActive ? "text-violet-300 font-medium" : "text-gray-400 font-normal"
            }`}>
              {isSlashCommand ? <span className="font-mono text-violet-400/80">{displayTitle}</span> : displayTitle}
            </span>
            <div className="flex items-center gap-1 flex-shrink-0">
              {showBlockedBadge && <AuthErrorBadge kind={session.pending_api_error_kind} agentType={session.agent_type} />}
              {session.session_error && (
                <span className="w-1.5 h-1.5 rounded-full bg-sol-red" title={session.session_error} />
              )}
              {session.is_unresponsive && !session.session_error && (
                <span className="w-1.5 h-1.5 rounded-full bg-sol-orange" title="Session unresponsive" />
              )}
              {session.has_pending && !session.is_unresponsive && (
                <span className="w-1.5 h-1.5 rounded-full bg-sol-yellow animate-pulse" title="Message pending" />
              )}
              {/* Reuse the staleness-aware isLive so an aged-out subagent row
                  stops pulsing green, matching the main card and the bucket. */}
              {isLive && !showBlockedBadge && !session.session_error && !session.is_unresponsive && !session.has_pending && (
                <span className="relative flex h-1.5 w-1.5" title="Live">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-sol-green opacity-75" />
                  <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-sol-green" />
                </span>
              )}
              {!isLive && !showBlockedBadge && !session.session_error && !session.is_unresponsive && !session.has_pending && session.message_count > 0 && (
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
          {stateView && (
            <div className="mt-0.5 flex items-start gap-1" title={stateView.text}>
              <Pin
                className={`w-2 h-2 mt-[3px] shrink-0 ${stateView.status ? THREAD_STATE_STATUS_META[stateView.status].dot : THREAD_STATE_PIN_CLASS[stateView.freshness]}`}
                strokeWidth={2.4}
              />
              <span className="text-[10px] text-sol-text-secondary truncate leading-snug">
                {stateView.cardLine}
              </span>
            </div>
          )}
          {cleanedUserMsg && (
            <div className="text-[10px] text-gray-500 mt-0.5 truncate leading-snug">
              <span className="text-gray-600 mr-0.5">&gt;</span>
              {cleanedUserMsg}
            </div>
          )}
          {session.active_task && (
            <div className="flex items-center gap-1 mt-0.5">
              <span className="inline-block align-middle px-1 py-0 rounded text-[9px] font-medium bg-violet-900/20 text-violet-400/70 border border-violet-600/20 max-w-[160px] truncate" title={session.active_task.title}>
                {session.active_task.title}
              </span>
            </div>
          )}
        </div>
        {!isForeignSession && (onDismiss || onDefer || onPin) && (
          <div data-sv-fade className={`absolute top-0 bottom-0 right-0 flex items-center py-1 opacity-0 group-hover:opacity-100 transition-opacity pl-8 pr-2 bg-gradient-to-r from-transparent to-sol-bg-alt`}>
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
        {!isForeignSession && (onRestore || onKill) && (
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
      onContextMenu={onCardContextMenu ? (e) => onCardContextMenu(e, session, isForeignSession) : undefined}
      className={`relative group transition-all overflow-hidden ${isDraggingCard ? "opacity-35 scale-[0.99]" : ""} ${isDragOver ? "ring-1 ring-inset ring-sol-cyan bg-sol-cyan/10" : ""} ${
        // Violet, not cyan: cyan ring+tint is the ACTIVE row's treatment, and an
        // unacked handoff must never read as "this is the session you have open".
        session.assigned_ping ? "ring-1 ring-inset ring-sol-violet/50 bg-sol-violet/[0.06]" : ""
      } ${
        isActive
          ? "bg-sol-cyan/[0.12] border-l-[3px] border-l-sol-cyan ring-1 ring-inset ring-sol-cyan/45 shadow-[0_1px_10px_-2px_rgba(42,161,152,0.35)]"
          : isWorking
            ? "bg-sol-green/[0.04] border-l-2 border-l-sol-green/40 hover:bg-sol-green/[0.08]"
            : isStashed
              ? "opacity-65 hover:opacity-85 hover:bg-sol-bg-alt/80"
              : isDismissed
                ? "opacity-60 hover:opacity-80 hover:bg-sol-bg-alt/80"
                // The agent's declared status tints the resting row: amber for
                // "needs input", teal for "complete". Liveness outranks it —
                // a running agent isn't blocked-on-you right now. (A stale
                // state has no view at all, so it can't tint anything.)
                : stateView?.status && stateView.status !== "working" && !session.implementation_session
                  ? `${THREAD_STATE_STATUS_META[stateView.status].row} hover:bg-sol-bg-alt/80`
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
      <div className="flex items-center gap-2.5">
      <div className="min-w-0 flex-1">
        <div className={`flex items-center gap-1.5 leading-tight ${
          isActive ? "text-sm text-sol-text font-semibold" : isWorking ? "text-sm text-sol-text font-medium" : isStashed ? "text-sm text-sol-text-muted" : isDismissed ? "text-sm text-sol-text-muted" : "text-sm text-sol-text"
        }`}>
          {session.is_anchor ? (
            <span className="flex-shrink-0 flex items-center text-sol-cyan" title="Anchor — a standing agent member">
              <AnchorGlyph className="w-3.5 h-3.5" />
            </span>
          ) : showAgentIcon && (
            <span className="flex-shrink-0 flex items-center" title={formatAgentType(session.agent_type || "claude_code")}>
              <AgentTypeIcon agentType={session.agent_type || "claude_code"} className="w-3.5 h-3.5" />
            </span>
          )}
          <span className="truncate min-w-0">{isSlashCommand ? <span className="font-mono text-sol-cyan">{displayTitle}</span> : displayTitle}</span>
          {session.is_anchor && anchorIdentity && <AnchorScopePill anchor={anchorIdentity} className="flex-shrink-0" />}
          {/* Favorite affordance — AFTER the title so it never shifts the name.
              Solid (soft amber) when favorited; otherwise a very subdued star that
              only surfaces on row-hover and lights up on direct hover. Toggle also
              via the keyboard shortcut. */}
          <ShortcutTooltip label={isFavorite ? "Unfavorite" : "Favorite"} action="conv.favorite">
            <button
              onClick={(e) => { e.stopPropagation(); useInboxStore.getState().toggleFavorite(session._id); }}
              className={`flex-shrink-0 transition-all ${
                isFavorite
                  ? "text-amber-400/85 hover:text-amber-300"
                  : "text-sol-text-dim/30 opacity-0 group-hover:opacity-50 hover:!opacity-100 hover:!text-amber-400"
              }`}
              aria-label={isFavorite ? "Unfavorite" : "Favorite"}
            >
              <Star className="w-3 h-3" fill={isFavorite ? "currentColor" : "none"} />
            </button>
          </ShortcutTooltip>
        </div>
        {session.assigned_ping && (
          /* mr-5 keeps the strip — and its "Got it" button — clear of the
             hover toolbar's column on the right, whose gradient would
             otherwise wash over the button. */
          <div className="flex items-start gap-1.5 mt-1 mr-5 px-1.5 py-1 rounded-md bg-sol-violet/15 border border-sol-violet/30">
            <UserCheck className="w-3 h-3 text-sol-violet flex-shrink-0 mt-0.5" />
            {/* The note is the REASON for the handoff — clamped for the list,
                tap the body to read all of it without opening the session. */}
            <div
              className={`min-w-0 flex-1 text-[11px] leading-snug ${session.assigned_ping.note ? "cursor-pointer" : ""}`}
              onClick={session.assigned_ping.note ? (e) => { e.stopPropagation(); setPingExpanded((v) => !v); } : undefined}
            >
              <span className="font-semibold text-sol-violet">
                {session.assigned_ping.by_name} assigned this to you
              </span>
              <span className="text-sol-text-dim whitespace-nowrap" title={formatDateFull(session.assigned_ping.at)}>
                {" · "}{formatRelative(session.assigned_ping.at, coarseNow)}
              </span>
              {session.assigned_ping.note && (
                <div className={`text-sol-text-muted whitespace-pre-wrap break-words ${pingExpanded ? "" : "line-clamp-2"}`}>
                  “{session.assigned_ping.note}”
                </div>
              )}
            </div>
            {/* Accept right here — the handoff shouldn't require opening the
                conversation and finding the banner to retire. */}
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); ackAssignment(session._id); }}
              className="flex-shrink-0 px-1.5 py-0.5 rounded text-[10px] font-medium bg-sol-violet/20 text-sol-violet border border-sol-violet/40 hover:bg-sol-violet/30 transition-colors"
            >
              Got it
            </button>
          </div>
        )}
        {stateView && !session.implementation_session && (
          <div className="mt-0.5 flex items-start gap-1" title={stateView.text}>
            <Pin
              className={`w-2.5 h-2.5 mt-[3px] shrink-0 ${stateView.status ? THREAD_STATE_STATUS_META[stateView.status].dot : THREAD_STATE_PIN_CLASS[stateView.freshness]}`}
              strokeWidth={2.4}
            />
            {/* Blocked and done earn a loud chip — those are the states the
                human must act on or can stop thinking about. Working stays
                quiet: the liveness pulse already says "running". */}
            {stateView.status && stateView.status !== "working" && (
              <span
                className={`shrink-0 mt-[1px] px-1 py-0 rounded border text-[9px] font-semibold uppercase tracking-wide ${THREAD_STATE_STATUS_META[stateView.status].chip}`}
              >
                {THREAD_STATE_STATUS_META[stateView.status].label}
              </span>
            )}
            <span className="text-[11px] truncate leading-snug text-sol-text-secondary">
              {stateView.cardLine}
            </span>
          </div>
        )}
        {cardSummary && !stateView && !session.implementation_session && (
          <div className="text-[11px] text-sol-text-muted mt-0.5 line-clamp-2 leading-snug whitespace-pre-line">
            <FormattedSummary text={cardSummary} />
          </div>
        )}
        {/* The user's park gesture has no declaration or wake row of its own to
            explain it, so the card says what will happen: the next wake — any
            message, trigger, or turn — brings the row back on its own. */}
        {session.is_dormant && !isDismissed && (
          <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-sol-blue/70">
            <span className="w-1.5 h-1.5 rounded-full bg-sol-blue/60" />
            <span>Parked — returns on the next wake</span>
          </div>
        )}
        {cleanedUserMsg && (
          <div className="text-[11px] text-sky-700 dark:text-sky-300 mt-0.5 truncate leading-snug font-semibold">
            <span className="text-sky-600/60 dark:text-sky-400/50 mr-0.5">&gt;</span>
            {cleanedUserMsg}
          </div>
        )}
        {session._hasDraft && (
          <div className="mt-0.5 flex items-start gap-1.5">
            <span className="shrink-0 mt-[1px] px-1 py-[1px] rounded text-[9px] font-medium uppercase tracking-wide bg-sol-yellow/15 text-sol-yellow border border-sol-yellow/30">
              Draft
            </span>
            {draftPreview && (
              <span className="text-[11px] text-sol-text-dim truncate leading-snug">{draftPreview}</span>
            )}
          </div>
        )}
        {session.message_count === 0 && !session.last_user_message && !session._hasDraft && (() => {
          // Mirror the composer's "Starting… → Ready" lifecycle (see sessionLifecycle).
          // A blank session often has no daemon heartbeat until its first message, so
          // we trust elapsed time as the fallback rather than spin forever.
          const startup = sessionStartupState({
            isConnected: session.is_connected,
            ageMs: Date.now() - (session.started_at || session.updated_at),
          });
          if (startup === "ready") {
            return (
              <div className="flex items-center gap-1.5 mt-0.5 text-[11px] text-sol-green/70">
                <span className="w-1.5 h-1.5 rounded-full bg-sol-green/70" />
                <span>Ready</span>
              </div>
            );
          }
          if (startup === "starting") {
            return (
              <div className="flex items-center gap-1.5 mt-0.5 text-[11px] text-sol-cyan/60">
                <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                <span>Starting...</span>
              </div>
            );
          }
          return (
            <div className="text-[11px] text-sol-text-dim/60 mt-0.5">
              Waiting for connection
            </div>
          );
        })()}
        <div className="flex items-center gap-1.5 mt-1">
          {author && (
            <span className="flex items-center gap-1 flex-shrink-0 max-w-[130px]" title={`${author.name}'s session`}>
              <AvatarImg
                src={author.avatar}
                alt={author.name}
                className="w-3.5 h-3.5 rounded-full object-cover"
                fallback={
                  <span className="w-3.5 h-3.5 rounded-full bg-sol-violet/20 text-sol-violet flex items-center justify-center text-[8px] font-semibold leading-none">
                    {author.name.charAt(0).toUpperCase()}
                  </span>
                }
              />
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
            <span data-simple-hide className="text-[9px] text-sol-cyan font-mono truncate max-w-[80px]" title={session.worktree_branch || session.worktree_name}>
              {session.worktree_name}
            </span>
          )}
          {showModelBadge && session.model && (
            <span data-simple-hide className="text-[9px] text-sol-text-dim/70 font-mono truncate max-w-[90px] flex-shrink-0" title={session.model}>
              {formatModel(session.model)}
            </span>
          )}
          {session.message_count > 0 && (
            <span data-simple-hide className={`text-[10px] tabular-nums flex-shrink-0 ${msgCountColor(session.message_count)}`}>
              {session.message_count} msg{session.message_count !== 1 ? "s" : ""}
            </span>
          )}
          <div className="flex items-center gap-1.5 flex-shrink-0 ml-auto">
            {isFork(session) && (
              <span data-simple-hide className="inline-flex items-center gap-0.5 px-1 py-0 rounded text-[9px] font-medium bg-sol-cyan/10 text-sol-cyan border border-sol-cyan/20" title="Fork">
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
              <span data-simple-hide className="inline-block align-middle px-1 py-0 rounded text-[9px] font-medium bg-sol-cyan/10 text-sol-cyan border border-sol-cyan/20 max-w-[120px] truncate" title={session.active_plan.title}>
                {session.active_plan.title}
              </span>
            )}
            {session.active_task && (
              <span data-simple-hide className="inline-block align-middle px-1 py-0 rounded text-[9px] font-medium bg-sol-violet/10 text-sol-violet border border-sol-violet/20 max-w-[140px] truncate" title={session.active_task.title}>
                {session.active_task.title}
              </span>
            )}
            {session.is_workflow_primary && session.workflow_run_status === "paused" && (
              <span className="inline-flex items-center gap-0.5 px-1 py-0 rounded text-[9px] font-semibold bg-sol-magenta/10 text-sol-magenta border border-sol-magenta/30">
                <span className="w-1 h-1 rounded-full bg-sol-magenta animate-pulse" />
                Gate
              </span>
            )}
            {/* A running workflow renders as its own ↳ WorkflowBar under the
                card (same family as schedule/monitor bars) — no chip here. */}
            {(session.open_comment_threads ?? 0) > 0 && (() => {
              // Loud only when the ball is in the viewer's court: someone ELSE
              // (teammate or agent) spoke last in an open thread. When the
              // viewer commented last they're waiting, not being waited on —
              // the chip stays but drops to the dim treatment.
              const waitingOnViewer = !!session.last_comment_author_id
                && session.last_comment_author_id !== meId;
              const who = session.last_comment_author;
              return (
                <button
                  type="button"
                  className={`inline-flex items-center gap-0.5 px-1 py-0 rounded text-[9px] font-semibold border transition-colors max-w-[9rem] ${
                    waitingOnViewer
                      ? "bg-sol-cyan/10 text-sol-cyan border-sol-cyan/30 hover:bg-sol-cyan/20"
                      : "bg-sol-bg-alt/60 text-sol-text-dim border-sol-border/40 hover:bg-sol-bg-alt"
                  }`}
                  title={`${session.open_comment_threads} open comment thread${session.open_comment_threads === 1 ? "" : "s"}${
                    who && session.last_comment_excerpt ? ` — ${who}: ${session.last_comment_excerpt}` : ""
                  } — open with the comment rail`}
                  onClick={(e) => {
                    e.stopPropagation();
                    const st = useInboxStore.getState();
                    st.requestNavigate(session._id, { source: "gesture" });
                    st.setCommentRailOpen(true);
                  }}
                >
                  <svg className="w-2.5 h-2.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M7.9 20A9 9 0 104 16.1L2 22z" />
                  </svg>
                  {session.open_comment_threads}
                  {waitingOnViewer && who && (
                    <span className="truncate min-w-0">· {who.split(" ")[0]}</span>
                  )}
                </button>
              );
            })()}
            {showBlockedBadge && <AuthErrorBadge kind={session.pending_api_error_kind} agentType={session.agent_type} />}
            {session.session_error && (
              <span className="w-1.5 h-1.5 rounded-full bg-sol-red" title={session.session_error} />
            )}
            {session.is_unresponsive && !session.session_error && (
              <span className="w-1.5 h-1.5 rounded-full bg-sol-orange" title="Session unresponsive" />
            )}
            {session.has_pending && !session.is_unresponsive && !isPendingWorking && !isRowRestarting && (
              <span className="w-1.5 h-1.5 rounded-full bg-sol-yellow animate-pulse" title="Message pending" />
            )}
            {/* Settled with content gets the gray idle dot. Keyed on !isLive (now
                staleness-aware) rather than the raw is_idle flag, so a frozen
                is_idle:false row that's really finished shows idle, not nothing. */}
            {!isWorking && !isLive && variant !== "dismissed" && !showBlockedBadge && !session.session_error && !session.is_unresponsive && !session.has_pending && !isPendingWorking && !isRowRestarting && session.message_count > 0 && (
              <span className="w-1.5 h-1.5 rounded-full bg-sol-text-dim/40 ring-1 ring-sol-text-dim/20" title="Session idle" />
            )}
            {/* A kill+restart owns the row's signal while it runs: the re-pended
                message and the not-yet-live status are both part of the restart,
                so the pending chip and dots yield to this one. isLive flipping
                true retires it in favor of the green working dot. */}
            {isRowRestarting && (
              <span className="inline-flex items-center gap-0.5 px-1 py-0 rounded text-[9px] font-semibold bg-sol-orange/10 text-sol-orange border border-sol-orange/30" title="Kill & restart in flight">
                <span className="w-1 h-1 rounded-full bg-sol-orange animate-pulse" />
                restarting
              </span>
            )}
            {isPendingWorking && !isRowRestarting && (
              <span className="inline-flex items-center gap-0.5 px-1 py-0 rounded text-[9px] font-semibold bg-sol-yellow/10 text-sol-yellow border border-sol-yellow/30" title="Sent — waiting to confirm delivery">
                <span className="w-1 h-1 rounded-full bg-sol-yellow animate-pulse" />
                pending
              </span>
            )}
            {(isWorking || isLive) && !isPendingWorking && !isRowRestarting && !showBlockedBadge && (
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
        {spawnedById && (
          // Click-through to the session that spawned this one (its agent-team
          // lead) — same affordance shape as the implementation-session row.
          <div
            className="mt-1 flex items-center gap-1 text-[11px] text-sol-text-dim hover:text-sol-cyan cursor-pointer transition-colors"
            onClick={(e) => {
              e.stopPropagation();
              (onNavigateToSession ?? useInboxStore.getState().navigateToSession)(spawnedById);
            }}
            title="View the session that spawned this one"
          >
            <svg className="w-3 h-3 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6" />
            </svg>
            <span className="flex-shrink-0">spawned by</span>
            <span className="truncate underline underline-offset-2">
              {cleanTitle(spawnedByTitle || "parent session")}
            </span>
          </div>
        )}
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
      {hasThumb && (
        <button
          onClick={(e) => { e.stopPropagation(); setThumbZoom(true); }}
          className={`shrink-0 self-center rounded-md overflow-hidden border border-sol-border/60 cursor-zoom-in transition-transform duration-300 ease-out ${thumbHoverShift}`}
          title="View image"
        >
          <img
            src={thumbSrc!}
            alt=""
            loading="lazy"
            draggable={false}
            onError={() => setThumbBroken(true)}
            className="w-9 h-9 object-cover"
          />
        </button>
      )}
      </div>
      {thumbZoom && thumbSrc && (
        <ImageLightbox src={thumbSrc} onClose={() => setThumbZoom(false)} />
      )}
      </div>
      {/* The ONE pin a pinned session shows: a persistent, interactive badge anchored
          top-right. It stays put on hover (z above the toolbar) and the hover toolbar
          omits its own pin button for pinned rows — so the pin never duplicates or
          cross-fades into a second copy. */}
      {onPin && session.is_pinned && (
        <div data-sv-fade className="absolute top-0 right-0 py-1 pr-2 pointer-events-none z-[2]" style={{ paddingLeft: 24, background: isActive ? 'linear-gradient(to right, transparent, color-mix(in srgb, var(--sol-cyan) 15%, var(--sol-bg-alt)) 60%)' : 'linear-gradient(to right, transparent, var(--sol-bg-alt) 60%)' }}>
          <ShortcutTooltip label="Unpin" action="session.pin" side="left">
            <button
              onClick={(e) => { e.stopPropagation(); onPin(session._id); tipActions.whisper('session.pin', e); }}
              className="p-1 rounded text-sol-magenta transition-opacity hover:opacity-70 pointer-events-auto"
            >
              <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 17v5" />
                <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76z" />
              </svg>
            </button>
          </ShortcutTooltip>
        </div>
      )}
      {!isForeignSession && (onDismiss || onStash || onDefer || onPin) && (
        <div data-sv-fade className={`absolute top-0 bottom-0 right-0 flex flex-col items-center justify-between py-1 opacity-0 group-hover:opacity-100 transition-opacity pl-10 pr-2 pointer-events-none ${isActive ? '' : 'bg-gradient-to-r from-transparent via-[color-mix(in_srgb,var(--sol-bg-alt)_50%,transparent)] to-[color-mix(in_srgb,var(--sol-bg-alt)_85%,transparent)]'}`} style={isActive ? { background: 'linear-gradient(to right, transparent, color-mix(in srgb, color-mix(in srgb, var(--sol-cyan) 15%, var(--sol-bg-alt)) 50%, transparent), color-mix(in srgb, color-mix(in srgb, var(--sol-cyan) 15%, var(--sol-bg-alt)) 85%, transparent))' } : undefined}>
          {/* Pin slot, first so it anchors the top of the toolbar. When the row is
              already pinned, the persistent badge above IS the pin — here we render
              only an invisible spacer the same size, so the remaining actions sit
              exactly where they do for an unpinned row and the badge has a clear slot
              to occupy. When unpinned, this is the live "Pin" affordance. */}
          {onPin && (
            session.is_pinned ? (
              <div className="p-1 pointer-events-none" aria-hidden="true">
                <div className="w-3.5 h-3.5" />
              </div>
            ) : (
              <ShortcutTooltip label="Pin" action="session.pin" side="left">
                <button
                  onClick={(e) => { e.stopPropagation(); onPin(session._id); tipActions.whisper('session.pin', e); checkMilestone('m-first-pin'); }}
                  className="p-1 rounded transition-colors text-sol-text-dim hover:text-sol-magenta pointer-events-auto"
                >
                  <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 17v5" />
                    <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76z" />
                  </svg>
                </button>
              </ShortcutTooltip>
            )
          )}
          {/* Kill — the PRIMARY remove: done with it, clears to the Killed
              group and tears the (usually idle) agent down. Undoable. */}
          {onDismiss && (
            <ShortcutTooltip label="Kill — done, tears the agent down" action="session.kill" side="left">
              <button
                onClick={(e) => { e.stopPropagation(); onDismiss(session._id); }}
                className="p-1 rounded text-sol-text-dim hover:text-sol-red hover:bg-sol-red/10 transition-colors pointer-events-auto"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </ShortcutTooltip>
          )}
          <ShortcutTooltip label="Label session" action="session.moveToBucket" side="left">
            <button
              onClick={(e) => {
                e.stopPropagation();
                useInboxStore.getState().openPalette({ targets: [session], targetType: "session", mode: "bucket" });
              }}
              className="p-1 rounded text-sol-text-dim hover:text-sol-blue transition-colors pointer-events-auto"
            >
              <Tag className="w-3.5 h-3.5" />
            </button>
          </ShortcutTooltip>
          {/* Stash — the SECONDARY remove: set aside, agent keeps running. */}
          {onStash && (
            <ShortcutTooltip label="Stash — set aside, keeps running" action="session.stash" side="left">
              <button
                onClick={(e) => { e.stopPropagation(); onStash(session._id); tipActions.whisper('session.stash', e); }}
                className="p-1 rounded text-sol-text-dim hover:text-sol-yellow transition-colors pointer-events-auto"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 7l10 10M17 17h-6m6 0v-6" />
                </svg>
              </button>
            </ShortcutTooltip>
          )}
        </div>
      )}
      {!isForeignSession && (onRestore || onKill) && (
        <div className="absolute top-1.5 right-1.5 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity z-[4]">
          {onKill && (
            <ShortcutTooltip label={isStashed ? "Kill" : "Remove from list"} action={isStashed ? "session.kill" : undefined} side="left">
              <button
                onClick={(e) => { e.stopPropagation(); onKill(session._id); }}
                className="p-1 rounded-md text-sol-text-dim hover:text-sol-red bg-sol-bg/95 backdrop-blur-sm shadow-sm border border-sol-border/30"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </ShortcutTooltip>
          )}
          {onRestore && (
            <ShortcutTooltip label="Restore" side="left">
              <button
                onClick={(e) => { e.stopPropagation(); onRestore(session._id); }}
                className="p-1 rounded-md text-sol-text-dim hover:text-sol-cyan bg-sol-bg/95 backdrop-blur-sm shadow-sm border border-sol-border/30"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 17L7 7M7 7h6M7 7v6" />
                </svg>
              </button>
            </ShortcutTooltip>
          )}
        </div>
      )}
    </div>
  );
});

// -- SessionListPanel (shared) --

// Wake signature for the Needs Attention section: only tasks in an attention
// state project any fields, so the always-mounted panel re-renders when a task
// enters/leaves the set or a rendered field changes — never on unrelated task
// churn. (This section used to hold two extra live webList subscriptions; the
// store already carries every task via the sync/crawl machinery, so reading
// locally costs the server nothing.)
const needsAttention = (t: any) =>
  t.execution_status === "blocked" || t.execution_status === "needs_context";
const needsAttentionRowSig = (t: any) =>
  needsAttention(t)
    ? `${t.short_id}|${t.title}|${t.execution_status}|${t.status}|${t.triage_status ?? ""}|${String(t.user_id)}|${t.assignee ?? ""}|${t.plan?.title ?? ""}`
    : "";

// Structural signature for the decision rows the Questions section branches on.
const decisionsSectionSig = makeCollectionSig((d: any) =>
  d.status === "pending" ? `${d._id}|${d.conversation_id}|${d.updated_at ?? 0}` : "");

function NeedsAttentionSection() {
  // Workspace-scoped rows, with a field signature so this always-mounted
  // section wakes on the blocked/needs-context fields it renders — and on
  // nothing else (heartbeat churn must not re-render it).
  const wsTasks = useWorkspaceCollection<any>("tasks", needsAttentionRowSig);
  const s = useTrackedStore([(st) => st.currentUser?._id]);
  const updateTask = s.updateTask;
  const [collapsed, setCollapsed] = useState(false);

  const me = s.currentUser?._id?.toString?.() ?? null;
  const tasks = useMemo(() => {
    if (!me) return [];
    return wsTasks
      .filter((t: any) =>
        needsAttention(t) &&
        (!t.triage_status || t.triage_status === "active") &&
        t.status !== "done" && t.status !== "dropped" &&
        (String(t.user_id) === me || t.assignee === me))
      .sort((a: any, b: any) => (b.updated_at ?? 0) - (a.updated_at ?? 0));
  }, [wsTasks, me]);

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
// Stable empty list so the favorites memo keeps a constant ref when not in the
// favorites view (a fresh [] each render would defeat downstream memoization).
const EMPTY_FAVORITES: InboxSession[] = [];
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

// Floating "jump back to your open session" pill. Appears over the list edge
// when the active card is scrolled out of view — top edge when the card is
// above the fold, bottom edge when below — and one click glides back to it.
// Visibility comes from an IntersectionObserver rooted at the scroll container
// (fires on scroll AND container resize with zero per-frame work); a
// per-render node check re-attaches it when a resort replaces the card's DOM
// node without any scroll event.
function ActiveSessionBeacon({
  containerRef,
  activeSessionId,
  title,
}: {
  containerRef: React.RefObject<HTMLDivElement | null>;
  activeSessionId?: string | null;
  title?: string | null;
}) {
  const [dir, setDir] = useState<"up" | "down" | null>(null);
  const observedRef = useRef<Element | null>(null);
  const ioRef = useRef<IntersectionObserver | null>(null);

  // No dep array on purpose: the parent re-renders exactly when the list
  // restructures, which is when the active card's node can change identity.
  // The body is a single querySelector + ref compare, so the steady-state
  // cost per render is negligible.
  useEffect(() => {
    const container = containerRef.current;
    const el = container && activeSessionId
      ? container.querySelector(`[data-session-id="${activeSessionId}"]`)
      : null;
    if (el === observedRef.current) return;
    ioRef.current?.disconnect();
    observedRef.current = el;
    if (!el || !container) {
      setDir(null);
      return;
    }
    const io = new IntersectionObserver(
      ([entry]) => {
        if (!entry) return;
        if (entry.isIntersecting) {
          setDir(null);
          return;
        }
        const rootTop = entry.rootBounds?.top ?? container.getBoundingClientRect().top;
        setDir(entry.boundingClientRect.top < rootTop ? "up" : "down");
      },
      { root: container, threshold: 0 },
    );
    io.observe(el);
    ioRef.current = io;
  });
  // Unmount teardown also forgets the node: under StrictMode's mount/unmount/
  // mount rehearsal the effect above re-runs against the same node and must
  // re-observe rather than short-circuit on the ref compare.
  useEffect(() => () => {
    ioRef.current?.disconnect();
    ioRef.current = null;
    observedRef.current = null;
  }, []);

  const handleJump = useCallback(() => {
    const container = containerRef.current;
    const el = observedRef.current;
    if (container && el && el.isConnected) scrollRowIntoView(container, el);
  }, [containerRef]);

  if (!dir) return null;
  return (
    <button
      onClick={handleJump}
      data-dir={dir}
      className={`cc-session-beacon absolute left-1/2 z-30 flex items-center gap-1.5 rounded-full border border-sol-cyan/40 bg-sol-bg/90 py-1 pl-2 pr-2.5 text-[10px] font-medium text-sol-cyan backdrop-blur-md hover:border-sol-cyan/70 hover:text-sol-cyan ${dir === "up" ? "top-2" : "bottom-2"}`}
      title="Scroll to the open session"
      aria-label="Scroll to the open session"
    >
      {dir === "up" ? <ArrowUp className="cc-session-beacon__arrow h-3 w-3" /> : <ArrowDown className="cc-session-beacon__arrow h-3 w-3" />}
      <span className="cc-session-beacon__dot" aria-hidden />
      <span className="max-w-[150px] truncate">{title || "Open session"}</span>
    </button>
  );
}

// Memoized (see the export at the bottom of the file): the layout re-renders
// often with identical props, and every un-memoized pass here rebuilt ~100
// cards' worth of elements.
function SessionListPanelImpl({
  onSessionSelect,
  activeSessionId,
}: {
  onSessionSelect?: (id: string) => void;
  activeSessionId?: string | null;
}) {
  const s = useTrackedStore([
    s => s.clientState.ui,
    s => s.liveInboxIds,
    // Team-mode active set + viewer identity — gate the scope pre-filter below.
    s => s.teamInboxIds,
    s => s.currentUser?._id,
    s => resolveShowOld(s.clientState.ui),
    // Wake only on STRUCTURAL session change (bucket/order/identity), not on every
    // ~1s liveness heartbeat. Subscribing to the raw s.sessions map re-rendered the
    // whole panel (categorize O(N) + 100 cards) ~17x/sec with 17 live sessions —
    // measured ~70% idle main-thread. The body still reads s.sessions for the data;
    // this only gates the re-render. Time-driven reclassification is preserved by
    // the coarseNow dep on the categorize memo below. See store/wakeSig.ts.
    s => sessionsWakeSig(s.sessions),
    s => s.sessionsWithQueuedMessages,
    s => s.blockedReviveRequestedAt,
    s => s.pendingMessages,
    s => s.activeProjectFilter,
    s => s.activeBucketFilter,
    s => s.chipFilterExclude,
    s => s.buckets,
    s => s.bucketAssignments,
    s => s.collapsedSections,
    s => s.currentSessionId,
    s => s.pendingSessionCreates,
    s => s.showFavorites,
    s => s.favorites,
    s => s.recentFreezeOrder,
    // Explicit decisions (cast decide) split their sessions out of Needs Input
    // into their own Questions section.
    s => decisionsSectionSig(s.sessionDecisions),
    // Local answered/dismissed marks — drop a question from the section in the
    // same commit the user acted in (lib/decisionQueue). Ref changes on stamp.
    s => s.questionResolutions,
  ]);
  const titlebarRef = useTitlebarHead<HTMLDivElement>();
  const router = useRouter();
  const handleKillDismissed = useCallback((id: string) => {
    soundKill();
    if (isConvexId(id)) {
      const store = useInboxStore.getState();
      // session_id rides along so the daemon can still tear the backend down
      // when its local conversation mapping (or the server row) is gone.
      const sessionId = (store.sessions[id] as any)?.session_id;
      store.convCommand(id, "killSession", { mark_completed: true, session_id: sessionId })
        .catch((err: unknown) => {
          if (isParkedDispatchError(err)) return;
          toast.error(`Kill failed: ${err instanceof Error ? err.message : String(err)}`);
        });
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

  // One-shot queries (the schedule-row click's run-list lookup) — not a
  // subscription, so a resting panel costs nothing.
  const convex = useConvex();

  const pendingSendIds = useMemo(() => sessionsWithPendingSend(s.pendingMessages), [s.pendingMessages]);
  // The blank you're viewing (or one mid-create) stays visible in NEW; all
  // other never-engaged pre-warm blanks are hidden by categorizeSessions.
  const blankOpts = useMemo(
    () => ({ currentSessionId: activeSessionId ?? s.currentSessionId, pendingCreateIds: new Set(Object.keys(s.pendingSessionCreates)), reviveRequestedAt: s.blockedReviveRequestedAt }),
    [activeSessionId, s.currentSessionId, s.pendingSessionCreates, s.blockedReviveRequestedAt],
  );
  // "Show old sessions" — a sticky per-user view preference (clientState.ui.
  // inbox_show_old, stamped LWW so the newest toggle on any device wins
  // everywhere, OFF included). "Old" = a cached top-level session the live
  // (authoritative) subscription no longer returns; the completeness crawl
  // keeps it in the never-prune cache for search/open, so hiding it is a pure
  // render decision, never a server re-fetch. Shown by default (a new user
  // sees their whole history); hiding narrows the inbox to exactly the
  // server's active set (store.liveInboxIds) — identical on every client —
  // instead of each client's divergent local cache. liveInboxIds seeds from its persisted twin at
  // hydration, so even the first cold frame filters correctly; an empty set
  // (fresh install) means "nothing old yet" and never blanks the list.
  // Optimistic stubs, pinned, the open session, and dismissed/stashed rows are
  // always kept.
  const showAllSessions = resolveShowOld(s.clientState.ui);
  const focusedId = activeSessionId ?? s.currentSessionId;
  // Inbox scope: "mine" (personal inbox) or "team" (shared team board). The
  // scope pre-filter (filterInboxScope) runs BEFORE the old-session partition so
  // "mine" never shows a teammate row and "team" shows exactly the team set.
  const inboxScope = s.clientState.ui?.inbox_scope ?? "mine";
  const meId = s.currentUser?._id?.toString?.() ?? null;
  const scopedSessions = useMemo(
    () => filterInboxScope(s.sessions, inboxScope, meId, s.teamInboxIds, focusedId),
    [s.sessions, inboxScope, meId, s.teamInboxIds, focusedId],
  );
  // The wake signature ignores updated_at, so the panel no longer re-renders on
  // every heartbeat. categorizeSessions still retires a stale "working" to
  // needs-input by comparing updated_at to Date.now() (the trust-TTL sweep), which
  // is time-driven, not field-driven — so feed it a coarse clock to keep that
  // sweep alive without coupling it back to heartbeat churn. 15s is well under the
  // minutes-scale TTL. See useCoarseNow / store/wakeSig.ts.
  const coarseNow = useCoarseNow(15_000);
  // Team mode has no "old" partition — the board is already a bounded, team-
  // visible set, so every scoped row shows and the show-old toggle stays hidden
  // (oldCount 0). Mine mode keeps the completeness-crawl old-session hiding.
  // visibleSessions (cache minus "old") backs BOTH the categorize buckets and the
  // schedule-inbox partition below, so the panel keeps this explicit pass.
  const { visibleSessions, oldCount } = useMemo(
    () => inboxScope === "team"
      ? { visibleSessions: scopedSessions, oldCount: 0 }
      : partitionOldSessions(scopedSessions, s.liveInboxIds, showAllSessions, focusedId),
    [scopedSessions, inboxScope, s.liveInboxIds, showAllSessions, focusedId],
  );

  const { sorted: sortedSessions, pinned, newSessions, needsInput, done, dormant, working, stashed: stashedList, dismissed: dismissedList, subsByParent: globalSubByParent, forksByParent: globalForksByParent } = useMemo(
    () => categorizeSessions(visibleSessions, s.sessionsWithQueuedMessages, pendingSendIds, blankOpts),
    // coarseNow: re-run the TTL staleness sweep on the coarse clock (categorize
    // reads Date.now() internally); the result only changes when a row crosses the
    // trust TTL, otherwise the memoized arrays keep stable refs.
    [visibleSessions, s.sessionsWithQueuedMessages, pendingSendIds, blankOpts, coarseNow],
  );

  // -- Schedules in the inbox (status view) --
  // The same per-user webList the badges/strip/schedules page subscribe to
  // (Convex dedupes), partitioned into: one row per armed schedule, the set of
  // sessions absorbed behind those rows (resting loop homes + uneventful runs),
  // and the armed-inject map the kill gesture consults. All membership rules
  // live in partitionTriggerInbox.
  // Store-fed (hooks/useSyncTriggers): the schedule rows paint from the
  // cached roster at boot instead of waiting a round-trip.
  const { tasks: scheduleTaskRows, ready: schedulesReady } = useTriggers();
  const scheduleTasks = (schedulesReady || scheduleTaskRows.length > 0 ? scheduleTaskRows : undefined) as TaskRow[] | undefined;
  const schedulesSeenAt = s.clientState.ui?.schedules_seen_at ?? 0;
  const schedulePartition = useMemo(
    () => partitionTriggerInbox(scheduleTasks, visibleSessions, {
      sessionsWithQueuedMessages: s.sessionsWithQueuedMessages,
      seenAt: schedulesSeenAt,
      focusedId,
      // Coarse clock so loop/subagent row membership (wakeup freshness,
      // liveness staleness) re-evaluates without data churn.
      now: coarseNow,
    }),
    [scheduleTasks, visibleSessions, s.sessionsWithQueuedMessages, schedulesSeenAt, focusedId, coarseNow],
  );
  // Kill-gesture handlers read the partition through a ref so their identities
  // stay stable (SessionCard is memoized on them).
  const schedulePartitionRef = useRef(schedulePartition);
  schedulePartitionRef.current = schedulePartition;
  // Publish the absorbed set for keyboard nav (computeVisualOrder reads it from
  // the store). Content-keyed so Set identity churn from recomputes doesn't
  // spam store notifications.
  // (The setScheduleNavSets publish lives below, after the trigger-view
  // grouping it also carries is computed.)

  // Corner shown when the session is in a fork tree (has forks, or is one);
  // colored by the tree's root so the whole tree matches.
  const forkColorKeyOf = useCallback(
    (session: InboxSession) =>
      session.forked_from || globalForksByParent.has(session._id)
        ? forkTreeRootId(session, s.sessions)
        : undefined,
    [s.sessions, globalForksByParent],
  );

  const activeSessions = useMemo(() => [...pinned, ...newSessions, ...needsInput, ...done, ...dormant, ...working], [pinned, newSessions, needsInput, done, dormant, working]);

  const bucketByConv = useMemo(() => convBucketMap(s.bucketAssignments), [s.bucketAssignments]);
  const visibleBuckets = useMemo(() => sortLabels(s.buckets), [s.buckets]);
  // conversation_id → its visible (non-archived) bucket name. Derived ONCE from the
  // same bucket map the chips use, then handed to each card as a scalar prop so the
  // card no longer scans bucketAssignments on every heartbeat notification.
  const labelByConv = useMemo(() => {
    const map: Record<string, string> = {};
    for (const convId in bucketByConv) {
      const bucketId = bucketByConv[convId];
      const bucket = bucketId ? s.buckets[bucketId] : null;
      if (bucket && !bucket.archived_at) map[convId] = bucket.name;
    }
    return map;
  }, [bucketByConv, s.buckets]);
  // Favorited conversation ids, derived once from the authoritative favorites list so
  // a card checks its star with an O(1) Set lookup instead of a per-heartbeat scan.
  const favoriteIds = useMemo(
    () => new Set((s.favorites as { _id: string }[]).map((f) => f._id)),
    [s.favorites],
  );
  // Favorited if the row carries the flag OR it's in the favorites list (both are
  // maintained by toggleFavorite); resolved to a scalar so each card memoizes on it.
  const cardIsFavorite = useCallback(
    (sess: InboxSession) => (sess as { is_favorite?: boolean }).is_favorite === true || favoriteIds.has(sess._id),
    [favoriteIds],
  );
  const { bucketCounts, projectCounts, projectPathByName } = useMemo(
    () => computeChipCounts(activeSessions, bucketByConv),
    [activeSessions, bucketByConv],
  );

  // ONE filter pipeline for every list the panel renders. Project and bucket
  // chips are mutually exclusive (the setters clear each other) but apply both
  // defensively. Mid-create stubs pass the bucket filter so the session you
  // just summoned inside a focused bucket doesn't vanish before assignment.
  const filterByChip = useCallback(
    (items: InboxSession[]) =>
      items.filter((sess) =>
        chipMatchesSession(sess, { projectFilter: s.activeProjectFilter, bucketFilter: s.activeBucketFilter, exclude: s.chipFilterExclude, bucketByConv }),
      ),
    [s.activeProjectFilter, s.activeBucketFilter, s.chipFilterExclude, bucketByConv],
  );

  // The Stashed / Killed buckets' open state is ephemeral and CLOSED by
  // default: closed on every load, and re-closed whenever the chip filter
  // (label, layout, project) changes — filterByChip's identity is that filter.
  // It used to live in the synced clientState (show_stashed / show_dismissed),
  // so one auto-reveal left the bucket open on every device, forever.
  const CLOSED_BUCKETS = { stashed: false, dismissed: false };
  const [openBuckets, setOpenBuckets] = useState(CLOSED_BUCKETS);
  const [bucketsFilter, setBucketsFilter] = useState(() => filterByChip);
  if (bucketsFilter !== filterByChip) {
    // The state holds a FUNCTION: pass it through a thunk, or React runs it
    // as an updater with the previous filter as its argument.
    setBucketsFilter(() => filterByChip);
    setOpenBuckets(CLOSED_BUCKETS);
  }

  const filteredPinned = useMemo(() => filterByChip(pinned), [filterByChip, pinned]);
  const filteredNew = useMemo(() => filterByChip(newSessions), [filterByChip, newSessions]);
  const filteredNeedsInput = useMemo(() => filterByChip(needsInput), [filterByChip, needsInput]);
  const filteredDone = useMemo(() => filterByChip(done), [filterByChip, done]);
  const filteredDormant = useMemo(() => filterByChip(dormant), [filterByChip, dormant]);
  const filteredWorking = useMemo(() => filterByChip(working), [filterByChip, working]);
  // QUESTIONS is its own section, not a slice of the feed: a session that has
  // ASKED something explicit (a `cast decide` row, an open AskUserQuestion or
  // permission prompt) is a different obligation from one that merely finished
  // its turn, so it files here whatever its pin or rest verdict — the ask
  // outranks placement, and the section reads first. liftQuestions is the ONE
  // rule (shared with the store's keyboard order) for what qualifies and for
  // the rows that come along from outside the rail's scope, so the section's
  // count is the queue badge's count. See lib/decisionQueue.
  const mineSessions = useMemo(() => filterInboxScope(s.sessions, "mine", meId), [s.sessions, meId]);
  const { questions: statusQuestions, isQuestion } = useMemo(() => {
    const lifted = liftQuestions(
      [filteredPinned, filteredNew, filteredNeedsInput, filteredDone, filteredDormant, filteredWorking],
      s.sessionDecisions,
      mineSessions,
      s.questionResolutions,
    );
    // Rows lifted from outside the rail still honor the active chip.
    return { ...lifted, questions: filterByChip(lifted.questions) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filteredPinned, filteredNew, filteredNeedsInput, filteredDone, filteredDormant, filteredWorking, decisionsSectionSig(s.sessionDecisions), s.questionResolutions, mineSessions, filterByChip]);
  // STATUS view only: sessions absorbed behind a TRIGGERS row (a loop's resting
  // home, a spawn trigger's uneventful runs — partitionTriggerInbox) are parked
  // on the trigger's next fire, so a settled one files under DORMANT alongside
  // the declared / inferred parks; a mid-wake one stays in Working. Nothing
  // vanishes: hiding is only ever the user's own stash/kill. The label/plan
  // lenses keep the plain chip-filtered lists. Mirrors visualOrderSessions so
  // Ctrl+J/K walks exactly what's on screen.
  const statusPinned = useMemo(() => filteredPinned.filter((sess) => !isQuestion(sess)), [filteredPinned, isQuestion]);
  const statusNew = useMemo(() => filteredNew.filter((sess) => !isQuestion(sess)), [filteredNew, isQuestion]);
  const statusNeedsInputRest = useMemo(
    () => filteredNeedsInput.filter((sess) => !isQuestion(sess) && !schedulePartition.absorbedIds.has(sess._id)),
    [filteredNeedsInput, isQuestion, schedulePartition.absorbedIds],
  );
  const statusDone = useMemo(
    () => filteredDone.filter((sess) => !isQuestion(sess) && !schedulePartition.absorbedIds.has(sess._id)),
    [filteredDone, isQuestion, schedulePartition.absorbedIds],
  );
  const statusDormant = useMemo(() => {
    const absorbedSettled = [...filteredNeedsInput, ...filteredDone]
      .filter((sess) => schedulePartition.absorbedIds.has(sess._id));
    return [...filteredDormant, ...absorbedSettled].filter((sess) => !isQuestion(sess));
  }, [filteredDormant, filteredNeedsInput, filteredDone, isQuestion, schedulePartition.absorbedIds]);
  const statusWorking = useMemo(() => filteredWorking.filter((sess) => !isQuestion(sess)), [filteredWorking, isQuestion]);
  // What the keyboard walk and the collapse state treat as "needs input" in the
  // status view — the plain, unabsorbed, question-free rest.
  const statusNeedsInput = statusNeedsInputRest;
  // The label / plan lenses dissolve the status sections back to one flat
  // active set. They render the TRIGGERS section too, so absorbed rows stay
  // out (they'd double-render behind their trigger row); every other settled
  // row — blocked, done, dormant — is in.
  const lensSettled = useMemo(
    () => [...filteredNeedsInput, ...filteredDone, ...filteredDormant].filter((sess) => !schedulePartition.absorbedIds.has(sess._id)),
    [filteredNeedsInput, filteredDone, filteredDormant, schedulePartition.absorbedIds],
  );
  // Schedule rows honor the project chip like session cards do.
  const scheduleRowsView = useMemo(
    () =>
      s.activeProjectFilter
        ? schedulePartition.rows.filter(
            (r) => (getProjectName(undefined, r.task.project_path) === s.activeProjectFilter) !== s.chipFilterExclude,
          )
        : schedulePartition.rows,
    [schedulePartition.rows, s.activeProjectFilter, s.chipFilterExclude],
  );
  // A schedule row opens the conversation behind it — the loop's home session
  // or the newest run; the dismissed-peek path handles folded runs.
  // Opening FROM a schedule surface (dock row, bar under a card) also asks the
  // conversation's schedule strip to arrive expanded — the click means "show me
  // this schedule", so the prompt should be visible without a second click.
  // No conversation to land on (a spawn schedule that has never run, or one
  // whose conversation isn't in the local cache) falls back to the trigger's
  // own detail page, so a row click is never a silent no-op.
  // A trigger that has FIRED before also lands on its most recent firing (the
  // same target the newest run-history entry opens) instead of the tail. The
  // trigger message resolves synchronously from the loaded window when it's
  // there; otherwise the conversation opens immediately and the run-list query
  // supplies the scroll target when it answers (local-first: the click never
  // waits on the server). A late answer only scrolls if the user is still on
  // the conversation this click opened — never a second jump elsewhere.
  const openScheduleTarget = useCallback((row: TriggerRow) => {
    const st = useInboxStore.getState();
    const sess = row.openId ? st.sessions[row.openId] : undefined;
    if (!sess) {
      router.push(`/triggers/${row.task._id}`);
      return;
    }
    st.setScheduleStripExpand({ convId: sess._id, nonce: Date.now() });
    // Pseudo rows (loops/subagents) have no agent_tasks runs to land on — the
    // fake task id must never reach webListRuns.
    const hasRun = !row.kind && (row.task.run_count > 0 || row.task.last_run_at !== undefined);
    const local = hasRun ? latestLoadedTriggerMessage(st.messages[sess._id], row.task._id) : undefined;
    // Same rule as the monitor rows: the pending pointer is only consumed on
    // the inbox surface — off it, fall through to handleSelect (the page's
    // own open path) instead of stranding a pointer that yanks the view later.
    if (local && window.location.pathname.startsWith("/inbox")) {
      st.requestNavigate(sess._id, {
        scrollToMessageId: local.messageId,
        scrollToMessageTimestamp: local.timestamp,
      });
      return;
    }
    // Captured BEFORE the select: the query below often answers before the
    // router commits the navigation, so "user is still here" must accept a
    // view that hasn't moved yet — only a view pointing somewhere genuinely
    // NEW (neither the destination nor where we stood) means the user left.
    const beforeIds = new Set([st.currentSessionId, st.viewingDismissedId].filter(Boolean));
    handleSelect(sess);
    if (!hasRun) return;
    fetchTriggerRuns(convex, row.task._id)
      .then((runs: TriggerRun[]) => {
        const run = runs?.[0];
        if (!run?.trigger_message_id || run._id !== sess._id) return;
        const now = useInboxStore.getState();
        const visible = [now.currentSessionId, now.pendingNavigateId, now.viewingDismissedId].filter(Boolean) as string[];
        const stillHere = visible.some((id) => id === sess._id) || visible.every((id) => beforeIds.has(id));
        if (stillHere) openRunInStore(run);
      })
      .catch(() => {});
  }, [handleSelect, router, convex]);
  // Trigger view header click: the trigger IS the citizen there, so its row
  // opens the trigger's own detail page — the sessions it drives are already
  // sub rows right below. Pseudo rows (loops, live subagents) have no
  // agent_tasks row for that page to show, so they keep the
  // conversation-open path.
  const openTriggerPage = useCallback((row: TriggerRow) => {
    if (row.kind) {
      openScheduleTarget(row);
      return;
    }
    router.push(`/triggers/${row.task._id}`);
  }, [router, openScheduleTarget]);
  // Schedule bars under cards: the schedules bound to a VISIBLE session — the
  // ones it originates (inject, any type), the spawn triggers it created
  // (attribution, not routing), plus, for a run card, the schedule that
  // spawned it. Keyed off partition.rows so bars share the unread state.
  const scheduleBarRowsFor = useCallback((sess: InboxSession): TriggerRow[] => {
    const rows = schedulePartitionRef.current.rows;
    const out: TriggerRow[] = [];
    for (const r of rows) {
      // Loop rows attach like inject triggers — they name this card's
      // standing intent.
      if (
        r.task.originating_conversation_id === sess._id ||
        r.task.created_by_conversation_id === sess._id ||
        (!!sess.agent_task_id && r.task._id === sess.agent_task_id)
      ) {
        out.push(r);
      }
    }
    return out;
  }, []);
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
  const filteredStashed = useMemo(() => {
    // Same recency window as Dismissed for the same noise reason.
    const cutoff = Date.now() - DISMISSED_VISIBLE_MS;
    const filtered = filterByChip(stashedList).filter(
      (sess) => (sess.updated_at ?? 0) >= cutoff,
    );
    return filtered.sort((a, b) => (b.inbox_stashed_at || b.updated_at || 0) - (a.inbox_stashed_at || a.updated_at || 0));
  }, [filterByChip, stashedList]);

  // The bars under a card, in whichever form the ⚡ pill toggle asks for:
  // folded to one strip (default), one full row per bar, or hidden entirely.
  // The legacy show_triggers boolean seeds the default so an existing
  // "expanded" choice survives the upgrade to the three-way mode.
  const cardBars: CardBarsMode =
    s.clientState.ui?.card_bars ?? ((s.clientState.ui?.show_triggers ?? false) ? "full" : "strip");
  // "By trigger" lens — the roster's rows promoted to first-class rows, each
  // with the sessions it drives as sub rows beneath (home conversation /
  // runs), the rest falling to project groups. Grouped over the UNabsorbed
  // filtered lists PLUS the stashed/killed buckets: a standing trigger's home
  // typically rests in the stash, and this lens exists precisely to show each
  // trigger's work — claimed hidden sessions render as muted sub rows, while
  // unclaimed hidden ones stay in their buckets. Computed in every mode (one
  // cheap pass) so the nav bridge and the view switcher know whether triggers
  // exist before the user ever enters the mode.
  const triggerView = useMemo(() => {
    // Pinned flows into the pool like everything else — this view has exactly
    // two tiers, triggers then other sessions, with no status/pinned chrome.
    const { triggerGroups, rest } = groupSessionsByTrigger(
      scheduleRowsView,
      [...filteredPinned, ...filteredNew, ...filteredNeedsInput, ...filteredWorking],
      { hidden: [...filteredStashed, ...filteredDismissed] },
    );
    return { triggerGroups, projectGroups: groupSessionsForLabelView(rest, {}, {}).projectGroups };
  }, [scheduleRowsView, filteredPinned, filteredNew, filteredNeedsInput, filteredWorking, filteredStashed, filteredDismissed]);
  // Publish the schedule projections for keyboard nav (computeVisualOrder reads
  // them from the store): the absorbed set (status view) and the trigger view's
  // group order. Content-keyed so identity churn from recomputes doesn't spam
  // store notifications.
  const triggerOrder = useMemo(
    () => triggerView.triggerGroups.map((g) => ({ key: g.key, ids: g.items.map((i) => i._id) })),
    [triggerView.triggerGroups],
  );
  const navSetsKey = useMemo(
    () =>
      [...schedulePartition.absorbedIds].sort().join(",") +
      "|" + triggerOrder.map((g) => `${g.key}:${g.ids.join("+")}`).join(","),
    [schedulePartition.absorbedIds, triggerOrder],
  );
  useEffect(() => {
    useInboxStore.getState().setScheduleNavSets({ absorbed: schedulePartition.absorbedIds, triggerOrder });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navSetsKey]);

  // Stale working set: EVERY non-hidden session untouched for >30d, minus
  // pinned (explicit keep) and the one you're viewing. Stashed sessions are an
  // explicit keep too — the sweep must not retire what the user deliberately
  // set aside. Computed from the full session map — NOT the active buckets —
  // on purpose: subagents nested under a parent are held out of those buckets,
  // but dismissing their parent promotes them to top-level, so they must be in
  // the dismiss set too or they refill the inbox after a sweep.
  const staleSessions = useMemo(() => {
    const cutoff = Date.now() - STALE_SESSION_MS;
    return (Object.values(s.sessions) as InboxSession[]).filter(
      (sess) =>
        !isSessionHidden(sess) &&
        !sess.is_pinned &&
        sess._id !== activeSessionId &&
        (sess.updated_at ?? 0) < cutoff,
    );
  }, [s.sessions, activeSessionId]);
  const [stalePromptSnoozed, setStalePromptSnoozed] = useState(false);
  const [dismissingStale, setDismissingStale] = useState(false);
  const dismissStaleMutation = useMutation(api.conversations.dismissStaleInboxSessions);
  const showStalePrompt = staleSessions.length > STALE_PROMPT_THRESHOLD && !stalePromptSnoozed;

  // Sessions parked on a limit/auth/connection banner — the fleet-level revive
  // banner's input. isBlockedConversation is the SAME predicate the server
  // selection uses (limit/auth/connection/fatal kinds — self-retrying 429/5xx
  // never count — claude only, dismissed excluded), plus the same 48h window,
  // so the count shown always matches what a revive would act on.
  const blockedSessions = useMemo(() => {
    const now = Date.now();
    const since = now - 48 * 60 * 60 * 1000;
    // A session the user just told to continue/switch (fresh revive stamp) is
    // out of the blocked set immediately — the pill count drops and the banner
    // clears on the click, not on the daemon round trip. The server flag only
    // resets once the agent resumes; if that never happens the stamp expires
    // and the session re-enters here (coarseNow keeps the TTL live).
    const reviving = freshReviveRequestIds(s.blockedReviveRequestedAt, now);
    return (Object.values(s.sessions) as InboxSession[]).filter(
      (sess) =>
        isBlockedConversation({ ...sess, agent_type: sess.agent_type ?? "claude_code" }) &&
        !isSessionHidden(sess) &&
        !reviving.has(sess._id) &&
        (sess.updated_at ?? 0) > since,
    );
  }, [s.sessions, s.blockedReviveRequestedAt, coarseNow]);
  // A fleet of nothing but blocked subagent workers doesn't earn the amber
  // pill: their parents have moved on, so there's no one waiting on a revive.
  // The banner itself still handles the all-subs case when it's forced open.
  const blockedHasNonSub = useMemo(
    () => blockedSessions.some((sess) => !isSubagentConversation(sess)),
    [blockedSessions],
  );
  // A LIVE 0→N transition of the blocked set is a fresh incident: replay the
  // banner entrance with the attention glow and pulse the header pill so the
  // moment registers. Hydration also walks 0→N right after mount, so the
  // first seconds don't count — a reload with existing casualties gets the
  // plain entrance only.
  const blockedMountedAtRef = useRef(Date.now());
  const prevBlockedCountRef = useRef(0);
  const [blockedIncidentTs, setBlockedIncidentTs] = useState(0);
  useEffect(() => {
    const prev = prevBlockedCountRef.current;
    prevBlockedCountRef.current = blockedSessions.length;
    if (prev === 0 && blockedSessions.length > 0 && Date.now() - blockedMountedAtRef.current > 5000) {
      setBlockedIncidentTs(Date.now());
    }
  }, [blockedSessions.length]);
  // The banner is transient (snoozes on X and after acting); the header pill is
  // the permanent trigger. Clicking it force-opens the banner — past the snooze
  // and even for a single blocked session — and scrolls it into view.
  const [blockedBannerForced, setBlockedBannerForced] = useState(false);
  const openBlockedBanner = useCallback(() => {
    setBlockedBannerForced(true);
    useInboxStore.getState().setShowFavorites(false);
    scrollContainerRef.current?.scrollTo({ top: 0, behavior: "smooth" });
  }, []);

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
  // Cap how many rows each section renders. A section like "Needs Input" can
  // accumulate thousands of finished sessions (the store never prunes), and
  // rendering them all materializes tens of thousands of DOM nodes in this
  // always-mounted panel — every heartbeat then re-reconciles the whole tree,
  // which is enough to peg the renderer (badly in dev builds). Render a bounded
  // window with a "show more" expander; the active row is always force-mounted
  // so auto-scroll and the currently-viewed session never fall off the cap.
  const SECTION_RENDER_CAP = 50;
  const SECTION_RENDER_STEP = 100;
  // Global ceiling on cards mounted across ALL sections combined. The per-section
  // cap alone doesn't bound the total — with thousands of sessions spread across
  // many label/project groups (plus nested subagents) it still reached ~800 cards
  // / 23k DOM nodes. This budget is consumed in render order (top sections win),
  // so the whole panel stays bounded no matter how many sessions accumulate. Every
  // session stays in the store — this only limits how many are MOUNTED at once.
  const GLOBAL_CARD_BUDGET = 100;
  const [sectionLimits, setSectionLimits] = useState<Record<string, number>>({});
  const [globalCardExtra, setGlobalCardExtra] = useState(0);
  // Reset each render; renderSection (a closure over this) consumes it in call order.
  let globalRenderedCards = 0;
  const showSubagents = s.clientState.ui?.show_subagents ?? true;
  // Three-way view mode; the legacy boolean is honored when the mode is unset.
  const viewMode: InboxViewMode =
    s.clientState.ui?.inbox_view_mode ?? ((s.clientState.ui?.inbox_flat_view ?? false) ? "time" : "grouped");
  const flatView = viewMode === "time" || viewMode === "recent";
  // Manual drag-order overlay, only consulted in "time" mode (see comparator).
  const manualOrder = s.clientState.ui?.inbox_manual_order;
  // The two flat views reuse the already-computed sortedSessions (every
  // non-dismissed session) and only swap the comparator: "recent" ranks by last
  // activity (updated_at, reshuffles as work happens), "time" by creation
  // (started_at, a stable chronology, with any manual drag pins overlaid).
  // Shared flatViewComparator so this render and the keyboard-nav order
  // (computeVisualOrder) can't drift. It still honors the show_subagents toggle:
  // when subagents are hidden, the same sessions the grouped view nests away
  // (subsByParent / globalSubByParent) are excluded here — except the selected
  // one, which always renders.
  // Render and keyboard-nav share the same frozen order during recent-mode j/k
  // (see recentFreezeOrder) so the list can't move out from under the cursor.
  const recentFreezeOrder = s.recentFreezeOrder;
  const flatList = useMemo(
    () =>
      flatViewSessions(sortedSessions, globalSubByParent, {
        mode: viewMode === "recent" ? "recent" : "time",
        showSubagents,
        focusedId: activeSessionId,
        manualOrder,
        freezeOrder: viewMode === "recent" ? recentFreezeOrder : null,
        chipMatches: (sess) =>
          chipMatchesSession(sess, { projectFilter: s.activeProjectFilter, bucketFilter: s.activeBucketFilter, exclude: s.chipFilterExclude, bucketByConv }),
      }),
    [sortedSessions, showSubagents, globalSubByParent, activeSessionId, viewMode, manualOrder, recentFreezeOrder, s.activeProjectFilter, s.activeBucketFilter, s.chipFilterExclude, bucketByConv],
  );
  const totalSubagentCount = useMemo(() => {
    let count = 0;
    for (const subs of globalSubByParent.values()) count += subs.length;
    return count;
  }, [globalSubByParent]);
  // Whether ANY card could wear a bar — schedules aside, a workflow run in
  // flight or a daemon-reported open task is enough. Gates the ⚡ pill so the
  // control only appears when it has something to govern. open_tasks is the
  // cheap daemon-report approximation of the full liveWatchRowsFor merge:
  // good enough for "show the toggle", while each card still decides its own
  // rows exactly.
  const anyLiveBars = useMemo(
    () => sortedSessions.some((x) => workflowBarVisible(x) || (x.open_tasks?.length ?? 0) > 0),
    [sortedSessions],
  );

  const [viewMenuOpen, setViewMenuOpen] = useState(false);
  const viewMenuRef = useRef<HTMLDivElement>(null);
  useWatchEffect(() => {
    if (!viewMenuOpen) return;
    const handler = (e: MouseEvent) => {
      if (viewMenuRef.current && !viewMenuRef.current.contains(e.target as Node)) setViewMenuOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [viewMenuOpen]);

  // "By label" view: every active non-pinned top-level session grouped by its
  // manual label; unlabeled sessions group by PROJECT — projects are a specific
  // kind of label, auto-derived from the directory. Pinned stays its own top
  // section — pin is urgency, not theme. The grouping fn is shared with the
  // store's visualOrder so Ctrl+J/K walks exactly this layout.
  const bucketView = useMemo(() => {
    if (viewMode !== "bucket") return null;
    // Absorbed-filtered lists: the label view renders the TRIGGERS section too,
    // so sessions resting behind a schedule row must not double-render in groups.
    return groupSessionsForLabelView(
      [...filteredNew, ...lensSettled, ...filteredWorking],
      s.buckets,
      bucketByConv,
    );
  }, [viewMode, filteredNew, lensSettled, filteredWorking, bucketByConv, s.buckets]);

  // "By plan" lens — same active set as the bucket view (status buckets dissolved
  // back to flat), regrouped by plan instead of label. Every plan shows, even a
  // plan of one; sessions with no plan fall to project groups. This lens is the
  // ONLY place the inbox groups by plan — the status view keeps every session in
  // its status bucket.
  const planView = useMemo(() => {
    if (viewMode !== "plan") return null;
    return groupSessionsByPlan(
      [...filteredNew, ...lensSettled, ...filteredWorking],
    );
  }, [viewMode, filteredNew, lensSettled, filteredWorking]);
  // Offer the "By plan" option only when a plan is actually in play, mirroring how
  // "By label" appears only with buckets.
  const hasPlanSessions = useMemo(() => activeSessions.some((x) => !!x.active_plan), [activeSessions]);

  // Favorites view: the SAME session cache filtered to the kept set, grouped by
  // project — the shelf's organization ("what is it about"), distinct from the
  // active desk's status buckets ("what needs me now"). allFavorites (unscoped)
  // feeds the project chips so every project a favorite lives in is offered;
  // favoriteGroups is the rendered list, narrowed by the active project chip.
  // No label tier — everything falls to project groups via the shared grouper.
  const favoritesView = s.showFavorites;
  const allFavorites = useMemo(
    () => (favoritesView ? selectFavoriteSessions(s.sessions, null, s.favorites) : EMPTY_FAVORITES),
    [favoritesView, s.sessions, s.favorites],
  );
  const favoriteGroups = useMemo(() => {
    if (!favoritesView) return null;
    const scoped = s.activeProjectFilter
      ? allFavorites.filter((x) => (getProjectName(x.git_root, x.project_path) === s.activeProjectFilter) !== s.chipFilterExclude)
      : allFavorites;
    const pinned = scoped.filter((x) => x.is_pinned).sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0));
    const rest = scoped.filter((x) => !x.is_pinned);
    const { projectGroups } = groupSessionsForLabelView(rest, {}, {});
    return { pinned, projectGroups, count: scoped.length };
  }, [favoritesView, allFavorites, s.activeProjectFilter, s.chipFilterExclude]);
  const favChipCounts = useMemo(
    () => (favoritesView ? computeChipCounts(allFavorites, bucketByConv) : null),
    [favoritesView, allFavorites, bucketByConv],
  );

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
    // A label mid-create (optimistic stub) can't take assignments yet — the
    // server row supersedes the stub within ~a second.
    if (bucketId && !isConvexId(bucketId)) {
      toast.error("Label is still syncing — try again in a moment");
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

  // Drag-to-reorder in the "time" view. There's no separate grip handle — the
  // whole card is already draggable (the card→label "file it" drag, tagged
  // `codecast/session-id`), and we reuse that same drag here: drop it on a label
  // chip to file it, or on another row to reorder. `reorderOver` drives the
  // insertion line between rows; the drop computes one midpoint key and pins the
  // moved row.
  const [reorderOver, setReorderOver] = useState<{ id: string; pos: "before" | "after" } | null>(null);
  const handleReorderDrop = useCallback((draggedId: string, targetId: string, pos: "before" | "after") => {
    setReorderOver(null);
    if (draggedId === targetId) return;
    // flatList is the on-screen "time" order, but a hoisted subagent/teammate
    // row is pinned under its parent — it owns no slot of its own, so neighbor
    // keys come from the slot-owning rows only (a nested row's key would break
    // the midpoint math's monotonic-keys assumption). Dragging a nested row is
    // a no-op (the hoist would snap it right back), and a drop aimed at one
    // resolves to "after its parent's group".
    const inList = new Set(flatList.map((sess) => sess._id));
    const nestedUnder = (sess: InboxSession) => {
      const p = nestParentIdOf(sess);
      return p && p !== sess._id && inList.has(p) ? p : null;
    };
    const draggedRow = flatList.find((sess) => sess._id === draggedId);
    if (draggedRow && nestedUnder(draggedRow)) return;
    const targetRow = flatList.find((sess) => sess._id === targetId);
    if (!targetRow) return;
    const targetParent = nestedUnder(targetRow);
    const rest = flatList.filter((sess) => sess._id !== draggedId && !nestedUnder(sess));
    const restKeys = rest.map((sess) => manualOrder?.[sess._id] ?? sess.started_at ?? sess.updated_at ?? 0);
    const targetIdx = rest.findIndex((sess) => sess._id === (targetParent ?? targetId));
    if (targetIdx < 0) return;
    const insertIndex = (targetParent ? "after" : pos) === "before" ? targetIdx : targetIdx + 1;
    const key = computeManualSortKey(restKeys, insertIndex);
    useInboxStore.getState().setSessionManualOrder(draggedId, key);
  }, [flatList, manualOrder]);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const scrolledToRef = useRef<string | null>(null);

  // -- Hide & enter animations --
  // Stash: set aside, agent keeps running (Stashed group). The secondary remove.
  // Deliberately no schedule CHANGE: stash keeps schedules armed (a
  // scheduler-origin injection preserves the stash), so nothing is canceled —
  // but SAY so when one is armed, since that asymmetry (stash keeps the loop,
  // dismiss/kill cancels it) is invisible unless the product states it.
  const handleAnimatedStash = useCallback((id: string) => {
    animatedHideSession(id, "stash");
    const armed = schedulePartitionRef.current.armedInjectByConv.get(id);
    if (armed?.length) {
      toast(
        armed.length === 1
          ? `Stashed — schedule "${armed[0].title}" stays armed`
          : `Stashed — ${armed.length} schedules stay armed`,
        { description: "It keeps firing here quietly — the session comes back to your queue only if a run flags needs-attention. Dismiss or kill would cancel it.", duration: 8000 },
      );
    }
  }, []);
  // Killing a session cancels the schedules that inject into it (server side,
  // on the hide transition) and restoring it re-arms them — the shared notice
  // hook surfaces both side effects; the same hook backs the palette and the
  // keyboard chords, so every kill surface says the same thing.
  const { killWithNotice, killManyWithNotice, restoreWithNotice } = useTriggerKillNotice();
  // Dismiss: "done with it" — clears the session from the inbox into the Dismissed
  // group. The server tears the (usually idle) agent down on the inbox_dismissed_at
  // transition, so this is codecast's kill gesture, surfaced as the PRIMARY remove
  // action. Undoable via the toast.
  const handleAnimatedDismiss = killWithNotice;
  // On a stashed card the destructive slot kills (server tears the agent down
  // on the transition) — the row moves down into Killed.
  const handleKillStashed = killWithNotice;
  // Right-click menu: ONE cursor-anchored instance serves every card in the
  // panel; cards only report the click. Verbs reuse the exact handlers the
  // hover toolbar uses, so animations and trigger notices stay identical.
  const sessionCtxMenu = useContextMenu<{ session: InboxSession; isForeign: boolean }>();
  // Depends on the stable `open`, not the menu object: every SessionCard takes
  // this prop, so a new function here re-renders the whole list.
  const openSessionCtxMenu = sessionCtxMenu.open;
  const handleCardContextMenu = useCallback(
    (e: React.MouseEvent, session: InboxSession, isForeign: boolean) => {
      openSessionCtxMenu(e, { session, isForeign });
    },
    [openSessionCtxMenu],
  );
  // "Kill all" on the Stashed header — two-step confirm (arm, then fire within
  // 3s) since it tears down every stashed agent at once. Kills the top-level
  // rows (each stamps its own children) plus any stashed child whose parent
  // isn't stashed, so nothing in the bucket survives.
  const [killAllArmed, setKillAllArmed] = useState(false);
  const killAllTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleKillAllStashed = useCallback(() => {
    if (killAllTimerRef.current) clearTimeout(killAllTimerRef.current);
    if (!killAllArmed) {
      setKillAllArmed(true);
      killAllTimerRef.current = setTimeout(() => setKillAllArmed(false), 3000);
      return;
    }
    setKillAllArmed(false);
    const stashedIds = new Set(filteredStashed.map((sess) => sess._id));
    const ids = filteredStashed
      .filter((sess) => !sess.parent_conversation_id || !stashedIds.has(sess.parent_conversation_id))
      .map((sess) => sess._id);
    killManyWithNotice(ids);
    toast.success(`Killed ${ids.length} stashed session${ids.length === 1 ? "" : "s"}`);
  }, [killAllArmed, filteredStashed, killManyWithNotice]);

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
    // subagent (or nested teammate) renders under its parent's card, so the
    // parent's membership decides which section hosts the row.
    const activeRow = s.sessions[activeSessionId];
    const parentId = activeRow ? nestParentIdOf(activeRow) : null;
    const inList = (items: InboxSession[]) => items.some(i => i._id === activeSessionId || (!!parentId && i._id === parentId));
    const sections: [InboxSession[], string][] = flatView
      ? [[flatList, "all"]]
      : viewMode === "bucket" && bucketView
        ? [
            [filteredPinned, "pinned"],
            ...bucketView.labelGroups.map(({ bucket, items }) => [items, `bucket_${bucket._id}`] as [InboxSession[], string]),
            ...bucketView.projectGroups.map(({ name, items }) => [items, `bucketproj_${name}`] as [InboxSession[], string]),
          ]
        : viewMode === "plan" && planView
        ? [
            [filteredPinned, "pinned"],
            ...planView.planGroups.map(({ key, items }) => [items, `plan_${key}`] as [InboxSession[], string]),
            ...planView.projectGroups.map(({ name, items }) => [items, `planproj_${name}`] as [InboxSession[], string]),
          ]
        : viewMode === "trigger"
        ? [
            // Trigger sub rows are always visible (their rows don't collapse),
            // so only the project fallthrough tier can need a reveal here.
            ...triggerView.projectGroups.map(({ name, items }) => [items, `trigproj_${name}`] as [InboxSession[], string]),
          ]
        : [
            [statusQuestions, "questions"],
            [statusPinned, "pinned"], [statusNew, "new"], [statusNeedsInput, "needs_input"],
            [statusDone, "done"], [statusWorking, "working"], [statusDormant, "dormant"],
          ];
    for (const [items, key] of sections) {
      if (inList(items) && s.collapsedSections[key]) {
        s.toggleCollapsedSection(key);
        return;
      }
    }
    if (inList(filteredStashed) && !openBuckets.stashed) {
      setOpenBuckets((o) => ({ ...o, stashed: true }));
      return;
    }
    if (inList(filteredDismissed) && !openBuckets.dismissed) {
      setOpenBuckets((o) => ({ ...o, dismissed: true }));
    }
  }, [activeSessionId, sortedSessions, s.collapsedSections, openBuckets, viewMode]);

  // Shared renderer for the two hidden buckets at the bottom of the list —
  // Stashed (set aside, agent alive) above Killed (retired, agent torn down;
  // the persisted flag keeps its historical name inbox_dismissed_at, and the
  // server's kill transition additionally stamps inbox_killed_at).
  // Identical chrome; they differ only in the destructive slot: a stashed card
  // kills (moves down a bucket), a killed card's X removes the row outright.
  // Both hide entirely when empty and render COLLAPSED by default — the
  // auto-reveal effect above opens one only when the active session is inside.
  const renderHiddenBucket = (opts: {
    label: string;
    items: InboxSession[];
    expanded: boolean;
    onToggle: () => void;
    variant: "stashed" | "dismissed";
    onKill: (id: string) => void;
    headerAction?: React.ReactNode;
  }) => {
    const { label, items, expanded, onToggle, variant, onKill, headerAction } = opts;
    if (items.length === 0) return null;
    // A hidden bucket is not a dead bucket: a stashed agent keeps running, and
    // an armed schedule can keep driving a killed/stashed conversation. Same
    // predicate as the card's green dot (isLive) so header and rows can't
    // disagree; coarseNow keeps the trust-stale check on the panel's ticker.
    const isBucketLive = (sess: InboxSession) =>
      !sess.is_idle && sess.message_count > 0 && !isLivenessStale(sess, coarseNow);
    const liveCount = items.filter(isBucketLive).length;
    const allIds = new Set(items.map((sess) => sess._id));
    const subMap = new Map<string, InboxSession[]>();
    for (const sess of items) {
      const nestParent = nestParentIdOf(sess);
      if (nestParent && allIds.has(nestParent)) {
        if (!subMap.has(nestParent)) subMap.set(nestParent, []);
        subMap.get(nestParent)!.push(sess);
      }
    }
    for (const subs of subMap.values()) {
      subs.sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0));
    }
    const subsWithParent = new Set(Array.from(subMap.values()).flat().map((sess) => sess._id));
    const orphanedSub = (sess: InboxSession) =>
      !subsWithParent.has(sess._id) && sess.parent_conversation_id && s.sessions[sess.parent_conversation_id];
    const topLevel = items.filter((sess) => !subsWithParent.has(sess._id) && !orphanedSub(sess));
    // Activity floats: running rows (or idle parents with a running subagent)
    // sort to the top of the opened bucket, so background work is one glance
    // away instead of buried under newest-stashed-first. Stable sort keeps the
    // existing newest-first order within each half.
    const rowLive = (sess: InboxSession) =>
      isBucketLive(sess) || (subMap.get(sess._id) ?? []).some(isBucketLive);
    topLevel.sort((a, b) => Number(rowLive(b)) - Number(rowLive(a)));
    return (
      <div className="border-t border-sol-border/30">
        <div className="w-full bg-sol-bg border-b border-sol-border/30 flex items-center">
          <button
            onClick={onToggle}
            className="flex-1 min-w-0 pl-3 py-1.5 flex items-center text-left"
          >
            <span className="text-[10px] font-semibold uppercase tracking-wider text-sol-text-dim">
              {label}{items.length > 0 ? ` (${items.length})` : ""}
            </span>
            {liveCount > 0 && (
              <span className="ml-1.5 shrink-0 inline-flex items-center whitespace-nowrap gap-1 px-1.5 py-0 rounded-full text-[9px] font-semibold bg-sol-green/10 text-sol-green border border-sol-green/30 normal-case tracking-normal">
                <span className="w-1 h-1 rounded-full bg-sol-green animate-pulse motion-reduce:animate-none" />
                {liveCount} running
              </span>
            )}
          </button>
          {headerAction}
          <button onClick={onToggle} className="shrink-0 pl-2 pr-3 py-1.5">
            <svg className={`w-3 h-3 transition-transform text-sol-text-dim ${expanded ? "rotate-180" : ""}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </button>
        </div>
        {expanded && topLevel.length > 0 && (() => {
          // Cap the hidden bucket too — KILLED/STASHED can hold hundreds of rows
          // when expanded ("show killed/stashed" on). Same per-bucket cap + show-more
          // as renderSection; keeps the active row mounted past the cap.
          const hkey = `hidden_${variant}`;
          const hlimit = sectionLimits[hkey] ?? SECTION_RENDER_CAP;
          let visibleTop = topLevel.length > hlimit ? topLevel.slice(0, hlimit) : topLevel;
          if (visibleTop.length < topLevel.length && activeSessionId) {
            const active = topLevel.find((sess) => sess._id === activeSessionId);
            if (active && !visibleTop.includes(active)) visibleTop = [...visibleTop, active];
          }
          const hHidden = topLevel.length - visibleTop.length;
          globalRenderedCards += visibleTop.length;
          return (
          <div>
            {visibleTop.map((session) => (
              <div key={session._id} className="border-b border-sol-border/30">
                <SessionCard
                  session={session}
                  isActive={session._id === activeSessionId}
                  globalIndex={-1}
                  onSelect={handleSelect}
                  onCardContextMenu={handleCardContextMenu}
                  onRestore={restoreWithNotice}
                  onKill={onKill}
                  variant={variant}
                  forkColorKey={forkColorKeyOf(session)}
                  sessionLabel={labelByConv[session._id] ?? null}
                  isFavorite={cardIsFavorite(session)}
                />
                {/* Stashing is the standing-loop workflow — a loop's home rests
                    here while its schedule keeps firing — so the stashed/killed
                    buckets carry the same bars as the live sections; without
                    them an expanded bucket hides that a card is a loop. */}
                <CardBars
                  session={session}
                  mode={cardBars}
                  scheduleRows={scheduleBarRowsFor(session)}
                  activeSessionId={activeSessionId}
                  onOpen={handleSelect}
                  onOpenSchedule={openScheduleTarget}
                />
                {(subMap.get(session._id) ?? []).filter((sub) => showSubagents || sub._id === activeSessionId).map((sub) => (
                  <SessionCard
                    key={sub._id}
                    session={sub}
                    isActive={sub._id === activeSessionId}
                    isParentActive={session._id === activeSessionId}
                    globalIndex={-1}
                    onSelect={handleSelect}
                  onCardContextMenu={handleCardContextMenu}
                    onRestore={restoreWithNotice}
                    onKill={onKill}
                    variant={variant}
                    sessionLabel={labelByConv[sub._id] ?? null}
                    isFavorite={cardIsFavorite(sub)}
                  />
                ))}
              </div>
            ))}
            {hHidden > 0 && (
              <button
                onClick={() => setSectionLimits((prev) => ({ ...prev, [hkey]: (prev[hkey] ?? SECTION_RENDER_CAP) + SECTION_RENDER_STEP }))}
                className="w-full px-3 py-1.5 text-[10px] font-medium text-sol-text-dim hover:text-sol-cyan transition-colors text-left border-b border-sol-border/30"
              >
                Show {Math.min(hHidden, SECTION_RENDER_STEP)} more · {hHidden} hidden
              </button>
            )}
          </div>
          );
        })()}
      </div>
    );
  };

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
      // "time" view only: each row accepts a dragged session card as a reorder drop.
      reorderable?: boolean;
      // Render the heading as a monospace, normal-case, truncating label instead
      // of the uppercased status caption. For long mixed-case identifiers like a
      // plan heading ("pl-114 · Union Outreach — …") where uppercasing reads badly.
      monoLabel?: boolean;
      // Route a card's click somewhere other than the inbox pane (Questions
      // opens the full-width answer view anchored on the clicked session).
      // Sub-session rows keep the default select — they aren't the question.
      onSelect?: (session: InboxSession) => void;
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
        {/* The section color rides on the header element itself so simple view
            can tint the divider rule with currentColor; children set their own. */}
        <button
          data-sv-sec
          onClick={() => s.toggleCollapsedSection(key)}
          className={`w-full px-3 py-1.5 bg-sol-bg border-b border-sol-border/30 flex items-center justify-between gap-2 ${color}`}
        >
          {opts?.monoLabel ? (
            <span className={`text-[10px] font-semibold flex items-center gap-1.5 min-w-0 ${color}`}>
              <span className="truncate font-mono">{label}</span>
              <span className="opacity-70 shrink-0">({items.length})</span>
            </span>
          ) : (
            <span className={`text-[10px] font-semibold uppercase tracking-wider ${color}`}>
              {label} ({items.length})
            </span>
          )}
          <svg className={`w-3 h-3 transition-transform ${color} ${collapsed ? "" : "rotate-180"}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </button>
        {!collapsed && (() => {
          const sectionCap = sectionLimits[key] ?? SECTION_RENDER_CAP;
          // Take from the shared global budget (consumed in render order, so the
          // top-priority sections fill first); the active row is force-kept below
          // even when the budget is spent.
          const globalRemaining = Math.max(0, GLOBAL_CARD_BUDGET + globalCardExtra - globalRenderedCards);
          const limit = Math.min(sectionCap, globalRemaining);
          let visibleItems = items.length > limit ? items.slice(0, limit) : items;
          // Never let the active row (or the parent hosting the active subagent)
          // fall past the cap — it must stay mounted for auto-scroll and so the
          // session being viewed never vanishes from the list.
          if (visibleItems.length < items.length && activeSessionId) {
            const needed = items.find(
              (i) => i._id === activeSessionId
                || (globalSubByParent.get(i._id) || []).some((sub) => sub._id === activeSessionId),
            );
            if (needed && !visibleItems.includes(needed)) visibleItems = [...visibleItems, needed];
          }
          const hiddenCount = items.length - visibleItems.length;
          globalRenderedCards += visibleItems.length;
          return (<>
          {visibleItems.map((session) => {
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
            const reorderable = !!opts?.reorderable;
            const reorderHere = reorderable && reorderOver?.id === session._id;
            return (
              <div
                key={session._id}
                className={`border-b border-sol-border/30${reorderable ? " relative" : ""}`}
                onDragOver={reorderable ? (e) => {
                  if (!e.dataTransfer.types.includes("codecast/session-id")) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "move";
                  const rect = e.currentTarget.getBoundingClientRect();
                  const pos = e.clientY < rect.top + rect.height / 2 ? "before" : "after";
                  setReorderOver((cur) => (cur?.id === session._id && cur.pos === pos ? cur : { id: session._id, pos }));
                } : undefined}
                onDragLeave={reorderable ? (e) => {
                  if (e.currentTarget.contains(e.relatedTarget as Node)) return;
                  setReorderOver((cur) => (cur?.id === session._id ? null : cur));
                } : undefined}
                onDragEnd={reorderable ? () => setReorderOver(null) : undefined}
                onDrop={reorderable ? (e) => {
                  const draggedId = e.dataTransfer.getData("codecast/session-id");
                  if (!draggedId) return;
                  e.preventDefault();
                  const rect = e.currentTarget.getBoundingClientRect();
                  const pos = e.clientY < rect.top + rect.height / 2 ? "before" : "after";
                  handleReorderDrop(draggedId, session._id, pos);
                } : undefined}
              >
                {reorderHere && (
                  <div className={`absolute left-0 right-0 h-0.5 bg-sol-cyan z-10 pointer-events-none ${reorderOver!.pos === "before" ? "top-0" : "bottom-0"}`} />
                )}
                <SessionCard
                  session={session}
                  isActive={session._id === activeSessionId}
                  globalIndex={0}
                  onSelect={opts?.onSelect ?? handleSelect}
                  onCardContextMenu={handleCardContextMenu}
                  onDismiss={handleAnimatedDismiss}
                  onStash={handleAnimatedStash}
                  onDefer={s.deferSession}
                  onPin={s.pinSession}
                  variant={sectionVariant || "default"}
                  forkColorKey={forkColorKeyOf(session)}
                  sessionLabel={labelByConv[session._id] ?? null}
                  isFavorite={cardIsFavorite(session)}
                />
                {/* The bars stack under their card the way subagent rows do —
                    schedule rows keep the dock roster's full anatomy (name,
                    gist, cadence, countdown, hover verbs); click selects the
                    session with its schedule strip expanded (openScheduleTarget
                    — the strip re-expands even if the session is already
                    active). The trigger view skips the schedule rows: there
                    every armed trigger is already a first-class group header,
                    so a bar under a card would repeat the header just above
                    it. The dormant fallback keeps its invariant inside
                    CardBars: a parked card explains its wake unless the mode
                    is an explicit "hidden". */}
                <CardBars
                  session={session}
                  mode={cardBars}
                  scheduleRows={viewMode !== "trigger" ? scheduleBarRowsFor(session) : []}
                  activeSessionId={activeSessionId}
                  dormant={key === "dormant"}
                  onOpen={handleSelect}
                  onOpenSchedule={openScheduleTarget}
                />
                {visibleSubs.map((sub) => (
                  <SessionCard
                    key={sub._id}
                    session={sub}
                    isActive={sub._id === activeSessionId}
                    isParentActive={session._id === activeSessionId}
                    globalIndex={0}
                    onSelect={handleSelect}
                  onCardContextMenu={handleCardContextMenu}
                    onDismiss={handleAnimatedDismiss}
                    onStash={handleAnimatedStash}
                    variant={sectionVariant || "default"}
                    sessionLabel={labelByConv[sub._id] ?? null}
                    isFavorite={cardIsFavorite(sub)}
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
          {hiddenCount > 0 && (
            <button
              onClick={() => { setSectionLimits((prev) => ({ ...prev, [key]: (prev[key] ?? SECTION_RENDER_CAP) + SECTION_RENDER_STEP })); setGlobalCardExtra((g) => g + SECTION_RENDER_STEP); }}
              className="w-full px-3 py-1.5 text-[10px] font-medium text-sol-text-dim hover:text-sol-cyan transition-colors text-left border-b border-sol-border/30"
            >
              Show {Math.min(hiddenCount, SECTION_RENDER_STEP)} more · {hiddenCount} hidden
            </button>
          )}
          </>);
        })()}
      </div>
    );
  };

  return (
    <div data-sv-rail className="h-full w-full flex flex-col bg-sol-bg-alt overflow-hidden">
      <div ref={titlebarRef} className="cc-panel__head min-w-0">
        {favoritesView && (
          <div className="flex items-center gap-1.5 flex-shrink-0 text-sol-yellow mr-0.5" title="Kept sessions — your long-term shelf">
            <Star className="w-3.5 h-3.5 fill-current" />
            <span className="text-[11px] font-semibold uppercase tracking-wider">Favorites</span>
            {favoriteGroups && favoriteGroups.count > 0 && (
              <span className="text-[10px] text-sol-text-dim font-medium">{favoriteGroups.count}</span>
            )}
          </div>
        )}
        <LabelChipsRow
          bucketCounts={favoritesView ? favChipCounts!.bucketCounts : bucketCounts}
          projectCounts={favoritesView ? favChipCounts!.projectCounts : projectCounts}
          projectPathByName={favoritesView ? favChipCounts!.projectPathByName : projectPathByName}
          dropSessionOnLabel={dropSessionOnLabel}
        />
        {/* One pill: a view-mode dropdown (trigger shows the current mode's
            icon), a divider, the independent show/hide toggles (subagents,
            old), then — after another divider, at the far end — the favorites
            mode toggle. Ctrl+, still cycles view modes. In favorites view the
            view controls hide (favorites is always project-grouped) and the
            pill collapses to just the amber star, which stays put. */}
        <div className="flex items-center flex-shrink-0 ml-auto gap-1.5">
          {/* Permanent trigger for the blocked-fleet actions: visible whenever
              ANY session is parked on a limit/login banner, no matter how the
              banner itself was snoozed. Panel chrome, so it never scrolls away. */}
          {blockedSessions.length > 0 && blockedHasNonSub && (
            <button
              key={blockedIncidentTs}
              onClick={openBlockedBanner}
              title={`${blockedSessions.length} session${blockedSessions.length === 1 ? "" : "s"} blocked on a usage limit, login, dropped connection, or api error — restart them all`}
              className={`flex items-center gap-1 px-1.5 py-[3px] rounded-[5px] text-[10px] font-semibold bg-amber-500/10 text-amber-500 border border-amber-500/30 hover:bg-amber-500/20 transition-colors ${blockedIncidentTs > 0 ? "cc-blocked-pill-pulse" : ""}`}
            >
              <svg className="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path d="M6 3h12M6 21h12M8 3v3.5c0 2 4 4 4 5.5s-4 3.5-4 5.5V21M16 3v3.5c0 2-4 4-4 5.5s4 3.5 4 5.5V21" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              {blockedSessions.length}
            </button>
          )}
          <div className="flex items-center flex-shrink-0 rounded-md border border-sol-border/40 bg-sol-bg/70 p-px">
          {!favoritesView && <>
          {/* Inbox scope: Mine ⇄ Team. Team turns the inbox into a shared board
              of every team-visible session across the active team (a superset of
              Mine). Blue when active so it reads as a mode, not a filter toggle. */}
          <ShortcutTooltip label={inboxScope === "team" ? "Team inbox — everyone's visible sessions" : "Show the whole team's inbox"} side="bottom">
            <button
              onClick={() => s.updateClientUI({ inbox_scope: inboxScope === "team" ? "mine" : "team" })}
              className={`flex items-center gap-0.5 px-1 py-[3px] rounded-[5px] transition-colors ${
                inboxScope === "team"
                  ? "bg-sol-blue/15 text-sol-blue"
                  : "text-sol-text-dim/70 hover:text-sol-text"
              }`}
            >
              <Users className="w-3 h-3" />
              {inboxScope === "team" && <span className="text-[10px] font-semibold leading-none">Team</span>}
            </button>
          </ShortcutTooltip>
          <div className="w-px h-3 bg-sol-border/40" />
          {(() => {
            const viewModeOptions = [
              { key: "grouped", label: "By status", icon: List },
              { key: "recent", label: "By updated", icon: Activity },
              { key: "time", label: "By created", icon: Clock },
              ...(visibleBuckets.length > 0 ? [{ key: "bucket", label: "By label", icon: Tag }] : []),
              ...(hasPlanSessions ? [{ key: "plan", label: "By plan", icon: Workflow }] : []),
              ...(scheduleRowsView.length > 0 ? [{ key: "trigger", label: "By trigger", icon: Zap }] : []),
            ];
            const current = viewModeOptions.find((o) => o.key === viewMode) ?? viewModeOptions[0];
            const CurrentIcon = current.icon;
            return (
              <div ref={viewMenuRef} className="relative">
                <ShortcutTooltip label={current.label} action="inbox.toggleFlatView" hint="cycles" side="bottom">
                  <button
                    onClick={() => setViewMenuOpen((o) => !o)}
                    className={`flex items-center px-1 py-[3px] rounded-[5px] transition-colors ${
                      viewMenuOpen ? "bg-sol-cyan/15 text-sol-cyan" : "text-sol-text-dim/70 hover:text-sol-text"
                    }`}
                  >
                    <CurrentIcon className="w-3 h-3" />
                    <ChevronDown className="w-2 h-2 opacity-60" />
                  </button>
                </ShortcutTooltip>
                {viewMenuOpen && (
                  <div className="absolute top-full right-0 mt-1 w-48 bg-sol-bg border border-sol-border rounded-lg shadow-xl z-[250] py-1">
                    <FilterOptionList
                      options={viewModeOptions}
                      value={viewMode}
                      onChange={(mode) => s.setInboxViewMode(mode as InboxViewMode)}
                      onPicked={() => setViewMenuOpen(false)}
                    />
                  </div>
                )}
              </div>
            );
          })()}
          {(totalSubagentCount > 0 || oldCount > 0 || scheduleRowsView.length > 0 || anyLiveBars) && (
            <div className="w-px h-3 bg-sol-border/40" />
          )}
          {totalSubagentCount > 0 && (
            <button
              onClick={() => s.updateClientUI({ show_subagents: !showSubagents })}
              title={showSubagents ? `Hide ${totalSubagentCount} subagent sessions` : `Show ${totalSubagentCount} subagent sessions`}
              className={`cc-panel__btn ${
                showSubagents
                  ? "bg-sol-violet/15 text-sol-violet"
                  : "text-sol-text-dim/70 hover:text-sol-text"
              }`}
            >
              <GitFork className="w-3 h-3" />
            </button>
          )}
          {/* The bars under cards — triggers, workflow runs, monitors and
              background commands — behind one three-way pill: strip (the
              default, one folded line per card) → full (a row per bar) →
              hidden (nothing at all, the same gesture the subagent toggle
              offers). Same idiom as that toggle beside it, in schedule-amber
              when expanded; ZapOff says "deliberately off", not just resting. */}
          {(scheduleRowsView.length > 0 || anyLiveBars) && (
            <button
              onClick={() =>
                s.updateClientUI({
                  card_bars: cardBars === "strip" ? "full" : cardBars === "full" ? "hidden" : "strip",
                })
              }
              title={
                cardBars === "strip"
                  ? "Triggers and tasks folded to strips — click for full rows under cards"
                  : cardBars === "full"
                    ? "Full trigger and task rows under cards — click to hide them"
                    : "Triggers and tasks hidden — click to show them as strips"
              }
              className={`cc-panel__btn ${
                cardBars === "full"
                  ? "bg-sol-amber/15 text-sol-amber"
                  : cardBars === "hidden"
                    ? "text-sol-text-dim/40 hover:text-sol-text"
                    : "text-sol-text-dim/70 hover:text-sol-text"
              }`}
            >
              {cardBars === "hidden" ? <ZapOff className="w-3 h-3" /> : <Zap className="w-3 h-3" />}
            </button>
          )}
          {oldCount > 0 && (
            <button
              onClick={() => s.setShowOldSessions(!showAllSessions)}
              title={showAllSessions ? `Hide ${oldCount} old session${oldCount === 1 ? "" : "s"}` : `Show ${oldCount} old session${oldCount === 1 ? "" : "s"}`}
              className={`cc-panel__btn ${
                showAllSessions
                  ? "bg-sol-cyan/15 text-sol-cyan"
                  : "text-sol-text-dim/70 hover:text-sol-text"
              }`}
            >
              <History className="w-3 h-3" />
            </button>
          )}
          <div className="w-px h-3 bg-sol-border/40" />
          </>}
          {/* Favorites is a MODE of this panel — toggled at the END of the
              group, after the old-sessions toggle. Amber when active. */}
          <button
            onClick={() => useInboxStore.getState().setShowFavorites(!favoritesView)}
            title={favoritesView ? "Back to inbox" : "Show favorites"}
            className={`cc-panel__btn ${
              favoritesView
                ? "bg-amber-400/15 text-amber-400"
                : "text-sol-text-dim/70 hover:text-amber-400"
            }`}
          >
            <Star className="w-3 h-3" fill={favoritesView ? "currentColor" : "none"} />
          </button>
        </div>
        </div>
      </div>
      {/* Relative wrapper so the out-of-view beacon can float over the list
          edges without joining the scroll flow. */}
      <div className="relative flex-1 min-h-0">
      <div ref={scrollContainerRef} className="h-full overflow-y-auto scrollbar-auto">
        {favoritesView ? (
          favoriteGroups && favoriteGroups.count > 0 ? (
            <>
              {renderSection("Pinned", favoriteGroups.pinned, "text-sol-magenta", undefined, undefined, { key: "favpinned" })}
              {favoriteGroups.projectGroups.map(({ name, items }) => (
                <div key={`fav-${name}`}>
                  {renderSection(name, items, name === "other" ? "text-sol-text-dim" : getLabelColor(name).text, undefined, undefined, { key: `favproj_${name}` })}
                </div>
              ))}
            </>
          ) : (
            <div className="px-4 py-12 flex flex-col items-center text-center gap-2">
              <Star className="w-6 h-6 text-sol-yellow/40" />
              <div className="text-sm font-medium text-sol-text-muted">
                {s.activeProjectFilter
                  ? s.chipFilterExclude ? "No favorites outside this project" : "No favorites in this project"
                  : "No favorites yet"}
              </div>
              <div className="text-[11px] text-sol-text-dim max-w-[220px] leading-relaxed">
                {s.activeProjectFilter
                  ? s.chipFilterExclude
                    ? "Every kept session lives in the excluded project. Clear the filter to see them."
                    : "Clear the project filter to see every kept session."
                  : "Star a conversation to keep it here for later — it stays no matter how old it gets, and it’s one keystroke to jump back in."}
              </div>
              {s.activeProjectFilter && (
                <button onClick={() => s.setActiveProjectFilter(null)} className="mt-1 text-[11px] text-sol-cyan hover:underline">
                  Show all favorites
                </button>
              )}
            </div>
          )
        ) : (<>
        <BlockedSessionsBanner
          key={blockedIncidentTs}
          blocked={blockedSessions}
          onOpen={handleSelect}
          forced={blockedBannerForced}
          onClearForced={() => setBlockedBannerForced(false)}
          fresh={blockedIncidentTs > 0}
        />
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
          renderSection("All", flatList, "text-sol-cyan", undefined, true, { reorderable: viewMode === "time" })
        ) : viewMode === "bucket" && bucketView ? (
        <>
        {/* An exclude chip is a near-global view ("everything but X") — the
            failed/blocked banner must not vanish behind it. */}
        {(s.chipFilterExclude || (!s.activeProjectFilter && !s.activeBucketFilter)) && <NeedsAttentionSection />}
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
        ) : viewMode === "plan" && planView ? (
        <>
        {/* An exclude chip is a near-global view ("everything but X") — the
            failed/blocked banner must not vanish behind it. */}
        {(s.chipFilterExclude || (!s.activeProjectFilter && !s.activeBucketFilter)) && <NeedsAttentionSection />}
        {renderSection("Pinned", filteredPinned, "text-sol-magenta")}
        {planView.planGroups.map(({ key, label, items }) => (
          <div key={key}>
            {renderSection(label, items, "text-teal-400", undefined, undefined, { key: `plan_${key}`, monoLabel: true })}
          </div>
        ))}
        {/* Sessions with no plan group by project — same fallback tier the label
            view uses for unlabeled sessions. */}
        {planView.projectGroups.map(({ name, items }) => (
          <div key={`planproj-${name}`}>
            {renderSection(name, items, name === "other" ? "text-sol-text-dim" : getLabelColor(name).text, undefined, undefined, { key: `planproj_${name}` })}
          </div>
        ))}
        </>
        ) : viewMode === "trigger" ? (
        <>
        {/* Trigger-first: every roster row (armed trigger, loop, live subagent)
            is a primary row — the SAME rich row the dock shows, verbs and all —
            and the sessions it drives render as compact SUB ROWS beneath it
            (the ↳ child idiom, schedule-amber). Clicking the trigger opens its
            dedicated page; clicking a sub row opens that session. A trigger
            with no visible sessions keeps its row: the trigger is the citizen,
            its work may be folded away or not yet run. */}
        {triggerView.triggerGroups.map(({ key, row, items }) => (
          <div key={key}>
            <TriggerRowItem row={row} activeSessionId={activeSessionId} onOpen={openTriggerPage} />
            {items.map((session) => (
              <div key={session._id} className="border-b border-sol-border/30">
                <SessionCard
                  session={session}
                  isActive={session._id === activeSessionId}
                  globalIndex={0}
                  onSelect={handleSelect}
                  onCardContextMenu={handleCardContextMenu}
                  onDismiss={handleAnimatedDismiss}
                  onStash={handleAnimatedStash}
                  onDefer={s.deferSession}
                  onPin={s.pinSession}
                  forkColorKey={forkColorKeyOf(session)}
                  sessionLabel={labelByConv[session._id] ?? null}
                  isFavorite={cardIsFavorite(session)}
                  subRow="trigger"
                  // A claimed stashed/killed home renders muted — resting is
                  // its normal state under a standing trigger.
                  variant={isSessionHidden(session) ? "stashed" : "default"}
                />
              </div>
            ))}
          </div>
        ))}
        {/* Sessions no trigger drives group by project — the same fallback tier
            the label and plan views use. */}
        {triggerView.projectGroups.map(({ name, items }) => (
          <div key={`trigproj-${name}`}>
            {renderSection(name, items, name === "other" ? "text-sol-text-dim" : getLabelColor(name).text, undefined, undefined, { key: `trigproj_${name}` })}
          </div>
        ))}
        </>
        ) : (
        <>
        {/* An exclude chip is a near-global view ("everything but X") — the
            failed/blocked banner must not vanish behind it. */}
        {(s.chipFilterExclude || (!s.activeProjectFilter && !s.activeBucketFilter)) && <NeedsAttentionSection />}
        {/* Questions lead: a session that asked you something is your move
            before anything else, pinned or not. One move: clicking a card
            opens the full-width answer view anchored on that question, and
            answering advances to the next — same flow for one or many. */}
        {renderSection("Questions", statusQuestions, "text-sol-violet", undefined, undefined, {
          key: "questions",
          onSelect: (session) => router.push(`/questions?s=${session._id}`),
        })}
        {renderSection("Pinned", statusPinned, "text-sol-magenta")}
        {renderSection("New", statusNew, "text-sol-blue")}
        {renderSection("Needs Input", statusNeedsInputRest, "text-sol-yellow")}
        {/* Sections read top-down as "who acts next": you (Questions, Needs
            Input, Done to review), the agent right now (Working), then a
            machine event (Dormant). Nothing below Dormant is anyone's move. */}
        {renderSection("Done", statusDone, "text-sol-cyan")}
        {renderSection("Working", statusWorking, "text-sol-green", "working")}
        {renderSection("Dormant", statusDormant, "text-sol-blue")}
        </>
        )}
        {sortedSessions.length === 0 && (
          <div className="px-3 py-8 text-center text-sm text-sol-text-dim">
            No active sessions
          </div>
        )}
        {renderHiddenBucket({
          label: "Stashed",
          items: filteredStashed,
          expanded: openBuckets.stashed,
          onToggle: () => setOpenBuckets((o) => ({ ...o, stashed: !o.stashed })),
          variant: "stashed",
          onKill: handleKillStashed,
          headerAction: (
            <button
              onClick={handleKillAllStashed}
              className={`px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wider transition-all shrink-0 ${
                killAllArmed
                  ? "text-sol-bg bg-sol-red hover:bg-sol-red/90"
                  : "text-sol-text-dim opacity-40 hover:opacity-100 hover:text-sol-red hover:bg-sol-red/10"
              }`}
              title="Kill every stashed session"
            >
              {killAllArmed ? `kill ${filteredStashed.length}?` : "kill all"}
            </button>
          ),
        })}
        {renderHiddenBucket({
          // "Killed" is honest for what dominates this bucket. It is keyed on
          // inbox_dismissed_at, and both real kill surfaces write that stamp:
          // the web's kill action optimistically (hideSessionInDraft mode
          // "kill"), and `cast kill` durably (cliSetSessionVisibility, which
          // patches inbox_dismissed_at and then stamps inbox_killed_at via
          // applyHideTransition). The dismissed reconcile crawl
          // (collectHiddenSessionsLite) has no shouldShowInInbox filter, so a
          // `cast kill`ed row keeps arriving here. The non-kill dismissals that
          // also land here (agentTasks' auto-tidy, dismissStaleInboxSessions)
          // are the minority — and renaming this to "Dismissed" would mean
          // pressing Kill, reading a "Killed" toast, and watching the row drop
          // into "Dismissed". See inboxFilters.ts on why conflating the two
          // loses the one difference that matters operationally.
          label: "Killed",
          items: filteredDismissed,
          expanded: openBuckets.dismissed,
          onToggle: () => setOpenBuckets((o) => ({ ...o, dismissed: !o.dismissed })),
          variant: "dismissed",
          onKill: handleKillDismissed,
        })}
        </>)}
      </div>
      <ActiveSessionBeacon
        containerRef={scrollContainerRef}
        activeSessionId={focusedId}
        title={(focusedId && s.sessions[focusedId]?.title) || null}
      />
      </div>
      {/* The schedule dock is panel chrome, not list content: it renders under
          the scroll area in every view mode EXCEPT "by trigger" — there the
          whole list already IS the roster, so the dock would double it. */}
      {viewMode !== "trigger" && (
        <TriggerDock
          rows={scheduleRowsView}
          unreadCount={schedulePartition.unreadCount}
          nextRunAt={schedulePartition.nextRunAt}
          activeSessionId={activeSessionId}
          onOpen={openScheduleTarget}
        />
      )}
      <ContextMenu state={sessionCtxMenu}>
        {({ session, isForeign }) => (
          <SessionMenuItems
            session={session}
            isForeign={isForeign}
            onOpen={() => handleSelect(session)}
            onStash={() => handleAnimatedStash(session._id)}
            onKill={() => handleAnimatedDismiss(session._id)}
            onRename={() => {
              handleSelect(session);
              useInboxStore.setState({ renamingSessionId: session._id });
            }}
          />
        )}
      </ContextMenu>
    </div>
  );
}


export const SessionListPanel = memo(SessionListPanelImpl);
SessionListPanel.displayName = "SessionListPanel";
