import React, { useState, useCallback, useEffect, useRef, memo, useMemo } from "react";
import { useWatchEffect } from "../hooks/useWatchEffect";
import { useMutation, useQuery } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { Id } from "@codecast/convex/convex/_generated/dataModel";
import { useRouter } from "next/navigation";
import { ConversationDiffLayout } from "./ConversationDiffLayout";
import { AppLoader } from "./AppLoader";
import { ConversationData } from "./ConversationView";
import { FormattedSummary } from "./FormattedSummary";
import { sessionCardSummary } from "../lib/sessionSummary";
import { sessionStartupState } from "../lib/sessionLifecycle";
import { compressImage } from "../lib/compressImage";
import { useConversationMessages } from "../hooks/useConversationMessages";
import { useInboxStore, useTrackedStore, InboxSession, InboxViewMode, flatViewComparator, flatViewSessions, chipMatchesSession, computeManualSortKey, getSessionRenderKey, isConvexId, categorizeSessions, partitionOldSessions, isInterruptControlMessage, getProjectName, isFork, convHasPendingSend, isAgentActive, sessionsWithPendingSend, isSessionHidden, resolveSessionAuthor, convBucketMap, groupSessionsForLabelView, groupSessionsByPlan, selectFavoriteSessions, sortLabels, computeChipCounts, BucketItem } from "../store/inboxStore";
import { sessionsWakeSig } from "../store/inboxStore";
import { useCoarseNow } from "../hooks/useCoarseNow";
import { isBlockedConversation, isSubagentConversation, nestParentIdOf } from "@codecast/convex/convex/ccAccountsShared";
import { isStatusTrustStale } from "@codecast/shared/contracts";
import { TooltipProvider } from "./ui/tooltip";
import { cleanTitle, msgCountColor, formatModel } from "../lib/conversationProcessor";
import { getLabelColor } from "../lib/labelColors";
import { fmtDuration, describeTaskCadence, taskStateLabel } from "./scheduleCadence";
import { partitionScheduleInbox, type ScheduleRow, type TaskRow } from "./scheduleTasks";
import { isMachineDeliveredMessage } from "./sessionMessage";
import { SharePopover } from "./SharePopover";
import { shareOrigin } from "../lib/utils";
import { PlanContextPanel } from "./PlanContextPanel";
import { WorkflowContextPanel } from "./WorkflowContextPanel";
import { toast } from "sonner";
import { animatedHideSession } from "../store/undoActions";
import { soundKill } from "../lib/sounds";
import { ShortcutTooltip } from "./KeyboardShortcutsHelp";
import { X, ChevronsLeft, ChevronsRight, ChevronRight, ChevronDown, List, Clock, Tag, GitFork, History, Star, Activity, Workflow } from "lucide-react";
import { FilterOptionList } from "./FilterDropdown";
import { LabelChipsRow } from "./LabelChipsRow";
import { TaskStatusBadge } from "./TaskStatusBadge";
import { useTipActions, checkMilestone } from "../tips";

const NOISE_PREFIXES = ["[Request interrupted", "This session is being continued", "Your task is to create a detailed summary", "Please continue the conversation", "<task-notification>", "Implement the following plan", "[Codecast import]", 'Background agent "'];

const NOISE_PATTERNS = [
  /toolu_[A-Za-z0-9_-]+/,
  /\/private\/tmp\/claude/,
  /\/tmp\/claude-\d+\//,
  /\.output<\/out/,
  /tasks\/[a-z0-9]+\.output/,
];

export function cleanUserMessage(raw: string | null | undefined): string | null {
  if (!raw) return null;
  // A machine-delivered message (cast send, or an inter-agent teammate broadcast) isn't the
  // user's own prompt — skip it so it never surfaces as the sticky fallback or card preview.
  if (isMachineDeliveredMessage(raw)) return null;
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
      <AppLoader className="min-h-0 h-full bg-transparent" size={32} />
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
// (signed out / rate-limited mid-turn). A distinct amber pill — "login" with a
// key glyph for auth banners, "limit" with an hourglass for usage-limit banners
// — set apart from the plain status dots so a stuck session reads at a glance.
// Shared by both SessionCard variants.
function AuthErrorBadge({ kind }: { kind?: string | null }) {
  // Only the account-is-the-problem kinds get a badge. kind "error" (transient
  // 529/500 provider failures) self-heals on the next message — badging it
  // paints a healthy session as blocked.
  if (kind !== "limit" && kind !== "auth") return null;
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

// When several sessions are parked on an API-error banner at once (the classic
// "the whole fleet hit the Max usage limit together"), surface ONE fleet-level
// action instead of N per-card errors: nudge them all with "continue" (right
// after the limit window resets), or switch the machine to another saved CC
// account and revive them on it. The daemon does the heavy lifting — swaps the
// keychain credential, recycles the blocked processes (they hold the old
// account's token in memory), then queues the continues; see
// convex/accountSwitch.ts. Profiles come from the daemon heartbeat
// (cast accounts save <name> to create them). Own component so its account
// query stays out of the hot panel render.
function BlockedSessionsBanner({
  blocked,
  onOpen,
}: {
  blocked: InboxSession[];
  onOpen?: (session: InboxSession) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [includeSubs, setIncludeSubs] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const continueAll = useMutation(api.accountSwitch.continueAllBlocked);
  const requestSwitch = useMutation(api.accountSwitch.requestAccountSwitch);
  const acknowledgeMutation = useMutation(api.accountSwitch.acknowledgeBlocked);
  const router = useRouter();
  // The X is a durable, cross-device snooze (24h) — a banner that resurrects
  // on every reload isn't dismissible. Permanent removal is per-session:
  // acknowledge clears the flag itself.
  const clientStateInitialized = useInboxStore((st) => st.clientStateInitialized);
  const snoozedTs = useInboxStore((st) => st.clientState.dismissed?.blocked_sessions_banner ?? 0);
  const promoDismissed = useInboxStore((st) => st.clientState.dismissed?.cc_accounts_promo ?? false);
  const updateDismissed = useInboxStore((st) => st.updateClientDismissed);
  const accountData = useQuery(api.accountSwitch.listAccountProfiles, blocked.length >= 2 ? {} : "skip");

  const snoozed = snoozedTs > 0 && Date.now() - snoozedTs < 24 * 60 * 60 * 1000;
  if (!clientStateInitialized || blocked.length < 2 || snoozed) return null;

  // Subagent workers default OUT of the acted set: their parent has usually
  // moved on, so reviving them spends the fresh account on work nobody is
  // waiting for. Same predicate the server selection uses, so the counts on
  // the buttons are exactly what the mutations will touch.
  const subagents = blocked.filter(isSubagentConversation);
  const acted = includeSubs ? blocked : blocked.filter((sess) => !isSubagentConversation(sess));
  const authCount = acted.filter((sess) => sess.pending_api_error_kind === "auth").length;
  const limitCount = acted.length - authCount;
  // Newest-flagged first — the same order the revive acts on (and the order
  // that answers "which sessions?" most usefully: fresh casualties on top).
  const blockedSorted = [...blocked].sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0));

  // Switch targets: saved profiles that aren't the active account on their
  // device, deduped by name (the same profile may exist on several machines).
  const switchTargets: { name: string; email?: string }[] = [];
  for (const device of accountData?.devices ?? []) {
    for (const p of device.profiles) {
      if (p.email && device.active_email && p.email === device.active_email) continue;
      if (!switchTargets.some((t) => t.name === p.name)) switchTargets.push({ name: p.name, email: p.email });
    }
  }

  const handleContinueAll = async () => {
    setBusy("continue");
    try {
      const res = await continueAll({ include_subagents: includeSubs });
      toast.success(`Queued "continue" to ${res.continued} blocked session${res.continued === 1 ? "" : "s"}`);
      updateDismissed("blocked_sessions_banner", Date.now());
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to queue continues");
    } finally {
      setBusy(null);
    }
  };

  const handleSwitch = async (profile: string) => {
    setBusy(profile);
    try {
      const res = await requestSwitch({ profile, include_subagents: includeSubs });
      toast.success(
        `Switching to "${profile}" — ${res.conversations} blocked session${res.conversations === 1 ? "" : "s"} will restart on it` +
          (res.unreachable > 0 ? ` (${res.unreachable} unreachable: daemon offline)` : ""),
      );
      updateDismissed("blocked_sessions_banner", Date.now());
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Account switch failed");
    } finally {
      setBusy(null);
    }
  };

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
    <div className="m-2 rounded-md border border-amber-500/30 bg-amber-500/[0.06] px-3 py-2.5">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <button
            onClick={() => setExpanded((v) => !v)}
            className="flex items-center gap-1 text-xs font-semibold text-sol-text hover:text-amber-500 transition-colors"
            title={expanded ? "Hide the affected sessions" : "Show which sessions are blocked"}
          >
            <ChevronRight className={`h-3 w-3 shrink-0 transition-transform ${expanded ? "rotate-90" : ""}`} />
            {blocked.length} sessions blocked on {authCount > 0 && limitCount === 0 ? "login" : "usage limits"}
            {subagents.length > 0 && (
              <span className="font-normal text-sol-text-dim">({subagents.length} subagents)</span>
            )}
          </button>
          <div className="mt-0.5 text-[11px] leading-snug text-sol-text-muted">
            {limitCount > 0 && <span>{limitCount} hit a usage limit</span>}
            {limitCount > 0 && authCount > 0 && <span> · </span>}
            {authCount > 0 && <span>{authCount} signed out</span>}
            <span>
              {" "}— continue them all once the limit resets
              {switchTargets.length > 0 ? ", or switch accounts and resume now" : ""}.
              {acted.length > 30 ? " Revives run on the 30 most recent per pass." : ""}
            </span>
          </div>
          {subagents.length > 0 && (
            <label className="mt-1 flex w-fit cursor-pointer items-center gap-1.5 text-[11px] text-sol-text-dim hover:text-sol-text">
              <input
                type="checkbox"
                checked={includeSubs}
                onChange={(e) => setIncludeSubs(e.target.checked)}
                className="h-3 w-3 accent-amber-500"
              />
              include {subagents.length} subagent worker{subagents.length === 1 ? "" : "s"}
              <span className="text-sol-text-dim/70">— skipped by default; their parent has likely moved on</span>
            </label>
          )}
        </div>
        <button
          onClick={() => updateDismissed("blocked_sessions_banner", Date.now())}
          className="shrink-0 rounded p-0.5 text-sol-text-dim hover:bg-sol-bg-alt hover:text-sol-text"
          title="Hide for 24h (use 'Dismiss all permanently' to clear these for good)"
          aria-label="Snooze this banner"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
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
                <AuthErrorBadge kind={sess.pending_api_error_kind} />
                <span className={`min-w-0 flex-1 truncate text-[11px] ${isSubagentConversation(sess) && !includeSubs ? "text-sol-text-dim" : "text-sol-text"}`}>
                  {cleanTitle(sess.title || "") || "Untitled session"}
                </span>
                {isSubagentConversation(sess) && (
                  <span className="shrink-0 rounded border border-sol-border/50 px-1 text-[9px] text-sol-text-dim" title="Subagent worker — excluded from revive unless included above">
                    sub
                  </span>
                )}
                <span className="shrink-0 text-[10px] text-sol-text-dim">{getProjectName(sess.git_root, sess.project_path)}</span>
                <span className="shrink-0 text-[10px] tabular-nums text-sol-text-dim">
                  {fmtDuration(Date.now() - (sess.updated_at ?? Date.now()))} ago
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
      {switchTargets.length === 0 && !promoDismissed && accountData !== undefined && (
        <div className="mt-2 rounded border border-sol-cyan/20 bg-sol-cyan/[0.05] px-2.5 py-2 text-[11px] leading-snug text-sol-text-muted">
          <span className="font-medium text-sol-text">Tip:</span> save a second Claude account once and
          next time the limit hits you can switch the whole fleet and revive everything instantly — no
          waiting for the reset.
          <div className="mt-1.5 flex items-center gap-2">
            <button
              onClick={() => router.push("/settings/claude-accounts")}
              className="rounded bg-sol-cyan/15 px-2 py-0.5 font-semibold text-sol-cyan hover:bg-sol-cyan/25 transition-colors"
            >
              Set up account switching
            </button>
            <button
              onClick={() => updateDismissed("cc_accounts_promo", true)}
              className="text-sol-text-dim hover:text-sol-text transition-colors"
            >
              No thanks
            </button>
          </div>
        </div>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {acted.length > 0 && switchTargets.map((target) => (
          <button
            key={target.name}
            onClick={() => handleSwitch(target.name)}
            disabled={busy !== null}
            title={target.email ? `Switch every new/blocked session to ${target.email}` : undefined}
            className="rounded bg-amber-500/15 px-2.5 py-1 text-[11px] font-semibold text-amber-500 transition-colors hover:bg-amber-500/25 disabled:opacity-60"
          >
            {busy === target.name ? "Switching…" : `Switch to ${target.name} & continue ${acted.length}`}
          </button>
        ))}
        {limitCount > 0 && (
          <button
            onClick={handleContinueAll}
            disabled={busy !== null}
            title="Send 'continue' to each blocked session (no account change)"
            className={`rounded px-2.5 py-1 text-[11px] font-semibold transition-colors disabled:opacity-60 ${
              switchTargets.length > 0
                ? "text-sol-text-dim hover:text-sol-text"
                : "bg-amber-500/15 text-amber-500 hover:bg-amber-500/25"
            }`}
          >
            {busy === "continue" ? "Queueing…" : `Continue all ${limitCount}`}
          </button>
        )}
        <button
          onClick={() => handleAcknowledge(blocked.map((sess) => sess._id))}
          disabled={busy !== null}
          title="Never restart these — clear all of them from the blocked set permanently"
          className="ml-auto rounded px-2 py-1 text-[11px] text-sol-text-dim hover:text-sol-text transition-colors disabled:opacity-60"
        >
          Dismiss all {blocked.length} permanently
        </button>
      </div>
    </div>
  );
}

// A slim schedule bar rendered UNDER its session card — stacked when the
// session has several, the way subagent rows stack under a parent. This is the
// roomy replacement for the old cramped countdown chip: the schedule's name,
// cadence, and live state get a whole line instead of competing with the
// card's chip row. Bars appear wherever the owning card renders (an escalated
// run, a loop you're driving, a once follow-up on an ordinary conversation).
// Click selects the owning session — the strip above the conversation carries
// the full prompt and controls.
function ScheduleBarRow({ task, unread, onClick }: { task: TaskRow; unread?: boolean; onClick: () => void }) {
  const now = useCoarseNow(30_000);
  const paused = task.status === "paused";
  const stateLabel = taskStateLabel(task, now);
  return (
    <button
      onClick={onClick}
      title={task.prompt}
      className="w-full flex items-center gap-1.5 pl-7 pr-3 py-1 text-left bg-sol-orange/[0.045] hover:bg-sol-orange/10 border-t border-sol-border/20 transition-colors min-w-0"
    >
      <svg className="w-2.5 h-2.5 shrink-0 text-sol-orange" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7.5V12l3 2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span className="text-[10px] text-sol-text-dim truncate min-w-0">{task.title}</span>
      {unread && <span className="w-1 h-1 rounded-full bg-sol-orange shrink-0" />}
      <span className="ml-auto shrink-0 text-[9px] text-sol-text-dim">{describeTaskCadence(task)}</span>
      <span
        className={`shrink-0 inline-flex items-center px-1 py-0 rounded text-[9px] font-semibold tabular-nums border ${
          paused
            ? "bg-sol-bg-alt text-sol-text-dim border-sol-border/50"
            : task.status === "running"
              ? "bg-sol-green/10 text-sol-green border-sol-green/30"
              : "bg-sol-orange/10 text-sol-orange border-sol-orange/30"
        }`}
      >
        {stateLabel}
      </span>
    </button>
  );
}

// -- The SCHEDULES section (every armed schedule, schedule-first) --

// One row per armed schedule — recurring, once, or event; inject or spawn; no
// distinction the user must learn. The row IS the schedule's identity in the
// inbox: name, cadence, live countdown, last outcome, lightweight verbs.
// Clicking opens the conversation behind it (home session or latest run — the
// dismissed-peek path handles folded runs). Everything a schedule does stays
// behind its row; escalations and human-driven turns are ordinary cards.
function ScheduleRowItem({ row, activeSessionId, onOpen }: {
  row: ScheduleRow;
  activeSessionId?: string | null;
  onOpen: (convId: string) => void;
}) {
  const { task, unread } = row;
  const now = useCoarseNow(30_000);
  const pause = useMutation(api.agentTasks.webPause);
  const resume = useMutation(api.agentTasks.webResume);
  const runNow = useMutation(api.agentTasks.webRunNow);
  const paused = task.status === "paused";
  const stateLabel = taskStateLabel(task, now);
  const isActive = !!row.openId && row.openId === activeSessionId;
  return (
    <div className={`group/schedrow relative border-b border-sol-border/30 ${isActive ? "bg-sol-orange/[0.06]" : ""}`}>
      <button
        className="w-full text-left px-3 py-2 hover:bg-sol-bg-alt/60 transition-colors"
        onClick={() => row.openId && onOpen(row.openId)}
        title={task.prompt}
      >
        <div className="flex items-center gap-1.5 min-w-0">
          <svg className="w-3 h-3 shrink-0 text-sol-orange" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
            <circle cx="12" cy="12" r="9" />
            <path d="M12 7.5V12l3 2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span className="text-xs font-medium text-sol-text truncate min-w-0">{task.title}</span>
          {unread && <span className="w-1.5 h-1.5 rounded-full bg-sol-orange shrink-0" title="New outcome since you last opened this section" />}
          <span
            className={`ml-auto shrink-0 inline-flex items-center px-1 py-0 rounded text-[9px] font-semibold tabular-nums border ${
              paused
                ? "bg-sol-bg-alt text-sol-text-dim border-sol-border/50"
                : task.status === "running"
                  ? "bg-sol-green/10 text-sol-green border-sol-green/30"
                  : "bg-sol-orange/10 text-sol-orange border-sol-orange/30"
            }`}
          >
            {stateLabel}
          </span>
        </div>
        <div className="flex items-center gap-2 mt-0.5 text-[10px] text-sol-text-dim min-w-0">
          <span className="shrink-0">{describeTaskCadence(task)}</span>
          {task.mode === "apply" && <span className="shrink-0 text-sol-red/70">apply</span>}
          {task.run_count > 0 && <span className="shrink-0">{task.run_count} run{task.run_count === 1 ? "" : "s"}</span>}
          {task.last_run_summary && (
            <span className={`truncate min-w-0 ${task.last_run_failed ? "text-sol-red/80" : ""}`}>
              {task.last_run_summary}
            </span>
          )}
        </div>
      </button>
      {/* Hover verbs OVERLAY the row (absolute, solid backdrop) instead of
          inserting a line — appearing actions must never change the row's
          height or the whole list shifts under the cursor. */}
      <div className="hidden group-hover/schedrow:flex absolute right-2 bottom-1 z-10 items-center gap-1 rounded bg-sol-bg shadow-sm ring-1 ring-sol-border/40 p-0.5">
        <button
          onClick={(e) => { e.stopPropagation(); runNow({ task_id: task._id as Id<"agent_tasks"> }).catch(() => {}); toast.success("Run queued"); }}
          className="px-1.5 py-0.5 rounded text-[10px] font-medium text-sol-orange bg-sol-orange/10 hover:bg-sol-orange/20 border border-sol-orange/30 transition-colors"
        >
          Run now
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation();
            (paused ? resume({ task_id: task._id as Id<"agent_tasks"> }) : pause({ task_id: task._id as Id<"agent_tasks"> })).catch(() => {});
          }}
          className="px-1.5 py-0.5 rounded text-[10px] font-medium text-sol-text-dim bg-sol-bg-alt hover:bg-sol-bg-alt/70 border border-sol-border/50 transition-colors"
        >
          {paused ? "Resume" : "Pause"}
        </button>
      </div>
    </div>
  );
}

// The SCHEDULES section. Expanded: one ScheduleRowItem per armed schedule.
// Collapsed: the header itself is the briefing — count, soonest next fire, and
// how many outcomes landed since the section was last toggled ("N new").
// -- The schedule dock --
// The schedules' home. The session list stays a list of ONE kind of thing
// (conversations); every armed schedule lives in this single always-visible
// line docked under the list. The line is the briefing: how many are armed,
// when the next fires, how many outcomes landed since you last looked, and a
// red accent when one failed or flagged itself. Expanding opens a roster
// overlay of full schedule rows (same anatomy as /schedules); opening or
// closing marks the briefing read (schedules_seen_at).
function ScheduleDock({ rows, unreadCount, nextRunAt, activeSessionId, onOpen }: {
  rows: ScheduleRow[];
  unreadCount: number;
  nextRunAt?: number;
  activeSessionId?: string | null;
  onOpen: (convId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const now = useCoarseNow(30_000);
  if (rows.length === 0) return null;
  const nextIn = nextRunAt !== undefined ? Math.max(0, nextRunAt - now) : undefined;
  const attention = rows.some((r) => r.task.last_run_failed || r.task.last_run_needs_attention);
  const toggle = () => {
    useInboxStore.getState().updateClientUI({ schedules_seen_at: Date.now() });
    setOpen((o) => !o);
  };
  return (
    <div className="relative shrink-0 border-t border-sol-border/40">
      {open && (
        <div className="absolute bottom-full left-0 right-0 max-h-[55vh] overflow-y-auto bg-sol-bg border-t border-sol-border/60 shadow-[0_-8px_24px_rgba(0,0,0,0.18)] z-20">
          {rows.map((r) => (
            <ScheduleRowItem
              key={r.task._id}
              row={r}
              activeSessionId={activeSessionId}
              onOpen={(id) => { setOpen(false); onOpen(id); }}
            />
          ))}
        </div>
      )}
      <button onClick={toggle} className="w-full flex items-center gap-1.5 px-3 py-1.5 bg-sol-bg hover:bg-sol-bg-alt/60 transition-colors">
        <svg className={`w-3 h-3 shrink-0 ${attention ? "text-sol-red" : "text-sol-orange"}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7.5V12l3 2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span className="text-[10px] font-semibold uppercase tracking-wider text-sol-orange">
          Schedules ({rows.length})
        </span>
        {nextIn !== undefined && (
          <span className="text-[10px] text-sol-text-dim tabular-nums">· next {nextIn > 0 ? `in ${fmtDuration(nextIn)}` : "due"}</span>
        )}
        {unreadCount > 0 && (
          <span className="inline-flex items-center px-1.5 py-0 rounded-full text-[9px] font-semibold bg-sol-orange text-sol-bg">
            {unreadCount} new
          </span>
        )}
        {attention && <span className="text-[9px] font-semibold text-sol-red uppercase">attention</span>}
        <svg className={`ml-auto w-3 h-3 transition-transform text-sol-text-dim ${open ? "rotate-180" : ""}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
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
  variant = "default",
  forkColorKey,
  sessionLabel,
  isFavorite,
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
  variant?: "default" | "working" | "dismissed" | "stashed";
  forkColorKey?: string;
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
  useCoarseNow(30_000);
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
  const isSubagent = !!session.is_subagent || !!nestParentIdOf(session) || !!session.worktree_name;
  // Local-first "pending working": a message has been sent but the daemon
  // hasn't confirmed delivery yet (status not active). Reading the durable
  // pendingMessages map directly returns a stable boolean, so only this card
  // re-renders when its own pending state flips — not the whole list. Clears
  // the moment status goes active or the server echoes the message.
  const isPendingSend = useInboxStore((st) => convHasPendingSend(st.pendingMessages[session._id]));
  const isPendingWorking = isPendingSend && !isAgentActive(session);
  const showModelBadge = useInboxStore((st) => st.clientState?.ui?.show_model_badge === true);
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
  const cardSummary = sessionCardSummary(session);
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
  const isLive = !session.is_idle && session.message_count > 0 && !isStatusTrustStale(session, Date.now());

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
                : isStashed
                  ? "opacity-75 hover:opacity-100 hover:bg-violet-500/[0.04]"
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
            <svg className="w-3 h-3 text-violet-400/60 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5} role="img" aria-label="Subagent">
              <title>Subagent — child of its parent session</title>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 4v12h12" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M14 12l4 4-4 4" />
            </svg>
            <span className={`truncate text-xs leading-tight flex-1 ${
              isActive ? "text-violet-300 font-medium" : "text-gray-400 font-normal"
            }`}>
              {isSlashCommand ? <span className="font-mono text-violet-400/80">{displayTitle}</span> : displayTitle}
            </span>
            <div className="flex items-center gap-1 flex-shrink-0">
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
              {/* Reuse the staleness-aware isLive so an aged-out subagent row
                  stops pulsing green, matching the main card and the bucket. */}
              {isLive && !session.pending_api_error && !session.session_error && !session.is_unresponsive && !session.has_pending && (
                <span className="relative flex h-1.5 w-1.5" title="Live">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-sol-green opacity-75" />
                  <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-sol-green" />
                </span>
              )}
              {!isLive && !session.pending_api_error && !session.session_error && !session.is_unresponsive && !session.has_pending && session.message_count > 0 && (
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
            : isStashed
              ? "opacity-85 hover:opacity-100 hover:bg-sol-bg-alt/80"
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
          isActive ? "text-sm text-sol-text font-semibold" : isWorking ? "text-sm text-sol-text font-medium" : isStashed ? "text-sm text-sol-text" : isDismissed ? "text-sm text-sol-text-muted" : "text-sm text-sol-text"
        }`}>
          <span className="truncate min-w-0">{isSlashCommand ? <span className="font-mono text-sol-cyan">{displayTitle}</span> : displayTitle}</span>
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
        {session.message_count === 0 && !session.last_user_message && (() => {
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
            {/* Settled with content gets the gray idle dot. Keyed on !isLive (now
                staleness-aware) rather than the raw is_idle flag, so a frozen
                is_idle:false row that's really finished shows idle, not nothing. */}
            {!isWorking && !isLive && variant !== "dismissed" && !session.pending_api_error && !session.session_error && !session.is_unresponsive && !session.has_pending && !isPendingWorking && session.message_count > 0 && (
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
      {/* The ONE pin a pinned session shows: a persistent, interactive badge anchored
          top-right. It stays put on hover (z above the toolbar) and the hover toolbar
          omits its own pin button for pinned rows — so the pin never duplicates or
          cross-fades into a second copy. */}
      {onPin && session.is_pinned && (
        <div className="absolute top-0 right-0 py-1 pr-2 pointer-events-none z-[2]" style={{ paddingLeft: 24, background: isActive ? 'linear-gradient(to right, transparent, color-mix(in srgb, var(--sol-cyan) 15%, var(--sol-bg-alt)) 60%)' : 'linear-gradient(to right, transparent, var(--sol-bg-alt) 60%)' }}>
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
      {(onDismiss || onStash || onDefer || onPin) && (
        <div className={`absolute top-0 bottom-0 right-0 flex flex-col items-center justify-between py-1 opacity-0 group-hover:opacity-100 transition-opacity pl-16 pr-2 ${isActive ? '' : 'bg-gradient-to-r from-transparent via-sol-bg-alt/60 to-sol-bg-alt'}`} style={isActive ? { background: 'linear-gradient(to right, transparent, color-mix(in srgb, color-mix(in srgb, var(--sol-cyan) 15%, var(--sol-bg-alt)) 60%, transparent), color-mix(in srgb, var(--sol-cyan) 15%, var(--sol-bg-alt)))' } : undefined}>
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
                  className="p-1 rounded transition-colors text-sol-text-dim hover:text-sol-magenta"
                >
                  <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 17v5" />
                    <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76z" />
                  </svg>
                </button>
              </ShortcutTooltip>
            )
          )}
          {/* Dismiss — the PRIMARY remove: done with it, clears to the Dismissed
              group and stops the (usually idle) agent. Undoable. */}
          {onDismiss && (
            <ShortcutTooltip label="Dismiss — done, clears the inbox" action="session.kill" side="left">
              <button
                onClick={(e) => { e.stopPropagation(); onDismiss(session._id); }}
                className="p-1 rounded text-sol-text-dim hover:text-sol-red hover:bg-sol-red/10 transition-colors"
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
              className="p-1 rounded text-sol-text-dim hover:text-sol-blue transition-colors"
            >
              <Tag className="w-3.5 h-3.5" />
            </button>
          </ShortcutTooltip>
          {/* Stash — the SECONDARY remove: set aside, agent keeps running. */}
          {onStash && (
            <ShortcutTooltip label="Stash — set aside, keeps running" action="session.stash" side="left">
              <button
                onClick={(e) => { e.stopPropagation(); onStash(session._id); tipActions.whisper('session.stash', e); }}
                className="p-1 rounded text-sol-text-dim hover:text-sol-yellow transition-colors"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 7l10 10M17 17h-6m6 0v-6" />
                </svg>
              </button>
            </ShortcutTooltip>
          )}
        </div>
      )}
      {(onRestore || onKill) && (
        <div className="absolute top-1.5 right-1.5 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
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
    s => s.clientState.show_stashed,
    s => s.liveInboxIds,
    // Wake only on STRUCTURAL session change (bucket/order/identity), not on every
    // ~1s liveness heartbeat. Subscribing to the raw s.sessions map re-rendered the
    // whole panel (categorize O(N) + 100 cards) ~17x/sec with 17 live sessions —
    // measured ~70% idle main-thread. The body still reads s.sessions for the data;
    // this only gates the re-render. Time-driven reclassification is preserved by
    // the coarseNow dep on the categorize memo below. See store/wakeSig.ts.
    s => sessionsWakeSig(s.sessions),
    s => s.sessionsWithQueuedMessages,
    s => s.pendingMessages,
    s => s.activeProjectFilter,
    s => s.activeBucketFilter,
    s => s.buckets,
    s => s.bucketAssignments,
    s => s.collapsedSections,
    s => s.currentSessionId,
    s => s.pendingSessionCreates,
    s => s.showFavorites,
    s => s.favorites,
    s => s.recentFreezeOrder,
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
  // "Show old sessions" is a pure client-side filter (default: show). "Old" =
  // a cached top-level session the live (recent) subscription no longer returns
  // — the completeness crawl keeps it in the never-prune cache, so hiding it is
  // a render decision, never a server re-fetch. liveInboxIds is empty until the
  // first live payload lands; treat that as "nothing to hide yet" so we never
  // blank the list. Optimistic stubs (non-Convex id), pinned, the open session,
  // and dismissed/stashed rows are always kept.
  const showAllSessions = s.clientState.ui?.show_old_sessions ?? true;
  const focusedId = activeSessionId ?? s.currentSessionId;
  // The wake signature ignores updated_at, so the panel no longer re-renders on
  // every heartbeat. categorizeSessions still retires a stale "working" to
  // needs-input by comparing updated_at to Date.now() (the trust-TTL sweep), which
  // is time-driven, not field-driven — so feed it a coarse clock to keep that
  // sweep alive without coupling it back to heartbeat churn. 15s is well under the
  // minutes-scale TTL. See useCoarseNow / store/wakeSig.ts.
  const coarseNow = useCoarseNow(15_000);
  const { visibleSessions, oldCount } = useMemo(
    () => partitionOldSessions(s.sessions, s.liveInboxIds, showAllSessions, focusedId),
    [s.sessions, s.liveInboxIds, showAllSessions, focusedId],
  );

  const { sorted: sortedSessions, pinned, newSessions, needsInput, working, stashed: stashedList, dismissed: dismissedList, subsByParent: globalSubByParent, forksByParent: globalForksByParent } = useMemo(
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
  // live in partitionScheduleInbox.
  const scheduleTasks = useQuery(api.agentTasks.webList, {}) as TaskRow[] | undefined;
  const schedulesSeenAt = s.clientState.ui?.schedules_seen_at ?? 0;
  const schedulePartition = useMemo(
    () => partitionScheduleInbox(scheduleTasks, visibleSessions, {
      sessionsWithQueuedMessages: s.sessionsWithQueuedMessages,
      seenAt: schedulesSeenAt,
    }),
    [scheduleTasks, visibleSessions, s.sessionsWithQueuedMessages, schedulesSeenAt],
  );
  // Kill-gesture handlers read the partition through a ref so their identities
  // stay stable (SessionCard is memoized on them).
  const schedulePartitionRef = useRef(schedulePartition);
  schedulePartitionRef.current = schedulePartition;
  // Publish the absorbed set for keyboard nav (computeVisualOrder reads it from
  // the store). Content-keyed so Set identity churn from recomputes doesn't
  // spam store notifications.
  const navSetsKey = useMemo(
    () => [...schedulePartition.absorbedIds].sort().join(","),
    [schedulePartition.absorbedIds],
  );
  useEffect(() => {
    useInboxStore.getState().setScheduleNavSets({ absorbed: schedulePartition.absorbedIds });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navSetsKey]);

  // Corner shown when the session is in a fork tree (has forks, or is one);
  // colored by the tree's root so the whole tree matches.
  const forkColorKeyOf = useCallback(
    (session: InboxSession) =>
      session.forked_from || globalForksByParent.has(session._id)
        ? forkTreeRootId(session, s.sessions)
        : undefined,
    [s.sessions, globalForksByParent],
  );

  const activeSessions = useMemo(() => [...pinned, ...newSessions, ...needsInput, ...working], [pinned, newSessions, needsInput, working]);

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
        chipMatchesSession(sess, { projectFilter: s.activeProjectFilter, bucketFilter: s.activeBucketFilter, bucketByConv }),
      ),
    [s.activeProjectFilter, s.activeBucketFilter, bucketByConv],
  );

  const filteredPinned = useMemo(() => filterByChip(pinned), [filterByChip, pinned]);
  const filteredNew = useMemo(() => filterByChip(newSessions), [filterByChip, newSessions]);
  const filteredNeedsInput = useMemo(() => filterByChip(needsInput), [filterByChip, needsInput]);
  const filteredWorking = useMemo(() => filterByChip(working), [filterByChip, working]);
  // STATUS view only: sessions absorbed behind a SCHEDULES row leave the
  // triage buckets (reachable by clicking the row). The label/plan lenses keep
  // the plain chip-filtered lists — they don't render the schedule section, so
  // nothing may vanish there. Mirrors visualOrderSessions so Ctrl+J/K walks
  // exactly what's on screen.
  const statusNeedsInput = useMemo(
    () => filteredNeedsInput.filter((sess) => !schedulePartition.absorbedIds.has(sess._id)),
    [filteredNeedsInput, schedulePartition.absorbedIds],
  );
  const statusWorking = useMemo(
    () => filteredWorking.filter((sess) => !schedulePartition.absorbedIds.has(sess._id)),
    [filteredWorking, schedulePartition.absorbedIds],
  );
  // Schedule rows honor the project chip like session cards do.
  const scheduleRowsView = useMemo(
    () =>
      s.activeProjectFilter
        ? schedulePartition.rows.filter(
            (r) => getProjectName(undefined, r.task.project_path) === s.activeProjectFilter,
          )
        : schedulePartition.rows,
    [schedulePartition.rows, s.activeProjectFilter],
  );
  // A schedule row opens the conversation behind it — the loop's home session
  // or the newest run; the dismissed-peek path handles folded runs.
  // Opening FROM a schedule surface (dock row, bar under a card) also asks the
  // conversation's schedule strip to arrive expanded — the click means "show me
  // this schedule", so the prompt should be visible without a second click.
  const openScheduleTarget = useCallback((convId: string) => {
    const sess = useInboxStore.getState().sessions[convId];
    if (!sess) return;
    useInboxStore.getState().setScheduleStripExpand({ convId, nonce: Date.now() });
    handleSelect(sess);
  }, [handleSelect]);
  // Schedule bars under cards: the schedules bound to a VISIBLE session — the
  // ones it originates (inject, any type) plus, for a run card, the schedule
  // that spawned it. Keyed off partition.rows so bars share the unread state.
  const scheduleBarRowsFor = useCallback((sess: InboxSession): ScheduleRow[] => {
    const rows = schedulePartitionRef.current.rows;
    const out: ScheduleRow[] = [];
    for (const r of rows) {
      if (
        r.task.originating_conversation_id === sess._id ||
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

  // Sessions parked on a limit/auth banner — the fleet-level revive banner's
  // input. isBlockedConversation is the SAME predicate the server selection
  // uses (limit/auth kinds only — transient 500s never count — claude only,
  // dismissed excluded), plus the same 48h window, so the count shown always
  // matches what a revive would act on.
  const blockedSessions = useMemo(() => {
    const since = Date.now() - 48 * 60 * 60 * 1000;
    return (Object.values(s.sessions) as InboxSession[]).filter(
      (sess) =>
        isBlockedConversation({ ...sess, agent_type: sess.agent_type ?? "claude_code" }) &&
        !isSessionHidden(sess) &&
        (sess.updated_at ?? 0) > since,
    );
  }, [s.sessions]);

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
          chipMatchesSession(sess, { projectFilter: s.activeProjectFilter, bucketFilter: s.activeBucketFilter, bucketByConv }),
      }),
    [sortedSessions, showSubagents, globalSubByParent, activeSessionId, viewMode, manualOrder, recentFreezeOrder, s.activeProjectFilter, s.activeBucketFilter, bucketByConv],
  );
  const totalSubagentCount = useMemo(() => {
    let count = 0;
    for (const subs of globalSubByParent.values()) count += subs.length;
    return count;
  }, [globalSubByParent]);

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
    // Absorbed-filtered lists: the label view renders the SCHEDULES section too,
    // so sessions resting behind a schedule row must not double-render in groups.
    return groupSessionsForLabelView(
      [...filteredNew, ...statusNeedsInput, ...statusWorking],
      s.buckets,
      bucketByConv,
    );
  }, [viewMode, filteredNew, statusNeedsInput, statusWorking, bucketByConv, s.buckets]);

  // "By plan" lens — same active set as the bucket view (status buckets dissolved
  // back to flat), regrouped by plan instead of label. Every plan shows, even a
  // plan of one; sessions with no plan fall to project groups. This lens is the
  // ONLY place the inbox groups by plan — the status view keeps every session in
  // its status bucket.
  const planView = useMemo(() => {
    if (viewMode !== "plan") return null;
    return groupSessionsByPlan(
      [...filteredNew, ...statusNeedsInput, ...statusWorking],
    );
  }, [viewMode, filteredNew, statusNeedsInput, statusWorking]);
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
      ? allFavorites.filter((x) => getProjectName(x.git_root, x.project_path) === s.activeProjectFilter)
      : allFavorites;
    const pinned = scoped.filter((x) => x.is_pinned).sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0));
    const rest = scoped.filter((x) => !x.is_pinned);
    const { projectGroups } = groupSessionsForLabelView(rest, {}, {});
    return { pinned, projectGroups, count: scoped.length };
  }, [favoritesView, allFavorites, s.activeProjectFilter]);
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
    // flatList is exactly the on-screen "time" order; neighbor keys come from it.
    const rest = flatList.filter((sess) => sess._id !== draggedId);
    const restKeys = rest.map((sess) => manualOrder?.[sess._id] ?? sess.started_at ?? sess.updated_at ?? 0);
    const targetIdx = rest.findIndex((sess) => sess._id === targetId);
    if (targetIdx < 0) return;
    const insertIndex = pos === "before" ? targetIdx : targetIdx + 1;
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
        { description: "It keeps firing here quietly, without pulling the session back into your queue. Dismiss or kill would cancel it.", duration: 8000 },
      );
    }
  }, []);
  // Killing a session cancels the schedules that inject into it (server side,
  // on the hide transition) — surface that side effect instead of letting the
  // loop die silently: a toast names the schedule and offers to keep it armed,
  // and undo-of-kill re-arms it along with the session. Reads the partition
  // through a ref so the handlers stay referentially stable for SessionCard.
  const reactivateTask = useMutation(api.agentTasks.webReactivate);
  const killWithScheduleNotice = useCallback((id: string) => {
    const armed = schedulePartitionRef.current.armedInjectByConv.get(id);
    const revive = armed?.length
      ? () => { for (const t of armed) reactivateTask({ task_id: t._id as Id<"agent_tasks"> }).catch(() => {}); }
      : undefined;
    animatedHideSession(id, "kill", revive ? { onUndo: revive } : undefined);
    if (armed?.length && revive) {
      toast(
        armed.length === 1
          ? `Also canceled schedule "${armed[0].title}"`
          : `Also canceled ${armed.length} schedules bound to this session`,
        {
          description: "Its next fire would have revived the session you just killed.",
          duration: 10000,
          action: { label: "Keep schedule", onClick: () => { revive(); toast.success("Schedule re-armed — it will revive this session on its next fire"); } },
        },
      );
    }
  }, [reactivateTask]);
  // Dismiss: "done with it" — clears the session from the inbox into the Dismissed
  // group. The server tears the (usually idle) agent down on the inbox_dismissed_at
  // transition, so this is codecast's kill gesture, surfaced as the PRIMARY remove
  // action. Undoable via the toast.
  const handleAnimatedDismiss = useCallback((id: string) => {
    killWithScheduleNotice(id);
  }, [killWithScheduleNotice]);
  // On a stashed card the destructive slot kills (server tears the agent down
  // on the transition) — the row moves down into Killed.
  const handleKillStashed = useCallback((id: string) => {
    killWithScheduleNotice(id);
  }, [killWithScheduleNotice]);
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
    useInboxStore.getState().killSessions(ids);
    toast.success(`Killed ${ids.length} stashed session${ids.length === 1 ? "" : "s"}`);
  }, [killAllArmed, filteredStashed]);

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
        : [
            [filteredPinned, "pinned"], [filteredNew, "new"],
            [statusNeedsInput, "needs_input"], [statusWorking, "working"],
          ];
    for (const [items, key] of sections) {
      if (inList(items) && s.collapsedSections[key]) {
        s.toggleCollapsedSection(key);
        return;
      }
    }
    if (inList(filteredStashed) && s.clientState.show_stashed !== true) {
      s.toggleShowStashed();
      return;
    }
    if (inList(filteredDismissed) && s.clientState.show_dismissed !== true) {
      s.toggleShowDismissed();
    }
  }, [activeSessionId, sortedSessions, s.collapsedSections, s.clientState.show_dismissed, s.clientState.show_stashed, viewMode]);

  // Shared renderer for the two hidden buckets at the bottom of the list —
  // Stashed (set aside, agent alive) above Killed (retired, agent torn down;
  // the persisted flag keeps its historical name inbox_dismissed_at).
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
                  onRestore={s.restoreSession}
                  onKill={onKill}
                  variant={variant}
                  forkColorKey={forkColorKeyOf(session)}
                  sessionLabel={labelByConv[session._id] ?? null}
                  isFavorite={cardIsFavorite(session)}
                />
                {(subMap.get(session._id) ?? []).filter((sub) => showSubagents || sub._id === activeSessionId).map((sub) => (
                  <SessionCard
                    key={sub._id}
                    session={sub}
                    isActive={sub._id === activeSessionId}
                    isParentActive={session._id === activeSessionId}
                    globalIndex={-1}
                    onSelect={handleSelect}
                    onRestore={s.restoreSession}
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
          className="w-full px-3 py-1.5 bg-sol-bg border-b border-sol-border/30 flex items-center justify-between gap-2"
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
                  onSelect={handleSelect}
                  onDismiss={handleAnimatedDismiss}
                  onStash={handleAnimatedStash}
                  onDefer={s.deferSession}
                  onPin={s.pinSession}
                  variant={sectionVariant || "default"}
                  forkColorKey={forkColorKeyOf(session)}
                  sessionLabel={labelByConv[session._id] ?? null}
                  isFavorite={cardIsFavorite(session)}
                />
                {/* Schedule bars stack under their card the way subagent rows
                    do — full-width room for name/cadence/countdown instead of
                    a cramped chip. Click selects the session with its schedule
                    strip pre-expanded (openScheduleTarget). */}
                {scheduleBarRowsFor(session).map((r) => (
                  <ScheduleBarRow key={r.task._id} task={r.task} unread={r.unread} onClick={() => openScheduleTarget(session._id)} />
                ))}
                {visibleSubs.map((sub) => (
                  <SessionCard
                    key={sub._id}
                    session={sub}
                    isActive={sub._id === activeSessionId}
                    isParentActive={session._id === activeSessionId}
                    globalIndex={0}
                    onSelect={handleSelect}
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
    <div className="h-full w-full flex flex-col bg-sol-bg-alt overflow-hidden">
      <div className="px-3 py-0.5 sm:py-1 border-b border-sol-border/50 flex-shrink-0 flex items-center gap-2 min-h-[31px] min-w-0">
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
          <div className="flex items-center flex-shrink-0 rounded-md border border-sol-border/40 bg-sol-bg/70 p-px">
          {!favoritesView && <>
          {(() => {
            const viewModeOptions = [
              { key: "grouped", label: "By status", icon: List },
              { key: "recent", label: "By updated", icon: Activity },
              { key: "time", label: "By created", icon: Clock },
              ...(visibleBuckets.length > 0 ? [{ key: "bucket", label: "By label", icon: Tag }] : []),
              ...(hasPlanSessions ? [{ key: "plan", label: "By plan", icon: Workflow }] : []),
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
                  <div className="absolute top-full right-0 mt-1 w-48 bg-sol-bg border border-sol-border rounded-lg shadow-xl z-[60] py-1">
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
          {(totalSubagentCount > 0 || oldCount > 0) && (
            <div className="w-px h-3 bg-sol-border/40" />
          )}
          {totalSubagentCount > 0 && (
            <button
              onClick={() => s.updateClientUI({ show_subagents: !showSubagents })}
              title={showSubagents ? `Hide ${totalSubagentCount} subagent sessions` : `Show ${totalSubagentCount} subagent sessions`}
              className={`px-1 py-[3px] rounded-[5px] transition-colors ${
                showSubagents
                  ? "bg-sol-violet/15 text-sol-violet"
                  : "text-sol-text-dim/70 hover:text-sol-text"
              }`}
            >
              <GitFork className="w-3 h-3" />
            </button>
          )}
          {oldCount > 0 && (
            <button
              onClick={() => s.updateClientUI({ show_old_sessions: !showAllSessions })}
              title={showAllSessions ? `Hide ${oldCount} old session${oldCount === 1 ? "" : "s"}` : `Show ${oldCount} old session${oldCount === 1 ? "" : "s"}`}
              className={`px-1 py-[3px] rounded-[5px] transition-colors ${
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
            className={`px-1 py-[3px] rounded-[5px] transition-colors ${
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
      <div ref={scrollContainerRef} className="flex-1 overflow-y-auto scrollbar-auto">
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
                {s.activeProjectFilter ? "No favorites in this project" : "No favorites yet"}
              </div>
              <div className="text-[11px] text-sol-text-dim max-w-[220px] leading-relaxed">
                {s.activeProjectFilter
                  ? "Clear the project filter to see every kept session."
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
        <BlockedSessionsBanner blocked={blockedSessions} onOpen={handleSelect} />
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
        ) : viewMode === "plan" && planView ? (
        <>
        {!s.activeProjectFilter && !s.activeBucketFilter && <NeedsAttentionSection />}
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
        ) : (
        <>
        {!s.activeProjectFilter && !s.activeBucketFilter && <NeedsAttentionSection />}
        {renderSection("Pinned", filteredPinned, "text-sol-magenta")}
        {renderSection("New", filteredNew, "text-sol-blue")}
        {renderSection("Needs Input", statusNeedsInput, "text-sol-yellow")}
        {renderSection("Working", statusWorking, "text-sol-green", "working")}
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
          expanded: s.clientState.show_stashed === true,
          onToggle: s.toggleShowStashed,
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
          label: "Killed",
          items: filteredDismissed,
          expanded: s.clientState.show_dismissed === true,
          onToggle: s.toggleShowDismissed,
          variant: "dismissed",
          onKill: handleKillDismissed,
        })}
        </>)}
      </div>
      {/* The schedule dock is panel chrome, not list content: it renders under
          the scroll area in EVERY view mode — the robots' one home. */}
      <ScheduleDock
        rows={scheduleRowsView}
        unreadCount={schedulePartition.unreadCount}
        nextRunAt={schedulePartition.nextRunAt}
        activeSessionId={activeSessionId}
        onOpen={openScheduleTarget}
      />
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

// -- ConversationColumn (session panel for non-inbox pages) --

export const ConversationColumn = memo(function ConversationColumn() {
  const s = useTrackedStore([
    s => s.sidePanelSessionId,
    // Only this one row is read below — subscribe to it, not the whole map, so a
    // heartbeat on any OTHER session doesn't re-render the side panel.
    s => s.sessions[s.sidePanelSessionId ?? ""],
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
    if (s.sidePanelSessionId) animatedHideSession(s.sidePanelSessionId, "stash");
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
