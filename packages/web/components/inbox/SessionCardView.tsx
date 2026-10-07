import React, { useState, useMemo } from "react";
import { SessionTaskChip } from "../work/SessionTaskChip";
import { Pin, Star, Clock, EyeOff } from "lucide-react";
import Link from "next/link";
import { withSafetyBlock, isStashHidden, type UserRest } from "@codecast/shared/contracts";
import type { NoticeKind } from "@codecast/shared/contracts/assistant";
import { NOTICE_DOT, NOTICE_ROW_WORD } from "../../lib/hostedNotice";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { formatIdleDuration, formatRowTime, sessionCardTitle } from "../../lib/sessionCard";
import { isHostedAgentType } from "@codecast/shared/contracts";
import { AvatarImg } from "../../lib/avatarCache";
import { ImageLightbox } from "../ImageGallery";
import { FormattedSummary } from "../FormattedSummary";
import { sessionCardSummary } from "../../lib/sessionSummary";
import { isHandoffFrom } from "../../lib/sessionHandoff";
import { threadStateView, THREAD_STATE_PIN_CLASS, THREAD_STATE_STATUS_META } from "../../lib/threadState";
import { getProjectName, isFork, isAgentActive, showsBlockedBadge, type InboxSession, type SessionRoleSnapshot } from "../../store/inboxStore";
import { nestParentIdOf } from "@codecast/convex/convex/ccAccountsShared";
import { msgCountColor, formatModel } from "../../lib/conversationProcessor";
import { useLabelColor } from "../../lib/labelColors";
import { ViewerFaces } from "../presence/ViewerFaces";
import { DeviceIcon, deviceDisplayName, type Device } from "../DeviceBadge";
import { SessionWorktreeChip } from "../SessionWorktreeChip";
import { SubagentFleetChip } from "../SubagentFleetChip";
import { cleanUserMessage } from "../sessionMessage";
import { AgentTypeIcon, formatAgentType } from "../AgentTypeIcon";
import { AnchorScopePill, HeadOfPeopleFace } from "../anchor/AnchorIdentity";
import { IdentityFace, SessionIdentityLine } from "../identity";
import { sessionIdentity } from "../../lib/sessionIdentity";
import type { AnchorIdentity } from "../../hooks/useSyncAnchors";
import { AuthErrorBadge } from "../AuthErrorBadge";
import { BranchCodeLink } from "../repo/RepositoryLinks";
import { PrStatusChip } from "../PrStatusChip";
import { BrowserPaneOfferGlyph } from "../browser/BrowserPaneOfferChip";
import { ShortcutTooltip } from "../KeyboardShortcutsHelp";
import { MetaDot } from "../entityDisplay";
import { useSessionCardDrag } from "../../hooks/useSessionCardDrag";
import {
  AssignedPingStrip,
  CardHoverToolbar,
  CardParentLinks,
  CardPinBadge,
  CardRestoreCluster,
  CardStartupLine,
  CardStatusSignals,
  CommentThreadsChip,
  ForkCorner,
  SelectTick,
  UnreadDot,
} from "./SessionCardParts";

// The inbox session card as a pure view: everything it draws arrives as props,
// and every gesture that reaches past the card leaves through a handler. The
// store, the clock and the mutations live in the SessionCard container beside
// it; the homepage hero renders this view straight from fixtures.

/** The card-chrome toggles (clientState.ui) the row draws. */
export type SessionCardChrome = {
  showModelBadge: boolean;
  showAgentIcon: boolean;
  showBranchPill: boolean;
  /** The workspace asks for every session to have a face. */
  personifyAll: boolean;
  /** Branch, worktree and pull request chips at all (lib/surfaces.ts
   *  "gitChips"; off in hosted mode). Absent means shown. */
  showGitChips?: boolean;
};

/** The per-card live facts that are not fields of the session row. */
export type SessionCardLiveness = {
  /** The agent is running now, by the staleness-aware check (lib/liveness). */
  isLive: boolean;
  /** A sent message the daemon has not confirmed yet. */
  pendingSend: boolean;
  /** The blocked chip's revive stamp (showsBlockedBadge drops the chip while it is fresh). */
  blockedReviveAt?: number;
  /** A kill+restart is in flight for this session (useSessionRestart), age-gated. */
  restarting: boolean;
  /** The kept compose draft's unsent text; "" when there is none. */
  draft: string;
  /** A hosted conversation whose transcript ends on a stop notice: the
   *  notice's kind, so the row says it stopped rather than looking like one
   *  that was answered. */
  stopped?: NoticeKind | null;
  /** A hosted conversation waits on the person's OK (an approval card). */
  asksOk?: boolean;
};

export type SessionCardViewProps = {
  session: InboxSession;
  isActive: boolean;
  isParentActive?: boolean;
  /** Ticked in the inbox multi-selection (lib/inboxSelection). */
  isSelected?: boolean;
  /** A multi-selection is live, so every card shows its tick box. */
  selecting?: boolean;
  /** The tick box: adds the card to the selection or takes it out. */
  onToggleSelect?: (id: string) => void;
  /** Lit for this viewer: the session moved since they last acknowledged it,
   *  or they marked it unread by hand (store/inboxStore.sessionUnreadMap). */
  isUnread?: boolean;
  /** The name the open conversation's header shows, when the container has
   *  one fresher than the row's own (SessionCard reads it for hosted rows). */
  liveTitle?: string;
  /** A muted distinguisher after the title when another row in the list
   *  reads the same name (lib/sameNameSuffix): the day, or the time. */
  titleSuffix?: string;
  isFavorite: boolean;
  /** The user label the row is filed under, else the project name shows. */
  sessionLabel: string | null;
  variant?: "default" | "working" | "dismissed" | "stashed" | "snoozed";
  forkColorKey?: string;
  // Force the compact child-row look for a session that isn't itself a
  // subagent — the trigger view renders a trigger's sessions as sub rows under
  // the trigger's own row. The ↳ arrow goes schedule-amber there (child of a
  // trigger, not of a parent session).
  // "role": one of a role's sessions under the role's card (org-roles-run-work
  // .md R1): a subagent row whose arrow names the role.
  subRow?: "trigger" | "role";
  /** On a role's own card: how many of its sessions ride it (org-staffing.md S23.3); the pill opens the role's page. */
  roleSessions?: number;
  /** On a "role" sub row: the role above it, which its arrow names. */
  roleAbove?: SessionRoleSnapshot | null;
  /** The card's clock: relative ages, thread-state freshness, the blocked chip's TTL. */
  now: number;
  chrome: SessionCardChrome;
  liveness: SessionCardLiveness;
  /** The signed-in viewer; a row by anyone else, with no steering rights, is read-only. */
  viewerId: string | null;
  /** The session's author, shown only when it is not the viewer. */
  author: { name: string; avatar?: string | null } | null;
  /** Teammates who have this session open. */
  viewers: any[];
  /** The title of the session that spawned this one. */
  spawnedByTitle: string | null;
  anchorIdentity: AnchorIdentity | null;
  /** The cloud host a worktree runs on; a local worktree needs no host. */
  runHost?: Device | null;
  /** The resolved image thumbnail, when the row shows one. */
  thumbSrc?: string | null;
  /** A plain click opens; the panel reads the event for ⌘/shift selection gestures. */
  onSelect: (session: InboxSession, e?: React.MouseEvent) => void;
  onDismiss?: (id: string) => void;
  onStash?: (id: string, e: React.MouseEvent) => void;
  onDefer?: (id: string) => void;
  onPin?: (id: string, e: React.MouseEvent) => void;
  onRestore?: (id: string) => void;
  onKill?: (id: string) => void;
  /** The implementation session's link. */
  onNavigateToSession?: (id: string) => void;
  /** Right-click: the panel owns ONE cursor-anchored menu for all cards. */
  onCardContextMenu?: (e: React.MouseEvent, session: InboxSession, isForeign: boolean) => void;
  /** Clicking the face: the panel owns ONE picker for all cards, the same way. */
  onPickCharacter?: (session: InboxSession, e: React.MouseEvent) => void;
  onToggleFavorite?: (id: string) => void;
  onOpenLabels?: (session: InboxSession) => void;
  onAckAssignment?: (id: string) => void;
  onOpenComments?: (id: string) => void;
  /** The "spawned by" / "handed off from" link. */
  onOpenParent?: (id: string) => void;
  /** The card drag doubles as a pane drag onto the stage. */
  onPaneDragStart?: (e: React.DragEvent, title: string) => void;
  /** Files dropped on the card, unfiltered. */
  onDropFiles?: (files: File[], title: string) => void;
};

export function SessionCardView({
  session: row,
  isActive,
  isParentActive,
  isSelected = false,
  selecting = false,
  onToggleSelect,
  isUnread,
  liveTitle,
  titleSuffix,
  isFavorite,
  sessionLabel,
  variant = "default",
  forkColorKey,
  subRow,
  roleSessions = 0,
  roleAbove = null,
  now,
  chrome,
  liveness,
  viewerId,
  author,
  viewers,
  spawnedByTitle,
  anchorIdentity,
  runHost,
  thumbSrc,
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
  onAckAssignment,
  onOpenComments,
  onOpenParent,
  onPaneDragStart,
  onDropFiles,
}: SessionCardViewProps) {
  const getLabelColor = useLabelColor();
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
  // agent-team teammate (via nestParentIdOf). A worktree is only where the
  // session runs — it does not make a first-class card look like a child.
  const isSubagent = !!subRow || !!session.is_subagent || !!nestParentIdOf(session);
  // Local-first "pending working": a message has been sent but the daemon
  // hasn't confirmed delivery yet (status not active). Clears the moment
  // status goes active or the server echoes the message.
  const isPendingSend = liveness.pendingSend;
  const isPendingWorking = isPendingSend && !isAgentActive(session);
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
  const showGitChips = chrome.showGitChips !== false;
  const showBranchPill = chrome.showBranchPill && showGitChips;
  // Personification is opt in (session-characters.md S2): a session shows a
  // face once somebody gives it one, or when the workspace asks for every
  // session to have one. A role's standing session always has one — the role
  // IS the identity.
  const isPersonified = sessionIdentity(session, chrome.personifyAll).kind !== "plain";
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

  // A subagent's place in the fleet queue, or what became of its worktree.
  const fleetChip = session.subagent_slot === "queued" || session.merge_back ? <SubagentFleetChip session={session} /> : null;
  const worktreeChip = showGitChips && (session.worktree_name || session.cloud_placement === "pending" || session.cloud_workspace === "shared" || session.migration_batch_id) ? (
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
        className={`relative group transition-opacity duration-150 overflow-hidden ${isDraggingCard ? "opacity-35 scale-[0.99]" : ""} ${isDragOver ? "ring-1 ring-inset ring-violet-400/40 bg-violet-500/10" : ""} ${
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
      <SelectTick sessionId={session._id} isSelected={isSelected} selecting={selecting} onToggle={onToggleSelect} />
        <div
          role="button"
          tabIndex={0}
          onClick={(e) => onSelect(session, e)}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(session); } }}
          className="w-full text-left cursor-pointer px-2 py-1"
        >
          <div className="flex items-center gap-1.5">
            {/* Corner arrow (↳) — marks this row as a child of its parent
                session. The faint violet left-border alone reads as "indented"
                only when the parent is directly above; this makes the
                sub-of-parent relationship explicit when a nested row is
                focused or pinned without the parent immediately above. */}
            <svg className={`w-3 h-3 flex-shrink-0 ${subRow === "trigger" ? "text-sol-amber/60" : "text-violet-400/60"}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5} role="img" aria-label={subRow === "trigger" ? "Trigger session" : roleAbove ? `Reports to @${roleAbove.handle}` : "Subagent"}>
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
              isActive ? "text-violet-300 font-medium" : isUnread ? "text-sol-text font-medium" : "text-gray-400 font-normal"
            }`}>
              {isSlashCommand ? <span className="font-mono text-violet-400/80">{displayTitle}</span> : displayTitle}
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
                <span className="w-1.5 h-1.5 rounded-full bg-gray-500/40 ring-1 ring-gray-500/20" title="Idle" />
              )}
              {session.message_count > 0 && (
                <span className="text-[9px] tabular-nums text-sol-text-dim/50">{session.message_count}</span>
              )}
              <span className="text-[9px] text-gray-500 tabular-nums">
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
              <span className="text-[10px] text-sol-text-secondary truncate leading-snug">
                {stateView.cardLine}
              </span>
            </div>
          )}
          {cleanedUserMsg && (
            <div data-sv-prompt className="text-[10px] text-gray-500 mt-0.5 truncate leading-snug">
              <span className="text-gray-600 mr-0.5">&gt;</span>
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

  // The ground under the right-edge fades (pin badge, hover toolbar), so a
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
        onClick={(e) => onSelect(session, e)}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(session); } }}
        className="w-full text-left cursor-pointer px-2.5 sm:px-3 py-1.5 sm:py-2"
      >
      <div className="flex items-center gap-2.5">
      {/* data-sv-body / -titlerow / -status / -ping: the compact list
          (clientState.ui.inbox_compact) lays these out as one grid row. */}
      <div data-sv-body className="min-w-0 flex-1">
        <div data-sv-titlerow className={`flex items-center gap-1.5 leading-tight ${
          isActive ? "text-sm text-sol-text font-semibold" : isWorking ? "text-sm text-sol-text font-medium" : isStashed ? "text-sm text-sol-text-muted" : isDismissed ? "text-sm text-sol-text-muted" : "text-sm text-sol-text"
        }`}>
          {/* Who is speaking (docs/architecture/session-characters.md S3).
              Personified rows get a face: the session's character, or its
              role's when the row is a role's standing session. Clicking it
              opens the picker; hovering it says who they are, and the agent
              brand rides it as a corner badge so one glyph carries both. A
              row nobody opted in keeps the icon it has always had. 22px: at
              18 the painted faces were a smudge. */}
          {isPersonified ? (
            <IdentityFace
              personifyAll={chrome.personifyAll}
              row={session}
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
          {isStashed && isStashHidden(session) && (
            <span className="flex-shrink-0 flex items-center text-sol-text-dim" title="Stashed and hidden — trigger wakes don't bring it back; only an ask does">
              <EyeOff className="w-3 h-3" />
            </span>
          )}
          {isUnread && !isActive && <UnreadDot />}
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
            personifyAll={chrome.personifyAll}
            row={session}
            title={displayTitle}
            className="min-w-0 flex-1"
            nameClassName={isUnread && !isActive ? "font-semibold" : ""}
            titleClassName={`${isUnread && !isActive ? "font-semibold text-sol-text" : ""} ${isSlashCommand ? "font-mono text-sol-cyan" : ""}`}
            after={
              <>
              {titleSuffix && <span data-sv-title-suffix className="inline-flex flex-shrink-0 items-baseline gap-1.5 font-normal text-sol-text-dim"><MetaDot /><span>{titleSuffix}</span></span>}
              <ShortcutTooltip label={isFavorite ? "Unfavorite" : "Favorite"} action="conv.favorite">
                <button
                  onClick={(e) => { e.stopPropagation(); onToggleFavorite?.(session._id); }}
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
          {session.is_anchor && anchorIdentity && <AnchorScopePill anchor={anchorIdentity} className="flex-shrink-0" />}
          {/* A role's sessions are the role's (S23.3): never rows under its
              card, one count that opens the role's page. Silent at zero. */}
          {roleSessions > 0 && session.role?.short_id && (
            <Link
              href={`/org/${session.role.short_id}`}
              data-role-sessions={roleSessions}
              onClick={(e) => e.stopPropagation()}
              className="flex-shrink-0 px-1 rounded border border-sol-border/50 bg-sol-bg-alt text-[10px] font-medium text-sol-text-muted tabular-nums whitespace-nowrap hover:text-sol-text"
              title={`${roleSessions} ${roleSessions === 1 ? "session" : "sessions"} under this role; its page lists them`}
            >
              {roleSessions} {roleSessions === 1 ? "session" : "sessions"}
            </Link>
          )}
        </div>
        <AssignedPingStrip session={session} now={now} onAckAssignment={onAckAssignment} />
        {stateView && !session.implementation_session && (
          <div data-sv-state className="mt-0.5 flex items-start gap-1" title={stateView.text}>
            <Pin
              className={`w-2.5 h-2.5 mt-[3px] shrink-0 ${stateView.status ? THREAD_STATE_STATUS_META[stateView.status].dot : THREAD_STATE_PIN_CLASS[stateView.freshness]}`}
              strokeWidth={2.4}
            />
            {/* Blocked and done earn a loud chip — those are the states the
                human must act on or can stop thinking about. Working stays
                quiet: the liveness pulse already says "running". */}
            {stateView.status && stateView.status !== "working" && (
              <span
                data-sv-status-chip
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
          <div data-sv-summary className="text-[11px] text-sol-text-muted mt-0.5 line-clamp-2 leading-snug whitespace-pre-line">
            <FormattedSummary text={cardSummary} />
          </div>
        )}
        {/* The user's own verdict has no declaration or wake row of its own to
            explain it, so the card says what will happen: the next activity —
            any message, trigger, or turn — files the row on its own again. */}
        {variant === "snoozed" && session.inbox_snoozed_until && (
          <div className="mt-1 flex items-center gap-1 text-[10px] text-sol-blue">
            <Clock className="h-3 w-3 shrink-0" />
            <span>Until {new Date(session.inbox_snoozed_until).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span>
          </div>
        )}
        {session.user_rest && !isDismissed && (
          <div data-sv-rest className="mt-0.5 flex items-center gap-1.5 text-[10px] text-sol-blue/70">
            <span className="w-1.5 h-1.5 rounded-full bg-sol-blue/60" />
            <span>{USER_REST_CARD_LINE[session.user_rest]}</span>
          </div>
        )}
        {cleanedUserMsg && (
          <div data-sv-prompt className="text-[11px] text-sky-700 dark:text-sky-300 mt-0.5 truncate leading-snug font-semibold">
            <span className="text-sky-600/60 dark:text-sky-400/50 mr-0.5">&gt;</span>
            {cleanedUserMsg}
          </div>
        )}
        {session._hasDraft && (
          <div data-sv-draft className="mt-0.5 flex items-start gap-1.5">
            <span className="shrink-0 mt-[1px] px-1 py-[1px] rounded text-[9px] font-medium uppercase tracking-wide bg-sol-yellow/15 text-sol-yellow border border-sol-yellow/30">
              Draft
            </span>
            {draftPreview && (
              <span className="text-[11px] text-sol-text-dim truncate leading-snug">{draftPreview}</span>
            )}
          </div>
        )}
        {/* A row waiting on an OK says only "OK?": the start line would claim work is under way. */}
        {session.message_count === 0 && !session.last_user_message && !session._hasDraft && !liveness.asksOk && <div data-sv-startup className="contents"><CardStartupLine session={session} /></div>}
        <div data-sv-meta className="flex items-center gap-1.5 mt-1">
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
          {viewers.length > 0 && <ViewerFaces members={viewers} size={14} max={3} />}
          {(project !== "unknown" || sessionLabel) && (
            // A label reads as a path under its project: the dot and a faded
            // prefix in the project's color, then the label in its own color.
            // Hover reveals project + directory.
            <span
              className={`flex items-center gap-1 min-w-0 text-[10px] font-medium ${getLabelColor(sessionLabel ?? project).text}`}
              title={`${project} · ${session.git_root || session.project_path || "no directory"}`}
            >
              {project !== "unknown" && (
                <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${getLabelColor(project).dot}`} />
              )}
              {sessionLabel && project !== "unknown" && sessionLabel.toLowerCase() !== project.toLowerCase() ? (
                <span className="flex min-w-0">
                  <span className={`truncate font-normal opacity-60 ${getLabelColor(project).text}`}>{project}/</span>
                  <span className="flex-shrink-0 max-w-[10rem] truncate">{sessionLabel}</span>
                </span>
              ) : (
                <span className="truncate">{sessionLabel ?? project}</span>
              )}
            </span>
          )}
          {worktreeChip}
          {fleetChip}
          {/* The task this session owns: the fact that ties the card to its
              work, so it stays in simple view too. */}
          {session.active_task && <SessionTaskChip task={session.active_task} className="flex-shrink" />}
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
          <div data-sv-status className="flex items-center gap-1.5 flex-shrink-0 ml-auto">
            {showBranchPill && <BranchCodeLink session={session} className="max-w-[110px]" detail={false} />}
            {showGitChips && <PrStatusChip status={session.pr_status} />}
            <BrowserPaneOfferGlyph offer={session.browser_pane_offer} />
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
            {session.is_workflow_primary && session.workflow_run_status === "paused" && (
              <span className="inline-flex items-center gap-0.5 px-1 py-0 rounded text-[9px] font-semibold bg-sol-magenta/10 text-sol-magenta border border-sol-magenta/30">
                <span className="w-1 h-1 rounded-full bg-sol-magenta animate-pulse" />
                Gate
              </span>
            )}
            {/* A running workflow renders as its own ↳ WorkflowBar under the
                card (same family as schedule/monitor bars) — no chip here. */}
            <CommentThreadsChip session={session} viewerId={viewerId} onOpenComments={onOpenComments} />
            <CardStatusSignals
              session={session}
              showBlockedBadge={showBlockedBadge}
              isWorking={isWorking}
              isLive={isLive}
              dismissed={variant === "dismissed"}
              isPendingWorking={isPendingWorking}
              isRowRestarting={isRowRestarting}
            />
            {/* A row with a same-name suffix already says when; its time
                gives the title its room. */}
            {!titleSuffix && (
              <span data-sv-time className="text-[10px] text-sol-text-dim tabular-nums">
                {formatRowTime(session.updated_at, isHostedAgentType(session.agent_type))}
              </span>
            )}
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
      <CardPinBadge session={session} fadeGround={fadeGround} onPin={onPin} />
      {!isForeignSession && (onDismiss || onStash || onDefer || onPin) && (
        <CardHoverToolbar session={session} fadeGround={fadeGround} onPin={onPin} onDismiss={onDismiss} onOpenLabels={onOpenLabels} onStash={onStash} />
      )}
      {!isForeignSession && (onRestore || onKill) && (
        <CardRestoreCluster session={session} variant={variant} isStashed={isStashed} onKill={onKill} onRestore={onRestore} />
      )}
    </div>
  );
}

// What the card says under a user-filed row: the next activity re-files it.
const USER_REST_CARD_LINE: Record<UserRest, string> = {
  dormant: "Parked — returns on the next wake",
  done: "Filed as done — until the next wake",
  needs_input: "Filed as needs input — until the next wake",
};
