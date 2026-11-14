import React, { useState, useMemo } from "react";
import { SessionWorkProject } from "../projects/SessionWorkProject";
import { SessionTaskChip } from "../work/SessionTaskChip";
import { Pin, Star, Clock, EyeOff, Workflow } from "lucide-react";
import { runHref } from "../../lib/decisionLinks";
import Link from "next/link";
import { withSafetyBlock, isStashHidden, type UserRest } from "@codecast/shared/contracts";
import { NOTICE_DOT, NOTICE_ROW_WORD } from "../../lib/hostedNotice";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { drawsNested, formatIdleDuration, formatRowTime, sessionCardTitle } from "../../lib/sessionCard";
import { isHostedAgentType } from "@codecast/shared/contracts";
import { AvatarImg } from "../../lib/avatarCache";
import { ImageLightbox } from "../ImageGallery";
import { FormattedSummary } from "../FormattedSummary";
import { sessionCardSummary } from "../../lib/sessionSummary";
import { isHandoffFrom } from "../../lib/sessionHandoff";
import { threadStateView, THREAD_STATE_PIN_CLASS, THREAD_STATE_STATUS_META } from "../../lib/threadState";
import { getProjectName, isFork, isAgentActive, showsBlockedBadge } from "../../store/inboxStore";
import { msgCountColor, formatModel } from "../../lib/conversationProcessor";
import { ViewerFaces } from "../presence/ViewerFaces";
import { DeviceIcon, deviceDisplayName } from "../DeviceBadge";
import { SessionWorktreeChip } from "../SessionWorktreeChip";
import { SubagentFleetChip } from "../SubagentFleetChip";
import { cleanUserMessage } from "../sessionMessage";
import { AgentTypeIcon, formatAgentType } from "../AgentTypeIcon";
import { AnchorScopePill, HeadOfPeopleFace } from "../anchor/AnchorIdentity";
import { IdentityFace, SessionIdentityLine } from "../identity";
import { sessionIdentity } from "../../lib/sessionIdentity";
import { RoleFace } from "../org/RoleFace";
import { AuthErrorBadge } from "../AuthErrorBadge";
import { BranchCodeLink } from "../repo/RepositoryLinks";
import { PrStatusChip } from "../PrStatusChip";
import { SessionShipChip } from "../ship/SessionShipChip";
import type { SessionCardViewProps } from "./sessionCardTypes";
import { BrowserPaneOfferGlyph } from "../browser/BrowserPaneOfferChip";
import { ShortcutTooltip } from "../KeyboardShortcutsHelp";
import { useSessionCardDrag } from "../../hooks/useSessionCardDrag";
import {
  AssignedPingStrip,
  CardHoverToolbar,
  CardParentLinks,
  CardPinMark,
  CardRestoreCluster,
  CardStartupLine,
  CardStatusSignals,
  CommentThreadsChip,
  ForkCorner,
  SessionProjectChip,
  SelectTick,
  UnreadDot,
} from "./SessionCardParts";

// The inbox session card as a pure view: everything it draws arrives as props,
// and every gesture that reaches past the card leaves through a handler. The
// store, the clock and the mutations live in the SessionCard container beside
// it; the homepage hero renders this view straight from fixtures.

export type { SessionCardChrome, SessionCardLiveness, SessionCardViewProps } from "./sessionCardTypes";

export function SessionCardView({
  session: row,
  isActive,
  isParentActive,
  isSelected = false,
  selecting = false,
  onToggleSelect,
  isUnread,
  liveTitle,
  isFavorite,
  sessionLabel,
  variant = "default",
  sectionStatus,
  forkColorKey,
  subRow,
  roleSessions = 0,
  roleAbove = null,
  now,
  chrome,
  liveness,
  viewerId,
  author,
  identity: identityProp,
  viewers,
  spawnedByTitle,
  anchorIdentity,
  runHost,
  placeDevice,
  thumbSrc,
  ship = null,
  onSelect,
  onDismiss,
  onStash,
  onDefer,
  onPin,
  onRestore,
  onKill,
  onNavigateToSession,
  onCardContextMenu,
  onPickCharacter,
  onToggleFavorite,
  onOpenLabels,
  onFilterProject,
  onFilterLabel,
  onAckAssignment,
  onOpenComments,
  onOpenParent,
  onPaneDragStart,
  onDropFiles,
  workProject,
}: SessionCardViewProps) {
  // Idempotent, so a container that already applied it (for its own clock
  // signature) hands the same row through.
  const session = withSafetyBlock(row);
  const spawnedById = session.spawned_by_conversation_id || null;
  const spawnedIsHandoff = isHandoffFrom(session, spawnedById);
  const project = getProjectName(session.git_root, session.project_path);
  const isWorking = variant === "working";
  const isStashed = variant === "stashed" || variant === "snoozed";
  // Stashed cards share the dismissed bucket's muted look — but NOT its
  // liveness suppression (a stashed agent is still running; see the idle-dot
  // gate below, which stays keyed on the real dismissed variant).
  const isDismissed = variant === "dismissed" || isStashed;
  // Compact nested-child look: a trigger sub-row, a Task subagent, or an
  // agent-team teammate (drawsNested). A worktree is only where the session
  // runs — it does not make a first-class card look like a child.
  const isSubagent = drawsNested(session, subRow);
  // Local-first "pending working": a message has been sent but the daemon
  // hasn't confirmed delivery yet (status not active). Clears the moment
  // status goes active or the server echoes the message.
  const isPendingSend = liveness.pendingSend;
  const isPendingWorking = isPendingSend && !isAgentActive(session, now);
  // The amber blocked chip drops the instant the user acts on the session —
  // see showsBlockedBadge. The clock keeps the stamp's TTL live so an expired
  // one brings the chip back on its own.
  const showBlockedBadge = showsBlockedBadge(
    session.pending_api_error,
    isPendingSend,
    liveness.blockedReviveAt,
    now,
  );
  const { showModelBadge, showAgentIcon } = chrome;
  const showBranchPill = chrome.showBranchPill;
  // Personification is opt in (session-characters.md S2): a session shows a
  // face once somebody gives it one, or when the workspace asks for every
  // session to have one. A role's standing session always has one — the role
  // IS the identity.
  const identity = identityProp ?? session;
  const isPersonified = sessionIdentity(identity, chrome.prefs).kind !== "plain";
  // Row thumbnail for sessions that contain images (server-denormalized
  // image_preview_url). Clicking it zooms the image (ImageLightbox), not the
  // session. It lives on the RIGHT edge — a left thumb pushes the title column
  // off the list's shared text edge. The hover controls keep their right-edge
  // anchor; the THUMB slides left on row hover instead, far enough to clear
  // whichever control set this variant renders, so both stay visible and
  // clickable.
  const [thumbZoom, setThumbZoom] = useState(false);
  // A preview URL whose image fails to load must drop the whole thumb slot —
  // an invisible broken img still reserves ~46px and wraps the text early.
  const [thumbBroken, setThumbBroken] = useState(false);
  useWatchEffect(() => setThumbBroken(false), [session.image_preview_url]);
  const hasThumb = !!thumbSrc && !thumbBroken;
  const displayTitle = liveTitle || sessionCardTitle(session);
  const isSlashCommand = displayTitle.startsWith("/");
  const cleanedUserMsg = cleanUserMessage(session.last_user_message);
  // A kept compose draft (see ComposeView) is a blank session the user chose to
  // save. Preview its unsent text instead of the pre-warm "Waiting for
  // connection" line — the draft IS the card's content.
  const draftPreview = liveness.draft;
  const cardSummary = sessionCardSummary(session);
  // The agent's pinned thread state, when it wrote one. It REPLACES the
  // generated summary on the card rather than stacking with it: one is what the
  // agent says is true right now, the other is a description of the session, and
  // two summary lines on a card is one too many. Ages on the clock, so a state
  // the thread has run past reads dim instead of confident.
  const stateView = threadStateView(session, session.message_count, now);
  // "Working" = the agent is actively running right now. The green pulse keys
  // off this ACTUAL state rather than the section the card lives in, so pinned
  // and flat-view cards — which always render with the "default" variant —
  // still distinguish working from idle.
  const isLive = liveness.isLive;
  // Liveness-gated so the green dot takes over the moment the session is
  // actually back.
  const isRowRestarting = liveness.restarting && !isLive;
  // A teammate's session (surfaced by team mode) is READ-ONLY here: dismiss /
  // stash / pin / kill all mutate GLOBAL conversation fields, so acting on a
  // foreign card would hide or tear down the session in the owner's inbox too.
  // Steering rights (owner) or your own authorship keep it triageable. Clicking
  // through to open/read the session is always allowed (team-visible).
  const isForeignSession = useMemo(() => {
    if (!viewerId || !session.user_id) return false;
    if (session.user_id === viewerId) return false;
    if (session.owned_by_me) return false;
    if (session.owner_user_id && session.owner_user_id === viewerId) return false;
    return true;
  }, [viewerId, session.user_id, session.owned_by_me, session.owner_user_id]);
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
  const { isDragOver, isDraggingCard, props: dragProps } = useSessionCardDrag({
    sessionId: session._id,
    title: displayTitle,
    project,
    onPaneDragStart,
    onDropFiles,
  });

  // An adopted flow station names the flow it works for, and opens its run.
  const flowChip = session.flow_run_id ? (
    <Link
      href={runHref(session.flow_run_id)}
      onClick={(e) => e.stopPropagation()}
      data-flow-chip
      className="flex-shrink min-w-0 inline-flex items-center gap-1 text-meta text-sol-green hover:underline underline-offset-2"
      title={session.flow_name ?? "Flow"}
    >
      <Workflow className="w-3 h-3 shrink-0" />
      <span className="truncate max-w-[180px]">{session.flow_name ?? "Flow"}</span>
    </Link>
  ) : null;
  // A subagent's place in the fleet queue, or what became of its worktree.
  const fleetChip = session.subagent_slot === "queued" || session.merge_back ? <SubagentFleetChip session={session} /> : null;
  const worktreeChip = (session.worktree_name || session.cloud_placement === "pending" || session.cloud_workspace === "shared" || session.migration_batch_id) ? (
    <SessionWorktreeChip
      name={session.worktree_name}
      branch={session.worktree_branch}
      preparing={session.cloud_placement === "pending"}
      shared={session.cloud_workspace === "shared"}
      seed={session.cloud_seed}
      moving={!!session.migration_batch_id}
      hostName={runHost ? deviceDisplayName(runHost) : undefined}
      hostIcon={runHost ? <DeviceIcon d={runHost} className="w-2.5 h-2.5 shrink-0" /> : undefined}
    />
  ) : null;

  if (isSubagent) {
    return (
      <div
        data-session-id={session._id}
        data-active={isActive ? "true" : undefined}
        data-selected={isSelected ? "true" : undefined}
        {...dragProps}
        onContextMenu={onCardContextMenu ? (e) => onCardContextMenu(e, session, isForeignSession) : undefined}
        className={`relative group transition-opacity duration-150 overflow-hidden ${isDraggingCard ? "opacity-35 scale-[0.99]" : ""} ${isDragOver ? "ring-1 ring-inset ring-sol-violet/40 bg-sol-violet/10" : ""} ${
          isActive
            ? "bg-sol-violet/[0.08] border-l-2 border-l-sol-violet/60"
            : isParentActive
              ? "bg-sol-cyan/[0.10] border-l border-l-sol-cyan/40"
              : isWorking
                ? "hover:bg-sol-violet/[0.06] border-l border-l-sol-violet/25"
                : isStashed
                  ? "opacity-45 hover:opacity-65 hover:bg-sol-violet/[0.04]"
                  : isDismissed
                    ? "opacity-40 hover:opacity-60 hover:bg-sol-violet/[0.04]"
                    : "hover:bg-sol-violet/[0.06] border-l border-l-sol-violet/15"
        }`}
      >
        {forkColorKey && <ForkCorner colorKey={forkColorKey} />}
      <SelectTick sessionId={session._id} isSelected={isSelected} selecting={selecting} onToggle={onToggleSelect} />
        <div
          role="button"
          tabIndex={0}
          onClick={(e) => onSelect(session, e)}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(session); } }}
          className="w-full text-left cursor-pointer px-2 py-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-sol-cyan/60"
        >
          <div className="flex items-center gap-1.5">
            {/* Corner arrow (↳) — marks this row as a child of its parent
                session. The faint violet left-border alone reads as "indented"
                only when the parent is directly above; this makes the
                sub-of-parent relationship explicit when a nested row is
                focused or pinned without the parent immediately above. */}
            <svg className={`w-3 h-3 flex-shrink-0 ${subRow === "trigger" ? "text-sol-amber/60" : "text-sol-violet/60"}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5} role="img" aria-label={subRow === "trigger" ? "Trigger session" : roleAbove ? `Reports to @${roleAbove.handle}` : "Subagent"}>
              <title>{subRow === "trigger" ? "Session driven by the trigger above" : roleAbove ? `Reports to @${roleAbove.handle}, which decides what reaches you` : "Subagent — child of its parent session"}</title>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 4v12h12" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M14 12l4 4-4 4" />
            </svg>
            {showAgentIcon && (
              <span className="flex-shrink-0 flex items-center opacity-70" title={formatAgentType(session.agent_type || "claude_code")}>
                <AgentTypeIcon agentType={session.agent_type || "claude_code"} className="w-3 h-3" />
              </span>
            )}
            {isUnread && !isActive && <UnreadDot />}
            <span data-sv-title className={`truncate text-xs leading-tight flex-1 ${
              isActive ? "text-sol-violet font-medium" : isUnread ? "text-sol-text font-medium" : "text-sol-text-muted font-normal"
            }`}>
              {isSlashCommand ? <span className="font-mono text-sol-violet/80">{displayTitle}</span> : displayTitle}
            </span>
            <div className="flex items-center gap-1 flex-shrink-0">
              {showBlockedBadge && <AuthErrorBadge kind={session.pending_api_error_kind} agentType={session.agent_type} />}
              {session.session_error && session.pending_api_error_kind !== "safety" && (
                <span className="w-1.5 h-1.5 rounded-full bg-sol-red" title={session.session_error} />
              )}
              {session.is_unresponsive && !session.session_error && (
                <span className="w-1.5 h-1.5 rounded-full bg-sol-orange" title="Session unresponsive" />
              )}
              {session.has_pending && !session.is_unresponsive && (
                <span className="w-1.5 h-1.5 rounded-full bg-sol-yellow" title="Message pending" />
              )}
              {/* Reuse the staleness-aware isLive so an aged-out subagent row
                  stops pulsing green, matching the main card and the bucket. */}
              {isLive && !showBlockedBadge && !session.session_error && !session.is_unresponsive && !session.has_pending && (
                <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-sol-green" title="Live" />
              )}
              {!isLive && !showBlockedBadge && !session.session_error && !session.is_unresponsive && !session.has_pending && session.message_count > 0 && (
                <span className="w-1.5 h-1.5 rounded-full bg-sol-text-dim/40 ring-1 ring-sol-text-dim/20" title="Idle" />
              )}
              {session.message_count > 0 && (
                <span className="text-meta tabular-nums text-sol-text-dim">{session.message_count}</span>
              )}
              <span className="text-meta text-sol-text-dim tabular-nums">
                {formatIdleDuration(session.updated_at)}
              </span>
            </div>
          </div>
          {(worktreeChip || fleetChip) && <div className="flex min-w-0 gap-1.5 pl-[18px] mt-0.5">{worktreeChip}{fleetChip}</div>}
          {stateView && (
            <div data-sv-state className="mt-0.5 flex items-start gap-1" title={stateView.text}>
              <Pin
                className={`w-2 h-2 mt-[3px] shrink-0 ${stateView.status ? THREAD_STATE_STATUS_META[stateView.status].dot : THREAD_STATE_PIN_CLASS[stateView.freshness]}`}
                strokeWidth={2.4}
              />
              <span className="text-meta text-sol-text-secondary truncate leading-snug">
                {stateView.cardLine}
              </span>
            </div>
          )}
          {cleanedUserMsg && (
            <div data-sv-prompt className="text-meta text-sol-text-dim mt-0.5 truncate leading-snug">
              <span className="text-sol-text-dim mr-0.5">&gt;</span>
              {cleanedUserMsg}
            </div>
          )}
          {session.active_task && (
            <div className="flex items-center gap-1 mt-0.5 min-w-0">
              <SessionTaskChip task={session.active_task} />
            </div>
          )}
        </div>
        {!isForeignSession && (onDismiss || onDefer || onPin) && (
          <div data-sv-fade className={`absolute top-0 bottom-0 right-0 flex items-center gap-1 py-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity pl-8 pr-2 bg-gradient-to-r from-transparent to-sol-bg-alt`}>
            {onDismiss && (
              <button
                aria-label="Kill Session"
                title="Kill Session"
                onClick={(e) => { e.stopPropagation(); onDismiss(session._id); }}
                className="p-0.5 rounded text-sol-text-dim hover:text-sol-red transition-colors"
              >
                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            )}
          </div>
        )}
        {!isForeignSession && (onRestore || onKill) && (
          <div className="absolute top-1 right-1.5 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
            {onKill && (
              <button
                aria-label={isStashed ? "Kill" : "Remove from list"}
                title={isStashed ? "Kill" : "Remove from list"}
                onClick={(e) => { e.stopPropagation(); onKill(session._id); }}
                className="p-0.5 rounded text-sol-text-dim hover:text-sol-red transition-colors"
              >
                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            )}
            {onRestore && (
              <button
                aria-label={variant === "snoozed" ? "Move to Needs You now" : "Restore"}
                title={variant === "snoozed" ? "Move to Needs You now" : "Restore"}
                onClick={(e) => { e.stopPropagation(); onRestore(session._id); }}
                className="p-0.5 rounded text-sol-text-dim hover:text-sol-violet transition-colors"
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

  // The ground under the hover toolbar's right-edge fade, so a
  // tinted card does not show a pale patch there. Null = the resting card.
  const fadeGround = isActive
    ? "color-mix(in srgb, var(--sol-cyan) 15%, var(--sol-bg-alt))"
    // A ticked card's ground lives in globals.css ([data-selected]); inherit it.
    : isSelected ? "var(--sv-card-bg)" : null;
  return (
    <div
      data-session-id={session._id}
      data-active={isActive ? "true" : undefined}
      data-selected={isSelected ? "true" : undefined}
      data-sv-viewed={viewers.length > 0 ? viewers.length : undefined}
      {...dragProps}
      onContextMenu={onCardContextMenu ? (e) => onCardContextMenu(e, session, isForeignSession) : undefined}
      className={`relative group transition-opacity duration-150 overflow-hidden ${isDraggingCard ? "opacity-35 scale-[0.99]" : ""} ${isDragOver ? "ring-1 ring-inset ring-sol-cyan bg-sol-cyan/10" : ""} ${
        // Violet, not cyan: cyan ring+tint is the ACTIVE row's treatment, and an
        // unacked handoff must never read as "this is the session you have open".
        session.assigned_ping ? "ring-1 ring-inset ring-sol-violet/50 bg-sol-violet/[0.06]" : ""
      } ${
        // Blue, and only when no stronger ring is on: a teammate has this
        // session open. The faces in the meta row say who; the ring makes the
        // card findable in a long list.
        viewers.length > 0 && !isActive && !isSelected && !session.assigned_ping ? "ring-1 ring-inset ring-sol-blue/30" : ""
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
      <SelectTick sessionId={session._id} isSelected={isSelected} selecting={selecting} onToggle={onToggleSelect} />
      <div
        role="button"
        tabIndex={0}
        // A hosted row is named by its title and time, so the star and the
        // state words nested in it never pile into the name a reader hears.
        aria-label={isHostedAgentType(session.agent_type) ? `${displayTitle}, ${formatRowTime(session.updated_at, true)}` : undefined}
        onClick={(e) => onSelect(session, e)}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(session); } }}
        className="w-full text-left cursor-pointer px-2.5 sm:px-3 py-1.5 sm:py-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-sol-cyan/60"
      >
      <div className="flex items-center gap-2.5">
      {/* data-sv-body / -titlerow / -status / -ping: the compact list
          (clientState.ui.inbox_compact) lays these out as one grid row. */}
      <div data-sv-body data-sv-thumbed={hasThumb ? "" : undefined} className="min-w-0 flex-1">
        <div data-sv-titlerow className={`flex items-center gap-1.5 leading-tight ${
          isActive ? "text-sm text-sol-text font-semibold" : isWorking ? "text-sm text-sol-text font-medium" : isStashed ? "text-sm text-sol-text-muted" : isDismissed ? "text-sm text-sol-text-muted" : "text-sm text-sol-text"
        }`}>
          {/* Who is speaking (docs/architecture/session-characters.md S3).
              Personified rows get a face: the session's character, or its
              role's when the row is a role's standing session. Clicking it
              opens the picker; hovering it says who they are, and the agent
              brand rides it as a corner badge so one glyph carries both. A
              row nobody opted in keeps the icon it has always had. 22px: at
              18 the painted faces were a smudge. Whatever leads the row sits
              in one 22px slot, so every title starts on the same edge. */}
          {(isPersonified || session.is_anchor || showAgentIcon) && (
            <span data-sv-lead className="flex-shrink-0 w-[22px] flex items-center justify-center">
            {isPersonified ? (
              <IdentityFace
                prefs={chrome.prefs}
                row={identity as typeof session}
                size={22}
                onPick={(e) => onPickCharacter?.(session, e)}
                side="bottom"
                align="start"
                className="mt-[1px]"
                badge={showAgentIcon ? <AgentTypeIcon agentType={session.agent_type || "claude_code"} className="w-full h-full p-[1px]" /> : undefined}
              />
            ) : session.is_anchor ? (
              <span className="flex-shrink-0 flex items-center" title="The workspace's agent">
                <HeadOfPeopleFace size={14} />
              </span>
            ) : showAgentIcon ? (
              <span className="flex-shrink-0 flex items-center" title={formatAgentType(session.agent_type || "claude_code")}>
                <AgentTypeIcon agentType={session.agent_type || "claude_code"} className="w-3.5 h-3.5" />
              </span>
            ) : null}
            </span>
          )}
          {isStashed && isStashHidden(session) && (
            <span className="flex-shrink-0 flex items-center text-sol-text-dim" title="Stashed and hidden — trigger wakes don't bring it back; only an ask does">
              <EyeOff className="w-3 h-3" />
            </span>
          )}
          {/* Unread sits in the card's left margin, beside the title, so it
              marks the row without pushing the title off the shared edge. */}
          {isUnread && !isActive && <span data-sv-unread className="absolute left-[4px] flex"><UnreadDot /></span>}
          {/* A stop is a small dot in the dot slot; its word follows the
              title in faint ink. The danger colour is said once, by the
              Couldn't finish section, not by every row in it. A wait for an
              OK says so after the title too, so the title keeps the room. */}
          {liveness.stopped && (
            <span data-sv-stopped-dot aria-hidden className={`flex-shrink-0 h-1.5 w-1.5 rounded-full ${NOTICE_DOT[liveness.stopped]}`} />
          )}
          {/* Name, then the title: "Ember: Fixing the auth race". The name is
              the row's identity and never truncates; the title does. */}
          <SessionIdentityLine
            prefs={chrome.prefs}
            row={identity}
            title={displayTitle}
            className="min-w-0 flex-1"
            nameClassName={isUnread && !isActive ? "font-semibold" : ""}
            titleClassName={`${isUnread && !isActive ? "font-semibold text-sol-text" : ""} ${isSlashCommand ? "font-mono text-sol-cyan" : ""}`}
            after={
              <>
              {chrome.showDeviceIcon !== false && placeDevice && (
                <span
                  data-sv-device={placeDevice.is_remote ? "cloud" : "elsewhere"}
                  className={`flex-shrink-0 self-center text-sol-text-dim ${placeDevice.is_remote ? "opacity-80" : "opacity-60"}`}
                  title={placeDevice.is_remote
                    ? `Runs in the cloud on ${deviceDisplayName(placeDevice)}`
                    : `Runs on ${deviceDisplayName(placeDevice)}, not this machine`}
                >
                  <DeviceIcon d={placeDevice} className={placeDevice.is_remote ? "w-3 h-3" : "w-2.5 h-2.5"} />
                </span>
              )}
              <ShortcutTooltip label={isFavorite ? "Unfavorite" : "Favorite"} action="conv.favorite">
                <button
                  data-sv-fav={isFavorite ? "on" : "off"}
                  onClick={(e) => { e.stopPropagation(); onToggleFavorite?.(session._id); }}
                  className={`flex-shrink-0 transition-all ${
                    isFavorite
                      ? "text-sol-yellow hover:opacity-80"
                      : "text-sol-text-dim opacity-0 group-hover:opacity-50 hover:!opacity-100 hover:!text-sol-yellow"
                  }`}
                  aria-label={isFavorite ? "Unfavorite" : "Favorite"}
                >
                  <Star className="w-3 h-3" fill={isFavorite ? "currentColor" : "none"} />
                </button>
              </ShortcutTooltip>
              </>
            }
          />
          {liveness.asksOk && !liveness.stopped && (
            // Short, so the title keeps the row: the dot and "OK?" say it,
            // the tooltip says it in full.
            <span data-sv-asks-ok className="flex flex-shrink-0 items-center gap-1 text-[12px] text-sol-orange" title="Your assistant is waiting for your OK. Open it to answer.">
              <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-sol-orange" />
              OK?
            </span>
          )}
          {liveness.stopped && (
            <span data-sv-stopped className="flex-shrink-0 text-[12px] text-sol-text-dim" title="The assistant stopped before answering. Open it to try again.">
              {NOTICE_ROW_WORD[liveness.stopped]}
            </span>
          )}
        </div>
        <AssignedPingStrip session={session} now={now} onAckAssignment={onAckAssignment} />
        {/* The card's middle band: what the agent says and what you last said.
            A thumb takes the top right corner beside the title and the band
            (data-sv-thumbed, globals.css); the meta row spans the card below,
            so the time sits on one right edge on every card, thumb or none. */}
        <div data-sv-band className="mt-0.5 min-w-0">
          <div data-sv-lines className="min-w-0 space-y-0.5">
            {stateView && !session.implementation_session && (
              <div data-sv-state className={`flex items-baseline gap-1.5 ${stateView.freshness === "aging" ? "opacity-70" : ""}`} title={stateView.text}>
                {/* The declared status is a coloured word that leads the line, so
                    every line of the card starts on the same edge. Working stays
                    quiet: the liveness dot already says "running". */}
                {stateView.status && stateView.status !== "working" && stateView.status !== sectionStatus && (
                  <span data-sv-status-chip className={`shrink-0 text-meta font-semibold ${THREAD_STATE_STATUS_META[stateView.status].dot}`}>
                    {THREAD_STATE_STATUS_META[stateView.status].label}
                  </span>
                )}
                <span className="min-w-0 text-meta truncate leading-snug text-sol-text-secondary">
                  {stateView.cardLine}
                </span>
              </div>
            )}
            {cardSummary && !stateView && !session.implementation_session && (
              <div data-sv-summary className="text-meta text-sol-text-muted line-clamp-2 leading-snug whitespace-pre-line">
                <FormattedSummary text={cardSummary} />
              </div>
            )}
            {/* The user's own verdict has no declaration or wake row of its own to
                explain it, so the card says what will happen: the next activity —
                any message, trigger, or turn — files the row on its own again. */}
            {variant === "snoozed" && session.inbox_snoozed_until && (
              <div className="flex items-center gap-1 text-meta text-sol-blue">
                <Clock className="h-3 w-3 shrink-0" />
                <span>Until {new Date(session.inbox_snoozed_until).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span>
              </div>
            )}
            {session.user_rest && !isDismissed && (
              <div data-sv-rest className="flex items-center gap-1.5 text-meta text-sol-blue">
                <span className="w-1.5 h-1.5 rounded-full bg-sol-blue/60" />
                <span>{USER_REST_CARD_LINE[session.user_rest]}</span>
              </div>
            )}
            {cleanedUserMsg && (
              <div data-sv-prompt className="text-meta text-sol-blue truncate leading-snug">
                <span className="text-sol-blue mr-1">&gt;</span>
                {cleanedUserMsg}
              </div>
            )}
            {session._hasDraft && (
              <div data-sv-draft className="flex items-start gap-1.5">
                <span className="shrink-0 mt-[1px] px-1 py-[1px] rounded text-mark font-medium uppercase tracking-wide bg-sol-yellow/15 text-sol-yellow border border-sol-yellow/30">
                  Draft
                </span>
                {draftPreview && (
                  <span className="text-meta text-sol-text-dim truncate leading-snug">{draftPreview}</span>
                )}
              </div>
            )}
            {/* A row waiting on an OK says only "OK?": the start line would claim work is under way. */}
            {session.message_count === 0 && !session.last_user_message && !session._hasDraft && !liveness.asksOk && <div data-sv-startup className="contents"><CardStartupLine session={session} /></div>}
          </div>
        </div>
        {hasThumb && (
          <button
          data-sv-thumb
            onClick={(e) => { e.stopPropagation(); setThumbZoom(true); }}
            className={`shrink-0 rounded-md overflow-hidden border border-sol-border/60 cursor-zoom-in transition-transform duration-300 ease-out ${thumbHoverShift}`}
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
        <div data-sv-meta className="flex items-center gap-1.5 mt-1">
          {author && (
            <span className="flex items-center gap-1 min-w-0 max-w-[130px]" title={`${author.name}'s session`}>
              {author.role ? (
                <RoleFace role={author.role} size={14} title={author.name} prefs={chrome.prefs} />
              ) : (
                <AvatarImg
                  src={author.avatar}
                  alt={author.name}
                  className="w-3.5 h-3.5 rounded-full object-cover"
                  fallback={
                    <span className="w-[18px] h-[18px] rounded-full bg-sol-violet/20 text-sol-violet flex items-center justify-center text-mark font-semibold leading-none">
                      {author.name.charAt(0).toUpperCase()}
                    </span>
                  }
                />
              )}
              <span className="text-meta font-medium text-sol-violet truncate">{author.role ? author.name : author.name.split(" ")[0]}</span>
            </span>
          )}
          {viewers.length > 0 && <ViewerFaces members={viewers} size={14} max={3} />}
          <SessionProjectChip
            project={project}
            label={sessionLabel}
            directory={session.git_root || session.project_path}
            onFilterProject={onFilterProject && ((e) => onFilterProject(session, e))}
            onFilterLabel={onFilterLabel && ((e) => onFilterLabel(session, e))}
          />
          {workProject && <SessionWorkProject sig={workProject} className="flex-shrink" />}
          {flowChip}
          {session.is_anchor && anchorIdentity && <><MetaSep /><AnchorScopePill anchor={anchorIdentity} quiet className="flex-shrink-0" /></>}
          {/* A role's sessions are the role's (S23.3): never rows under its
              card, one count that opens the role's page. Silent at zero. */}
          {roleSessions > 0 && session.role?.short_id && <MetaSep />}
          {roleSessions > 0 && session.role?.short_id && (
            <Link
              href={`/org/${session.role.short_id}`}
              data-role-sessions={roleSessions}
              onClick={(e) => e.stopPropagation()}
              className="flex-shrink-0 text-meta text-sol-text-dim tabular-nums whitespace-nowrap hover:text-sol-text hover:underline underline-offset-2"
              title={`${roleSessions} ${roleSessions === 1 ? "session" : "sessions"} under this role; its page lists them`}
            >
              {roleSessions} {roleSessions === 1 ? "session" : "sessions"}
            </Link>
          )}
          {worktreeChip}
          {fleetChip}
          {/* The task this session owns: the fact that ties the card to its
              work, so it stays in simple view too. */}
          {session.active_task && <SessionTaskChip task={session.active_task} className="flex-shrink" />}
          {showModelBadge && session.model && (
            <span data-simple-hide className="text-meta text-sol-text-dim font-mono truncate max-w-[90px]" title={session.model}>
              {formatModel(session.model)}
            </span>
          )}
          {session.message_count > 0 && (
            <span data-simple-hide className={`text-meta tabular-nums flex-shrink-0 ${msgCountColor(session.message_count)}`}>
              {session.message_count} msg{session.message_count !== 1 ? "s" : ""}
            </span>
          )}
          {/* The status cluster yields last (a near-zero shrink factor), so the
              chips to its left truncate first, as they always did. On a rail too
              narrow even for that, it clips from its left end: the dots and the
              time at its right edge never leave the card. */}
          <div data-sv-status className="flex items-center justify-end gap-1.5 min-w-0 shrink-[0.001] overflow-hidden ml-auto">
            {showBranchPill && <BranchCodeLink session={session} className="max-w-[110px]" detail={false} />}
            <SessionShipChip ship={ship} />
            <PrStatusChip status={session.pr_status} />
            <BrowserPaneOfferGlyph offer={session.browser_pane_offer} />
            {isFork(session) && (
              <span data-simple-hide className="inline-flex items-center gap-0.5 px-1 py-0 rounded text-meta font-medium bg-sol-cyan/10 text-sol-cyan border border-sol-cyan/20" title="Fork">
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
              <span data-simple-hide className="inline-block align-middle px-1 py-0 rounded text-meta font-medium bg-sol-cyan/10 text-sol-cyan border border-sol-cyan/20 max-w-[120px] truncate" title={session.active_plan.title}>
                {session.active_plan.title}
              </span>
            )}
            {session.workflow_run_id && !session.is_workflow_sub && session.workflow_run_status === "paused" && (
              <span className="inline-flex items-center gap-0.5 px-1 py-0 rounded text-meta font-semibold bg-sol-magenta/10 text-sol-magenta border border-sol-magenta/30">
                <span className="w-1 h-1 rounded-full bg-sol-magenta" />
                Gate
              </span>
            )}
            {/* A running workflow renders as its own ↳ WorkflowBar under the
                card (same family as schedule/monitor bars) — no chip here. */}
            <CommentThreadsChip session={session} viewerId={viewerId} onOpenComments={onOpenComments} />
            <CardPinMark session={session} onPin={onPin} />
            <CardStatusSignals
              session={session}
              showBlockedBadge={showBlockedBadge}
              isWorking={isWorking}
              isLive={isLive}
              dismissed={variant === "dismissed"}
              isPendingWorking={isPendingWorking}
              isRowRestarting={isRowRestarting}
            />
            {/* Every row keeps its time column, so the list scans down one
                edge. */}
            <span data-sv-time className="flex-shrink-0 whitespace-nowrap text-meta text-sol-text-dim tabular-nums">
              {formatRowTime(session.updated_at, isHostedAgentType(session.agent_type))}
            </span>
          </div>
        </div>
        <CardParentLinks
          session={session}
          spawnedById={spawnedById}
          spawnedIsHandoff={spawnedIsHandoff}
          spawnedByTitle={spawnedByTitle}
          onOpenParent={onOpenParent}
          onNavigateToSession={onNavigateToSession}
        />
      </div>
      </div>
      {thumbZoom && thumbSrc && (
        <ImageLightbox src={thumbSrc} onClose={() => setThumbZoom(false)} />
      )}
      </div>
      {!isForeignSession && (onDismiss || onStash || onDefer || onPin) && (
        <CardHoverToolbar session={session} labels fadeGround={fadeGround} onPin={onPin} onDismiss={onDismiss} onOpenLabels={onOpenLabels} onStash={onStash} />
      )}
      {!isForeignSession && (onRestore || onKill) && (
        <CardRestoreCluster session={session} variant={variant} isStashed={isStashed} onKill={onKill} onRestore={onRestore} />
      )}
    </div>
  );
}

/** The dim dot between plain-text facts on the meta row. */
function MetaSep() {
  return <span aria-hidden className="flex-shrink-0 text-meta text-sol-text-dim">·</span>;
}

// What the card says under a user-filed row: the next activity re-files it.
const USER_REST_CARD_LINE: Record<UserRest, string> = {
  dormant: "Parked — returns on the next wake",
  done: "Filed as done — until the next wake",
  needs_input: "Filed under Needs You — until the next wake",
};
