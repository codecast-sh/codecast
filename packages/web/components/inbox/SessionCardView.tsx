import React, { useState, useCallback, useRef, useMemo } from "react";
import { Pin, Star, Clock, EyeOff, UserCheck, Tag, CheckSquare, Square } from "lucide-react";
import Link from "next/link";
import { withSafetyBlock, isStashHidden, type UserRest } from "@codecast/shared/contracts";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { formatIdleDuration, sessionCardTitle } from "../../lib/sessionCard";
import { AvatarImg } from "../../lib/avatarCache";
import { formatRelative, formatDateFull } from "../../lib/utils";
import { selectionIdsFor, useInboxSelection } from "../../lib/inboxSelection";
import { ImageLightbox } from "../ImageGallery";
import { FormattedSummary } from "../FormattedSummary";
import { sessionCardSummary } from "../../lib/sessionSummary";
import { isHandoffFrom } from "../../lib/sessionHandoff";
import { threadStateView, THREAD_STATE_PIN_CLASS, THREAD_STATE_STATUS_META } from "../../lib/threadState";
import { sessionStartupState } from "../../lib/sessionLifecycle";
import { getProjectName, isFork, isAgentActive, showsBlockedBadge, type InboxSession, type SessionRoleSnapshot } from "../../store/inboxStore";
import { nestParentIdOf } from "@codecast/convex/convex/ccAccountsShared";
import { cleanTitle, msgCountColor, formatModel } from "../../lib/conversationProcessor";
import { getLabelColor } from "../../lib/labelColors";
import { ViewerFaces } from "../presence/ViewerFaces";
import { DeviceIcon, deviceDisplayName, type Device } from "../DeviceBadge";
import { SessionWorktreeChip } from "../SessionWorktreeChip";
import { cleanUserMessage } from "../sessionMessage";
import { AgentTypeIcon, formatAgentType } from "../AgentTypeIcon";
import { AnchorScopePill, ChiefOfStaffFace } from "../anchor/AnchorIdentity";
import { IdentityFace, SessionIdentityLine } from "../identity";
import { sessionIdentity } from "../../lib/sessionIdentity";
import type { AnchorIdentity } from "../../hooks/useSyncAnchors";
import { AuthErrorBadge } from "../AuthErrorBadge";
import { BranchCodeLink } from "../repo/RepositoryLinks";
import { PrStatusChip } from "../PrStatusChip";
import { BrowserPaneOfferGlyph } from "../browser/BrowserPaneOfferChip";
import { ShortcutTooltip } from "../KeyboardShortcutsHelp";

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
};

export type SessionCardViewProps = {
  session: InboxSession;
  isActive: boolean;
  isParentActive?: boolean;
  /** Ticked in the inbox multi-selection (lib/inboxSelection). */
  isSelected?: boolean;
  /** Lit for this viewer: the session moved since they last acknowledged it,
   *  or they marked it unread by hand (store/inboxStore.sessionUnreadMap). */
  isUnread?: boolean;
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
  isUnread,
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
  const { showModelBadge, showAgentIcon, showBranchPill } = chrome;
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
  const displayTitle = sessionCardTitle(session);
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
  const [isDragOver, setIsDragOver] = useState(false);
  // Handoff note starts clamped; tapping the pill body reveals the full reason.
  const [pingExpanded, setPingExpanded] = useState(false);
  const dragCounter = useRef(0);

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

  const handleFileDrop = useCallback((e: React.DragEvent) => {
    if (isSessionDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current = 0;
    setIsDragOver(false);
    onDropFiles?.(Array.from(e.dataTransfer.files), displayTitle);
  }, [onDropFiles, displayTitle]);

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
    onPaneDragStart?.(e, displayTitle);
    const ghost = document.createElement("div");
    ghost.className = "flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium bg-sol-bg text-sol-text border border-sol-cyan/60 shadow-xl";
    ghost.style.cssText = "position:fixed;top:-1000px;left:-1000px;max-width:220px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;z-index:9999";
    const dot = document.createElement("span");
    dot.className = `w-1.5 h-1.5 rounded-full flex-shrink-0 ${getLabelColor(project).dot}`;
    const text = document.createElement("span");
    // A ticked card carries the whole selection to every drop sink.
    const carried = selectionIdsFor(session._id).length;
    text.textContent = carried > 1 ? `${carried} sessions` : displayTitle;
    text.style.cssText = "overflow:hidden;text-overflow:ellipsis";
    ghost.append(dot, text);
    document.body.appendChild(ghost);
    e.dataTransfer.setDragImage(ghost, 18, 14);
    // The browser snapshots the drag image synchronously on dragstart; the
    // element only needs to survive this frame.
    requestAnimationFrame(() => ghost.remove());
    setIsDraggingCard(true);
  }, [session._id, displayTitle, project, onPaneDragStart]);
  const handleCardDragEnd = useCallback(() => setIsDraggingCard(false), []);

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
        draggable
        onDragStart={handleCardDragStart}
        onDragEnd={handleCardDragEnd}
        onDragEnter={handleFileDragEnter}
        onDragOver={handleFileDragOver}
        onDragLeave={handleFileDragLeave}
        onDrop={handleFileDrop}
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
      <SelectTick sessionId={session._id} isSelected={isSelected} />
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
          {worktreeChip && <div className="flex min-w-0 pl-[18px] mt-0.5">{worktreeChip}</div>}
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
            <div className="flex items-center gap-1 mt-0.5">
              <span className="inline-block align-middle px-1 py-0 rounded text-[9px] font-medium bg-violet-900/20 text-violet-400/70 border border-violet-600/20 max-w-[160px] truncate" title={session.active_task.title}>
                {session.active_task.title}
              </span>
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
      draggable
      onDragStart={handleCardDragStart}
      onDragEnd={handleCardDragEnd}
      onDragEnter={handleFileDragEnter}
      onDragOver={handleFileDragOver}
      onDragLeave={handleFileDragLeave}
      onDrop={handleFileDrop}
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
      <SelectTick sessionId={session._id} isSelected={isSelected} />
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
              <ChiefOfStaffFace size={14} />
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
            }
          />
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
        {session.assigned_ping && (
          /* mr-5 keeps the strip — and its "Got it" button — clear of the
             hover toolbar's column on the right, whose gradient would
             otherwise wash over the button. */
          <div data-sv-ping className="flex items-start gap-1.5 mt-1 mr-5 px-1.5 py-1 rounded-md bg-sol-violet/15 border border-sol-violet/30">
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
                {" · "}{formatRelative(session.assigned_ping.at, now)}
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
              onClick={(e) => { e.stopPropagation(); onAckAssignment?.(session._id); }}
              className="flex-shrink-0 px-1.5 py-0.5 rounded text-[10px] font-medium bg-sol-violet/20 text-sol-violet border border-sol-violet/40 hover:bg-sol-violet/30 transition-colors"
            >
              Got it
            </button>
          </div>
        )}
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
        {session.message_count === 0 && !session.last_user_message && !session._hasDraft && <div data-sv-startup className="contents">{(() => {
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
        })()}</div>}
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
          {worktreeChip}
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
            <PrStatusChip status={session.pr_status} />
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
                && session.last_comment_author_id !== viewerId;
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
                    onOpenComments?.(session._id);
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
            {session.session_error && session.pending_api_error_kind !== "safety" && (
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
            data-sv-spawned
            className="mt-1 flex items-center gap-1 text-[11px] text-sol-text-dim hover:text-sol-cyan cursor-pointer transition-colors"
            onClick={(e) => {
              e.stopPropagation();
              onOpenParent?.(spawnedById);
            }}
            title={spawnedIsHandoff ? "View the session this one continues" : "View the session that spawned this one"}
          >
            <svg className="w-3 h-3 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6" />
            </svg>
            <span className="flex-shrink-0">{spawnedIsHandoff ? "handed off from" : "spawned by"}</span>
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
              {sessionCardTitle(session.implementation_session)}
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
        <div data-sv-fade data-sv-pin className="absolute top-0 right-0 py-1 pr-2 pointer-events-none z-[2]" style={{ paddingLeft: 24, background: `linear-gradient(to right, transparent, ${fadeGround ?? "var(--sol-bg-alt)"} 60%)` }}>
          <ShortcutTooltip label="Unpin" action="session.pin" side="left">
            <button
              onClick={(e) => { e.stopPropagation(); onPin(session._id, e); }}
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
        <div data-sv-fade className={`absolute top-0 bottom-0 right-0 flex flex-col items-center justify-between py-1 opacity-0 group-hover:opacity-100 transition-opacity pl-10 pr-2 pointer-events-none ${fadeGround ? '' : 'bg-gradient-to-r from-transparent via-[color-mix(in_srgb,var(--sol-bg-alt)_50%,transparent)] to-[color-mix(in_srgb,var(--sol-bg-alt)_85%,transparent)]'}`} style={fadeGround ? { background: `linear-gradient(to right, transparent, color-mix(in srgb, ${fadeGround} 50%, transparent), color-mix(in srgb, ${fadeGround} 85%, transparent))` } : undefined}>
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
                  onClick={(e) => { e.stopPropagation(); onPin(session._id, e); }}
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
                onOpenLabels?.(session);
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
                onClick={(e) => { e.stopPropagation(); onStash(session._id, e); }}
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
            <ShortcutTooltip label={variant === "snoozed" ? "Move to Needs Input now" : "Restore"} side="left">
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
}

// What the card says under a user-filed row: the next activity re-files it.
const USER_REST_CARD_LINE: Record<UserRest, string> = {
  dormant: "Parked — returns on the next wake",
  done: "Filed as done — until the next wake",
  needs_input: "Filed as needs input — until the next wake",
};

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

// Unread, said once. Weight carries it (the title goes bright and medium) and
// this dot marks the leading edge, the same two signals the chat rail uses —
// never a count, which turns a busy afternoon into a number that never reaches
// zero.
function UnreadDot() {
  return (
    <span
      className="flex-shrink-0 w-1.5 h-1.5 rounded-full bg-sol-cyan"
      title="Unread — this session moved since you last looked at it"
      aria-label="Unread"
    />
  );
}

/** The card's tick while a selection is live: every card shows its box, so
 *  the mode is visible, and the box itself toggles the card. A ticked card
 *  also gets its frame here, as an overlay, so the pin's fade cannot cover it. */
function SelectTick({ sessionId, isSelected }: { sessionId: string; isSelected: boolean }) {
  const selecting = useInboxSelection((sel) => sel.ids.length > 0);
  if (!selecting) return null;
  const Icon = isSelected ? CheckSquare : Square;
  return (
    <>
    {isSelected && <span data-sv-selframe aria-hidden className="pointer-events-none absolute inset-0 z-[3] rounded-[inherit] ring-2 ring-inset ring-sol-blue" />}
    <button
      type="button"
      data-sv-check
      aria-label={isSelected ? "Remove from selection" : "Add to selection"}
      aria-pressed={isSelected}
      onClick={(e) => { e.stopPropagation(); useInboxSelection.getState().toggle(sessionId); }}
      className={`absolute right-1 top-1 z-10 rounded bg-sol-bg-alt/80 p-0.5 ${isSelected ? "text-sol-blue" : "text-sol-text-dim/60 hover:text-sol-blue"}`}
    >
      <Icon className="h-4 w-4" />
    </button>
    </>
  );
}
