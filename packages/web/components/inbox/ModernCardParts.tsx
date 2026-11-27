import type React from "react";
import Link from "next/link";
import { CornerUpLeft, ArrowRight, GitBranch, MessageSquare, Square, Tag, Users, Workflow } from "lucide-react";
import { runHref } from "../../lib/decisionLinks";
import { badgeVariants } from "../ui/badge";
import { Button } from "../ui/button";
import { ShortcutTooltip } from "../KeyboardShortcutsHelp";
import { Mark } from "../Mark";
import { useLabelColor, useWorkspaceColor } from "../../lib/labelColors";
import { projectDotClass, workspaceColorOf } from "../../lib/projectColors";
import { WORK_PROJECT_SEP } from "../../lib/workProjectSig";
import { workProjectChipKey } from "../../store/workProjects";
import { clickProjectChip } from "../../store/chipFilterClicks";
import { accentVar, prPath } from "../../lib/externalEvents";
import { prFace } from "../../lib/prStateGlyph";
import { isDefaultBranch, sessionRepository } from "../../lib/repoNavigation";
import { repoTreeHref } from "../../lib/repoView";
import { cleanTitle } from "../../lib/conversationProcessor";
import { AvatarImg } from "../../lib/avatarCache";
import { RoleFace } from "../org/RoleFace";
import { DeviceIcon } from "../DeviceBadge";
import { SessionCloseTip } from "./SessionCloseTip";
import type { IdentityPrefs } from "../../lib/sessionIdentity";
import type { InboxSession, SessionRoleSnapshot } from "../../store/inboxStore";
import type { AvatarKey } from "@codecast/shared/contracts/orgAvatars";

// The pieces of the Modern session card (ModernSessionCard): the quiet chips of
// its third line and the one-row toolbar. Each draws from the row and the few
// facts handed to it; every gesture leaves through a handler.

// One chip look for every fact on the third line: the neutral Badge, its own
// colours dropped to the muted ink so no chip shouts over the status word.
const CHIP = `${badgeVariants({ variant: "neutral" })} min-w-0 max-w-[14rem] overflow-hidden`;
const CHIP_ACCENT = `${badgeVariants({ variant: "cyan" })} min-w-0 max-w-[14rem] overflow-hidden`;
const PRESS = "cursor-pointer transition-colors hover:bg-sol-text/[0.11] hover:text-sol-text";
const stop = (e: React.SyntheticEvent) => e.stopPropagation();

/** The project the session runs in: the project it works in when it has one
 *  (session-projects.md SP1), else its label, else its repository. A press
 *  filters the list to it, with the chip row's own gestures. */
export function ModernProjectChip({ project, label, directory, workProject, onFilterProject, onFilterLabel, device, className = "" }: {
  project: string;
  label: string | null;
  directory?: string | null;
  workProject?: string;
  onFilterProject?: (e: React.MouseEvent) => void;
  onFilterLabel?: (e: React.MouseEvent) => void;
  /** Where it runs, when that is worth saying: a glyph and the machine's name. */
  device?: { d: Parameters<typeof DeviceIcon>[0]["d"]; title: string; name: string } | null;
  className?: string;
}) {
  const getLabelColor = useLabelColor();
  const workspaceColor = useWorkspaceColor();
  const [pid, color, title] = workProject ? workProject.split(WORK_PROJECT_SEP) : [];
  const known = project !== "unknown";
  const name = title || label || (known ? project : "");
  if (!name && !device) return null;
  const dot = title
    ? <Mark id="entity.project" tinted><span aria-hidden className={`w-1.5 h-1.5 rotate-45 rounded-[1px] shrink-0 ${projectDotClass({ color: color || undefined, title })}`} /></Mark>
    // A label keeps its label colour; a repository wears its workspace
    // colour, the one the card's lead tile is drawn in (WorkspaceTile).
    : name ? <Mark id={label ? "inbox.label" : "inbox.repo"} tinted><span aria-hidden className={`w-1.5 h-1.5 rounded-full shrink-0 ${label ? getLabelColor(name).dot : workspaceColorOf(name, workspaceColor).dot}`} /></Mark> : null;
  const where = [title && `In ${title}`, label && `Label ${label}`, known && `${project} · ${directory || "no directory"}`, device?.title].filter(Boolean).join("\n");
  const onPress = title
    ? (e: React.MouseEvent) => clickProjectChip(workProjectChipKey(pid), null, e.altKey, e.shiftKey)
    : label ? onFilterLabel : onFilterProject;
  // With no project to name, the chip names the machine its glyph stands for.
  const body = <>{device && <DeviceIcon d={device.d} className="w-3 h-3" />}{dot}<span className="truncate" title={where}>{name || device?.name}</span></>;
  return onPress && name ? (
    <button type="button" data-mc-chip="project" className={`${CHIP} ${PRESS} ${className}`} onClick={(e) => { stop(e); onPress(e); }}>
      {body}
    </button>
  ) : (
    <span data-mc-chip="project" className={`${CHIP} ${className}`}>{body}</span>
  );
}

/** The flow a session works for; opens its run. */
export function ModernFlowChip({ runId, name, className = "" }: { runId: string | null | undefined; name?: string | null; className?: string }) {
  if (!runId) return null;
  return (
    <Link href={runHref(runId)} data-mc-chip="flow" data-flow-chip onClick={stop} className={`${CHIP_ACCENT} ${PRESS} ${className}`}>
      <Mark id="inbox.flow" labeled={!name}><Workflow aria-hidden className="w-3 h-3 shrink-0" /></Mark><span className="truncate" title={name || undefined}>{name || "Flow"}</span>
    </Link>
  );
}

/** Where the work sits in git: its pull request when it has one, else its
 *  worktree, else a branch that is not the default (with the branch setting
 *  on). The PR and the branch open their pages. */
export function ModernBranchChip({ session, showBranch, className = "" }: { session: InboxSession; showBranch: boolean; className?: string }) {
  const pr = session.pr_status;
  if (pr) {
    const href = prPath({ repository: pr.repository, number: pr.number });
    // The face every pull request wears (lib/prStateGlyph): what it waits on is a glyph after the number, the words its tooltip.
    const face = prFace(pr.state);
    const { Pr, After } = face;
    const title = `${pr.repository} #${pr.number}${pr.title ? ` — ${pr.title}` : ""}\n${face.phrase}`;
    const body = (
      <>
        <Mark id={face.mark}><Pr aria-hidden className="w-3 h-3 shrink-0" /></Mark>
        <span className="tabular-nums shrink-0" title={title}>#{pr.number}</span>
        {After ? <Mark id={face.afterMark!}><After aria-hidden data-pr-state={face.state} className="w-3 h-3 shrink-0" style={{ color: accentVar(face.accent) }} /></Mark> : null}
        <span className="sr-only">{face.phrase}</span>
      </>
    );
    const dim = face.settled ? " opacity-60" : "";
    return href
      ? <Link href={href} data-mc-chip="pr" onClick={stop} className={`${CHIP} ${PRESS}${dim} ${className}`}>{body}</Link>
      : <span data-mc-chip="pr" className={`${CHIP}${dim} ${className}`}>{body}</span>;
  }
  const busy = session.cloud_placement === "pending" ? "preparing" : session.migration_batch_id ? "moving" : null;
  if (session.worktree_name || busy || session.cloud_workspace === "shared") {
    const name = busy ?? (session.cloud_workspace === "shared" ? "shared" : session.worktree_name!);
    const branch = session.worktree_branch;
    const title = busy === "moving" ? "Moving to another machine; messages sent now arrive after the move"
      : busy === "preparing" ? "Preparing the cloud host"
      : session.cloud_workspace === "shared" ? `Runs in the host's main checkout${branch ? ` (${branch})` : ""}`
      : `Worktree ${name}${branch ? ` (${branch})` : ""}`;
    return (
      <span data-mc-chip="worktree" className={`${CHIP} ${className}`}>
        <Mark id="inbox.worktree"><GitBranch aria-hidden className="w-3 h-3 shrink-0" /></Mark><span className="truncate font-mono" title={title}>{name}</span>
      </span>
    );
  }
  const branch = session.git_branch || session.worktree_branch;
  const repository = showBranch ? sessionRepository(session) : null;
  if (!repository || !branch || isDefaultBranch(branch)) return null;
  return (
    <Link href={repoTreeHref(repository, branch)} data-mc-chip="branch" onClick={stop} className={`${CHIP} ${PRESS} ${className}`}>
      <Mark id="git.branch"><GitBranch aria-hidden className="w-3 h-3 shrink-0" /></Mark><span className="truncate font-mono" title={`${repository} at ${branch}`}>{branch}</span>
    </Link>
  );
}

/** Whose session this is, when it is not the viewer's: a role's face or the
 *  author's avatar, and the first name. */
export function ModernAuthorChip({ author, prefs, className = "" }: {
  author: { name: string; avatar?: string | null; face?: AvatarKey; role?: SessionRoleSnapshot };
  prefs: IdentityPrefs;
  className?: string;
}) {
  return (
    <span data-mc-chip="author" title={`${author.name}'s session`} className={`${CHIP} ${className}`}>
      {author.role ? (
        <RoleFace role={author.role} size={14} title={author.name} prefs={prefs} />
      ) : (
        <AvatarImg
          src={author.avatar}
          alt=""
          className="w-3.5 h-3.5 rounded-full object-cover shrink-0"
          fallback={<Users aria-hidden className="w-3 h-3 shrink-0" />}
        />
      )}
      <span className="truncate">{author.role ? author.name : author.name.split(" ")[0]}</span>
    </span>
  );
}

/** The open comment threads: the accent when someone else spoke last (the
 *  ball is the viewer's), quiet when the viewer did. Opens the comment rail. */
export function ModernCommentsChip({ session, viewerId, onOpenComments }: { session: InboxSession; viewerId: string | null; onOpenComments?: (id: string) => void }) {
  const n = session.open_comment_threads ?? 0;
  if (n <= 0) return null;
  const yours = !!session.last_comment_author_id && session.last_comment_author_id !== viewerId;
  const who = session.last_comment_author;
  return (
    <button
      type="button"
      data-mc-chip="comments"
      onClick={(e) => { stop(e); onOpenComments?.(session._id); }}
      className={`${yours ? CHIP_ACCENT : CHIP} ${PRESS} shrink-0`}
    >
      <Mark id="inbox.comments"><MessageSquare aria-hidden className="w-3 h-3 shrink-0" /></Mark>
      <span className="tabular-nums" title={`${n} open comment thread${n === 1 ? "" : "s"}${who && session.last_comment_excerpt ? ` — ${who}: ${session.last_comment_excerpt}` : ""}`}>{n}</span>
    </button>
  );
}

/** A link to another session (the one that spawned or handed off this one,
 *  the one implementing its plan) or to a role's page. */
export function ModernLinkChip({ kind, label, title, onOpen, href, className = "" }: {
  kind: "parent" | "implementation" | "role";
  label: string;
  title: string;
  onOpen?: () => void;
  href?: string;
  className?: string;
}) {
  const icon = kind === "parent" ? <Mark id="inbox.parent"><CornerUpLeft aria-hidden className="w-3 h-3 shrink-0" /></Mark>
    : kind === "implementation" ? <Mark id="inbox.implementation"><ArrowRight aria-hidden className="w-3 h-3 shrink-0" /></Mark>
    : <Mark id="inbox.role_sessions"><Users aria-hidden className="w-3 h-3 shrink-0" /></Mark>;
  const body = <>{icon}<span className="truncate" title={title}>{kind === "role" ? label : cleanTitle(label)}</span></>;
  if (href) return <Link href={href} data-mc-chip={kind} onClick={stop} className={`${CHIP} ${PRESS} ${className}`}>{body}</Link>;
  return (
    <button type="button" data-mc-chip={kind} onClick={(e) => { stop(e); onOpen?.(); }} className={`${CHIP} ${PRESS} ${className}`}>
      {body}
    </button>
  );
}

/** A fact with no gesture of its own (a plan, the workflow gate, the anchor's scope). */
export function ModernFactChip({ kind, title, children, accent, className = "" }: { kind: string; title?: string; children: React.ReactNode; accent?: "magenta"; className?: string }) {
  const look = accent ? `${badgeVariants({ variant: accent })} min-w-0 max-w-[14rem] overflow-hidden` : CHIP;
  return <span data-mc-chip={kind} title={title} className={`${look} ${className}`}>{children}</span>;
}

const PIN_PATH = "M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76z";

/** The pin glyph, filled when pinned (the Classic card's own). */
export function ModernPinGlyph({ filled, className = "w-3.5 h-3.5" }: { filled: boolean; className?: string }) {
  return (
    <svg aria-hidden className={className} viewBox="0 0 24 24" fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 17v5" />
      <path d={PIN_PATH} />
    </svg>
  );
}

function Glyph({ d }: { d: string }) {
  return (
    <svg aria-hidden className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={d} />
    </svg>
  );
}
const CLOSE_PATH = "M6 18L18 6M6 6l12 12";
const RESTORE_PATH = "M17 17L7 7M7 7h6M7 7v6";

const TOOL = "pointer-events-auto text-sol-text-dim";

/** The card's actions in one row at its top right, over a fade of the card's
 *  own ground: shown on hover and while the card holds keyboard focus. One
 *  row, so no card height clips it. A live card ends on Close; a set-aside
 *  card (stashed, snoozed, closed) offers Restore and its remove instead. */
export function ModernCardToolbar({ session, onPin, onLabel, onClose, onRestore, onKill, restoreLabel = "Restore", killLabel = "Kill" }: {
  session: InboxSession;
  onPin?: (e: React.MouseEvent) => void;
  onLabel?: () => void;
  onClose?: () => void;
  onRestore?: () => void;
  onKill?: () => void;
  restoreLabel?: string;
  killLabel?: string;
}) {
  if (!onPin && !onLabel && !onClose && !onRestore && !onKill) return null;
  const pinned = !!session.is_pinned;
  return (
    <div data-mc-tools className="mc-tools absolute right-0 top-0 z-[3] flex items-center gap-0.5 pl-8 pr-1.5 pt-1.5 pb-1 opacity-0 pointer-events-none transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
      {onPin && (
        <ShortcutTooltip label={pinned ? "Unpin" : "Pin"} action="session.pin">
          <Button variant="ghost" size="icon-xs" aria-label={pinned ? "Unpin" : "Pin"} onClick={(e) => { stop(e); onPin(e); }} className={`${TOOL} ${pinned ? "text-sol-magenta" : "hover:text-sol-magenta"}`}>
            <ModernPinGlyph filled={pinned} />
          </Button>
        </ShortcutTooltip>
      )}
      {onLabel && (
        <ShortcutTooltip label="Label session" action="session.moveToBucket">
          <Button variant="ghost" size="icon-xs" aria-label="Label session" onClick={(e) => { stop(e); onLabel(); }} className={`${TOOL} hover:text-sol-blue`}>
            <Tag aria-hidden className="w-3.5 h-3.5" />
          </Button>
        </ShortcutTooltip>
      )}
      {onRestore && (
        <ShortcutTooltip label={restoreLabel}>
          <Button variant="ghost" size="icon-xs" aria-label={restoreLabel} onClick={(e) => { stop(e); onRestore(); }} className={`${TOOL} hover:text-sol-cyan`}>
            <Glyph d={RESTORE_PATH} />
          </Button>
        </ShortcutTooltip>
      )}
      {onKill && (
        <ShortcutTooltip label={killLabel}>
          <Button variant="ghost" size="icon-xs" aria-label={killLabel} onClick={(e) => { stop(e); onKill(); }} className={`${TOOL} hover:text-sol-red`}>
            {/* A Kill wears the menus' Kill mark, never the live card's Close X: the reflex must not carry over. */}
            {killLabel === "Kill" ? <Square aria-hidden data-kill-glyph className="w-3.5 h-3.5" /> : <Glyph d={CLOSE_PATH} />}
          </Button>
        </ShortcutTooltip>
      )}
      {onClose && (
        <ShortcutTooltip label={<SessionCloseTip session={session} />} action="session.close">
          <Button variant="ghost" size="icon-xs" aria-label="Close" data-mc-close onClick={(e) => { stop(e); onClose(); }} className={`${TOOL} hover:text-sol-text`}>
            <Glyph d={CLOSE_PATH} />
          </Button>
        </ShortcutTooltip>
      )}
    </div>
  );
}
