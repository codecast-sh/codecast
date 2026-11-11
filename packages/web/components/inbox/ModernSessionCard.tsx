import React, { useMemo, useState } from "react";
import Link from "next/link";
import { Star, Rocket } from "lucide-react";
import { withSafetyBlock, isStashHidden, isHostedAgentType } from "@codecast/shared/contracts";
import { nestParentIdOf } from "@codecast/convex/convex/ccAccountsShared";
import { entityRoute } from "@codecast/shared/entities";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { formatRowTime, sessionCardTitle } from "../../lib/sessionCard";
import { sessionCardSummary } from "../../lib/sessionSummary";
import { isHandoffFrom } from "../../lib/sessionHandoff";
import { threadStateView } from "../../lib/threadState";
import { formatModel } from "../../lib/conversationProcessor";
import { formatDateFull } from "../../lib/utils";
import { sessionIdentity } from "../../lib/sessionIdentity";
import { SESSION_STATUS, sessionStatusOf, type StatusSection } from "../../lib/sessionStatus";
import { sessionCardLine } from "../../lib/sessionCardLine";
import { getProjectName, isFork, showsBlockedBadge, railRowPlacement } from "../../store/inboxStore";
import { useSessionCardDrag } from "../../hooks/useSessionCardDrag";
import { ImageLightbox } from "../ImageGallery";
import { ViewerFaces } from "../presence/ViewerFaces";
import { DeviceIcon, deviceDisplayName } from "../DeviceBadge";
import { cleanUserMessage } from "../sessionMessage";
import { AgentTypeIcon, formatAgentType } from "../AgentTypeIcon";
import { AnchorScopePill, HeadOfPeopleFace } from "../anchor/AnchorIdentity";
import { IdentityFace, SessionIdentityLine } from "../identity";
import { SessionTaskChip } from "../work/SessionTaskChip";
import { BrowserPaneOfferGlyph } from "../browser/BrowserPaneOfferChip";
import { badgeVariants } from "../ui/badge";
import { AssignedPingStrip, ForkCorner, SelectTick } from "./SessionCardParts";
import { ModernAuthorChip, ModernBranchChip, ModernCardToolbar, ModernCommentsChip, ModernFactChip, ModernLinkChip, ModernPinGlyph, ModernProjectChip } from "./ModernCardParts";
import { SessionStatusMark, SessionStatusWord } from "./SessionStatusMark";
import type { SessionCardViewProps } from "./SessionCardView";
import "./modernSessionCard.css";

// The inbox session card in the Modern style: the same props as SessionCardView
// (SessionCard chooses between them by the person's style), drawn for a glance.
//
//   1  agent mark · title ······························· time
//   2  status mark · Word · reason · the one line about the work
//   3  quiet chips: project, branch or PR, task, links, author, comments
//
// Line 2 is the status vocabulary (lib/sessionStatus): the word agrees with the
// section the card sits in. Line 3 shows only when there is something to show.
// Unread is a bar on the left edge and a heavier title; the open card is a tint
// and a hairline in the accent. Everything the Classic card drew that these
// three lines leave out is in a tooltip (the time's and the line's) or the
// card's context menu.

/** The section the panel draws the card in, as its props say it. */
function sectionOfProps(variant: SessionCardViewProps["variant"], sectionStatus: SessionCardViewProps["sectionStatus"]): StatusSection | null {
  if (variant === "working") return "working";
  if (variant === "stashed") return "stashed";
  if (variant === "dismissed") return "dismissed";
  if (variant === "snoozed") return "snoozed";
  if (sectionStatus === "blocked") return "needs_input";
  if (sectionStatus === "done") return "done";
  if (sectionStatus === "dormant") return "dormant";
  return null;
}

const SUB_ARROW = (
  <>
    <path strokeLinecap="round" strokeLinejoin="round" d="M6 4v12h12" />
    <path strokeLinecap="round" strokeLinejoin="round" d="M14 12l4 4-4 4" />
  </>
);

export function ModernSessionCardView({
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
  placeDevice,
  thumbSrc,
  ship = null,
  onSelect,
  onDismiss,
  onStash,
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
  const session = withSafetyBlock(row);
  const hosted = isHostedAgentType(session.agent_type);
  const spawnedById = session.spawned_by_conversation_id || null;
  const project = getProjectName(session.git_root, session.project_path);
  const isStashed = variant === "stashed" || variant === "snoozed";
  const isSetAside = isStashed || variant === "dismissed";
  // A nested row: a trigger's run, a Task subagent, an agent-team teammate.
  const nested = !!subRow || !!session.is_subagent || !!nestParentIdOf(session);
  const identity = identityProp ?? session;
  const isPersonified = sessionIdentity(identity, chrome.prefs).kind !== "plain";
  const displayTitle = liveTitle || sessionCardTitle(session);
  const isSlashCommand = displayTitle.startsWith("/");
  const stateView = threadStateView(session, session.message_count, now);

  const isPendingSend = liveness.pendingSend;
  const blocked = showsBlockedBadge(session.pending_api_error, isPendingSend, liveness.blockedReviveAt, now);
  // The state: the section decides it for a top-level card (so the word agrees
  // with the header above it); a nested row and a list with no sections read
  // the row's own placement, the verdict the rail would file it under.
  const section = nested ? null : sectionOfProps(variant, sectionStatus);
  const status = sessionStatusOf({
    row: session,
    section,
    placement: section ? null : railRowPlacement(session, now),
    now,
    live: { pendingSend: isPendingSend, blocked, stopped: !!liveness.stopped, asking: !!liveness.asking || !!liveness.asksOk },
    hosted,
  });
  const meta = SESSION_STATUS[status];
  const line = sessionCardLine({
    row: session,
    status,
    now,
    live: { pendingSend: isPendingSend, blocked, asking: liveness.asking, restarting: liveness.restarting && !liveness.isLive, asksOk: liveness.asksOk, stoppedKind: liveness.stopped ?? null },
    stateLine: stateView?.cardLine,
    summary: sessionCardSummary(session),
    prompt: cleanUserMessage(session.last_user_message),
    draft: liveness.draft,
    hosted,
    stashHidden: isStashed && isStashHidden(session),
  });

  const [thumbZoom, setThumbZoom] = useState(false);
  const [thumbBroken, setThumbBroken] = useState(false);
  useWatchEffect(() => setThumbBroken(false), [session.image_preview_url]);
  const hasThumb = !!thumbSrc && !thumbBroken;

  // A teammate's session is read-only here: the actions write global fields.
  const isForeignSession = useMemo(() => {
    if (!viewerId || !session.user_id) return false;
    if (session.user_id === viewerId) return false;
    if (session.owned_by_me) return false;
    if (session.owner_user_id && session.owner_user_id === viewerId) return false;
    return true;
  }, [viewerId, session.user_id, session.owned_by_me, session.owner_user_id]);
  const { isDragOver, isDraggingCard, props: dragProps } = useSessionCardDrag({
    sessionId: session._id,
    title: displayTitle,
    project,
    onPaneDragStart,
    onDropFiles,
  });

  const time = formatRowTime(session.updated_at, hosted);
  const agentWord = formatAgentType(session.agent_type || "claude_code");
  // The facts the Classic card drew as chips and counts, said on the time.
  const details = [
    session.updated_at ? `Updated ${formatDateFull(session.updated_at)}` : null,
    session.message_count > 0 ? `${session.message_count} message${session.message_count === 1 ? "" : "s"}` : null,
    `${agentWord}${session.model ? ` · ${formatModel(session.model)}` : ""}`,
    isFork(session) ? "Fork" : null,
    session.active_plan && session.active_task ? `Plan: ${session.active_plan.title}` : null,
    // An error on a row whose state is not Error (a working agent that logged
    // one), and a worker's merge back outside Done.
    session.session_error && status !== "error" ? `Error: ${session.session_error}` : null,
    session.merge_back && status !== "done" ? `Merge back: ${session.merge_back.state}` : null,
    viewers.length > 0 ? `Open now: ${viewers.map((v: any) => v.name || v.email || "teammate").join(", ")}` : null,
  ].filter(Boolean).join("\n");
  const lineTitle = [line.reasonTitle, line.text, ...line.rest].filter(Boolean).join("\n") || meta.meaning;
  const unread = !!isUnread && !isActive;
  const expanded = isActive && !nested;
  const chipClass = `${badgeVariants({ variant: "neutral" })} min-w-0 max-w-[14rem] overflow-hidden`;

  // Line 3, left to right: what gives way first to what stays.
  const device = chrome.showDeviceIcon !== false && placeDevice
    ? { icon: <DeviceIcon d={placeDevice} className="w-3 h-3 shrink-0" />, title: placeDevice.is_remote ? `Runs in the cloud on ${deviceDisplayName(placeDevice)}` : `Runs on ${deviceDisplayName(placeDevice)}, not this machine` }
    : null;
  const shipHref = ship?.deploy ? entityRoute("deploy", ship.deploy) : null;
  const chips: React.ReactNode[] = [];
  if (!nested) {
    chips.push(
      <ModernProjectChip
        key="project"
        project={project}
        label={sessionLabel}
        directory={session.git_root || session.project_path}
        workProject={workProject}
        device={device}
        onFilterProject={onFilterProject && ((e) => onFilterProject(session, e))}
        onFilterLabel={onFilterLabel && ((e) => onFilterLabel(session, e))}
        className="shrink-[1000] min-w-[3rem]"
      />,
    );
  }
  if (ship) {
    chips.push(shipHref
      ? <Link key="ship" href={shipHref} data-mc-chip="ship" title={ship.words} onClick={(e) => e.stopPropagation()} className={`${chipClass} shrink-[100] hover:text-sol-text`}><Rocket aria-hidden className="w-3 h-3 shrink-0" /><span className="truncate">{ship.words}</span></Link>
      : <ModernFactChip key="ship" kind="ship" title={ship.words} className="shrink-[100]"><Rocket aria-hidden className="w-3 h-3 shrink-0" /><span className="truncate">{ship.words}</span></ModernFactChip>);
  } else {
    chips.push(<ModernBranchChip key="branch" session={session} showBranch={chrome.showBranchPill} className="shrink-[100] min-w-[3rem]" />);
  }
  if (session.active_task) {
    chips.push(<SessionTaskChip key="task" task={session.active_task} className={`${chipClass} shrink-[10] min-w-[3rem]`} />);
  } else if (session.active_plan) {
    chips.push(<ModernFactChip key="plan" kind="plan" title={session.active_plan.title} className="shrink-[10] min-w-[3rem]"><span className="truncate">{session.active_plan.title}</span></ModernFactChip>);
  }
  // A nested row sits under the session that spawned it; the link would point up one row.
  if (spawnedById && !nested) {
    const handoff = isHandoffFrom(session, spawnedById);
    chips.push(<ModernLinkChip key="parent" kind="parent" label={spawnedByTitle || "parent session"} title={handoff ? "Handed off from this session; open it" : "Spawned by this session; open it"} onOpen={() => onOpenParent?.(spawnedById)} className="shrink-[10] min-w-[3rem]" />);
  }
  if (session.implementation_session) {
    const impl = session.implementation_session;
    chips.push(<ModernLinkChip key="impl" kind="implementation" label={sessionCardTitle(impl)} title="The session implementing this plan; open it" onOpen={() => onNavigateToSession?.(impl._id)} className="shrink-[10] min-w-[3rem]" />);
  }
  if (roleSessions > 0 && session.role?.short_id) {
    chips.push(<ModernLinkChip key="role" kind="role" label={`${roleSessions} ${roleSessions === 1 ? "session" : "sessions"}`} title="Sessions under this role; its page lists them" href={`/org/${session.role.short_id}`} className="shrink-[10]" />);
  }
  if (session.is_anchor && anchorIdentity) {
    chips.push(<ModernFactChip key="anchor" kind="anchor" className="shrink-[10]"><AnchorScopePill anchor={anchorIdentity} quiet className="min-w-0" /></ModernFactChip>);
  }
  if (session.workflow_run_id && !session.is_workflow_sub && session.workflow_run_status === "paused") {
    chips.push(<ModernFactChip key="gate" kind="gate" accent="magenta" title="The workflow is paused at a gate" className="shrink-0">Gate</ModernFactChip>);
  }
  if (author && !nested) chips.push(<ModernAuthorChip key="author" author={author} prefs={chrome.prefs} className="shrink min-w-[2.5rem]" />);
  if (viewers.length > 0) chips.push(<ViewerFaces key="viewers" members={viewers} size={16} max={3} className="shrink-0" />);
  chips.push(<ModernCommentsChip key="comments" session={session} viewerId={viewerId} onOpenComments={onOpenComments} />);

  const lead = nested ? (
    <svg className={`w-3.5 h-3.5 ${subRow === "trigger" ? "text-sol-amber" : "text-sol-violet"}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.4} role="img" aria-label={subRow === "trigger" ? "Trigger session" : roleAbove ? `Reports to @${roleAbove.handle}` : "Subagent"}>
      <title>{subRow === "trigger" ? "Session driven by the trigger above" : roleAbove ? `Reports to @${roleAbove.handle}` : `Subagent · ${agentWord}`}</title>
      {SUB_ARROW}
    </svg>
  ) : isPersonified ? (
    <IdentityFace
      prefs={chrome.prefs}
      row={identity as typeof session}
      size={20}
      onPick={(e) => onPickCharacter?.(session, e)}
      side="bottom"
      align="start"
      badge={chrome.showAgentIcon ? <AgentTypeIcon agentType={session.agent_type || "claude_code"} className="w-full h-full p-[1px]" /> : undefined}
    />
  ) : session.is_anchor ? (
    <span className="flex items-center" title="The workspace's agent"><HeadOfPeopleFace size={16} /></span>
  ) : (
    <span className="flex items-center text-sol-text-muted" title={`${agentWord}${session.model ? ` · ${formatModel(session.model)}` : ""}`}>
      <AgentTypeIcon agentType={session.agent_type || "claude_code"} className="w-4 h-4" />
    </span>
  );

  const pinnable = !isForeignSession && !isSetAside;
  return (
    <div
      data-session-id={session._id}
      data-active={isActive ? "true" : undefined}
      data-selected={isSelected ? "true" : undefined}
      data-mc={nested ? "nested" : "card"}
      data-mc-status={status}
      data-mc-unread={unread ? "true" : undefined}
      {...dragProps}
      onContextMenu={onCardContextMenu ? (e) => onCardContextMenu(e, session, isForeignSession) : undefined}
      className={`group relative overflow-hidden transition-[opacity,background-color] duration-150 ${isDraggingCard ? "opacity-35" : ""} ${isDragOver ? "outline outline-1 -outline-offset-1 outline-[color:var(--sol-cyan)]" : ""} ${isSetAside ? "mc-set-aside" : ""} ${isParentActive && !isActive ? "mc-parent-active" : ""} ${session.assigned_ping ? "mc-handoff" : ""}`}
    >
      {forkColorKey && <ForkCorner colorKey={forkColorKey} />}
      {unread && <span data-mc-unread-bar aria-hidden className="absolute left-0 top-2 bottom-2 w-[2px] rounded-r-full bg-sol-cyan" />}
      <SelectTick sessionId={session._id} isSelected={isSelected} selecting={selecting} onToggle={onToggleSelect} />
      <div
        role="button"
        tabIndex={0}
        aria-label={`${displayTitle}, ${meta.word}${line.reason ? `, ${line.reason}` : ""}${time ? `, ${time}` : ""}`}
        onClick={(e) => onSelect(session, e)}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(session); } }}
        className={`block w-full cursor-pointer text-left ${nested ? "py-1.5 pl-6 pr-3" : "py-2 pl-3 pr-3"} outline-none focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[color:var(--focus-ring)]`}
      >
        <div data-mc-line1 className="flex min-w-0 items-center gap-2">
          <span data-mc-lead className="flex h-5 w-5 shrink-0 items-center justify-center">
            <span data-mc-agent className="flex items-center">{lead}</span>
            <span data-mc-lead-status title={meta.word} className="hidden"><SessionStatusMark status={status} /></span>
          </span>
          <SessionIdentityLine
            prefs={chrome.prefs}
            row={identity}
            title={displayTitle}
            className={`min-w-0 flex-1 ${nested ? "text-ui" : "text-body"} text-sol-text`}
            nameClassName={unread ? "font-semibold" : "font-medium"}
            titleClassName={`${unread ? "font-semibold" : isSetAside ? "font-normal" : "font-medium"} ${isSetAside ? "text-sol-text-muted" : "text-sol-text"} ${isSlashCommand ? "font-mono" : ""}`}
          />
          <span className="flex shrink-0 items-center gap-1.5">
            {line.reason && <span data-mc-compact-reason className={`hidden max-w-[9rem] truncate text-meta ${meta.text}`}>{line.reason}</span>}
            <BrowserPaneOfferGlyph offer={session.browser_pane_offer} />
            {isFavorite && (
              <button type="button" data-mc-fav aria-label="Unfavorite" title="Favorite; press to remove" onClick={(e) => { e.stopPropagation(); onToggleFavorite?.(session._id); }} className="flex items-center text-sol-yellow hover:opacity-70">
                <Star className="w-3 h-3" fill="currentColor" />
              </button>
            )}
            {session.is_pinned && <span data-mc-pin title="Pinned" className="flex items-center text-sol-magenta"><ModernPinGlyph filled className="w-3 h-3" /></span>}
            {time && <span data-mc-time title={details} className="whitespace-nowrap text-meta tabular-nums text-sol-text-dim">{time}</span>}
          </span>
        </div>
        <div data-mc-line2 className={`mt-0.5 flex min-w-0 items-start gap-2 ${hasThumb ? "pr-11" : ""}`}>
          <span className="flex h-[18px] w-5 shrink-0 items-center justify-center"><SessionStatusMark status={status} /></span>
          <p title={lineTitle} className={`min-w-0 flex-1 ${nested ? "text-meta" : "text-ui"} ${expanded ? "line-clamp-2" : "truncate"}`}>
            <SessionStatusWord status={status} title={meta.meaning} className="font-medium" />
            {line.reason && <span className={meta.text}><span aria-hidden className="text-sol-text-dim"> · </span>{line.reason}</span>}
            {line.text && (
              <span className="text-sol-text-muted">
                <span aria-hidden className="text-sol-text-dim"> · </span>
                {line.prompt && <span aria-hidden className="font-mono text-sol-text-dim">&gt; </span>}
                {line.text}
              </span>
            )}
          </p>
        </div>
        {/* Each chip draws nothing when it has nothing to say; an empty line
            takes no room (modernSessionCard.css, :empty). */}
        <div data-mc-line3 className={`mt-1.5 flex min-w-0 items-center gap-1 overflow-hidden pl-7 ${hasThumb ? "pr-11" : ""}`}>
          {chips}
        </div>
        <AssignedPingStrip session={session} now={now} onAckAssignment={onAckAssignment} />
      </div>
      {hasThumb && (
        <button
          type="button"
          data-mc-thumb
          onClick={(e) => { e.stopPropagation(); setThumbZoom(true); }}
          className="absolute right-3 top-8 h-9 w-9 overflow-hidden rounded-control border border-sol-border cursor-zoom-in"
          title="View image"
        >
          <img src={thumbSrc!} alt="" loading="lazy" draggable={false} onError={() => setThumbBroken(true)} className="h-full w-full object-cover" />
        </button>
      )}
      {thumbZoom && thumbSrc && <ImageLightbox src={thumbSrc} onClose={() => setThumbZoom(false)} />}
      {!isForeignSession && (
        isSetAside || onRestore ? (
          <ModernCardToolbar
            session={session}
            onRestore={onRestore && (() => onRestore(session._id))}
            restoreLabel={variant === "snoozed" ? "Move to Needs You now" : "Restore"}
            onKill={onKill && (() => onKill(session._id))}
            killLabel={isStashed ? "Kill" : "Remove from list"}
          />
        ) : (
          <ModernCardToolbar
            session={session}
            onPin={pinnable && onPin ? (e) => onPin(session._id, e) : undefined}
            onKill={onDismiss && (() => onDismiss(session._id))}
            onLabel={!nested && onOpenLabels ? () => onOpenLabels(session) : undefined}
            onStash={onStash && ((e) => onStash(session._id, e))}
          />
        )
      )}
    </div>
  );
}
