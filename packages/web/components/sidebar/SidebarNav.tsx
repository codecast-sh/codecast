"use client";

/**
 * The rail's rows (the conversation rows, then the Work and Agents groups) drawn from props: no
 * store reads, no queries. Sidebar fills it from the live app; a surface
 * outside the app (the marketing hero) feeds it fixtures. The rows that carry
 * live counts arrive as their own views, so a heartbeat re-renders one row,
 * never the rail.
 */

import type { ReactNode } from "react";
import Link from "next/link";
import { AppWindow, ChevronRight, Flag, FolderGit2, FolderKanban, FolderOpen, Globe, Inbox, KeyRound, Network, Radar, Waypoints, Zap, MessageSquare, MessagesSquare, Newspaper, Rocket } from "lucide-react";
import { NavCount, NavSection, type SectionRowSpec } from "./navPrimitives";
import { DocsNavIcon, TasksNavIcon } from "./navIcons";
import { TeamIcon } from "../TeamIcon";
import { paneDragProps, railRowClass } from "../../lib/railRow";

/** The Threads row: every conversation you are in, with the count of those that moved. */
export function ThreadsNavRowView({
  isActive,
  isNarrow,
  onMobileClose,
  unread,
}: {
  isActive: boolean;
  isNarrow: boolean;
  onMobileClose?: () => void;
  unread: number;
}) {
  return (
    <Link
      href="/threads"
      onClick={onMobileClose}
      {...paneDragProps("/threads", "Threads")}
      className={`relative ${railRowClass(isActive, isNarrow)}`}
      title="Threads — every conversation you're in"
    >
      <MessagesSquare className="w-5 h-5 flex-shrink-0" strokeWidth={1.5} />
      {isNarrow ? (
        unread > 0 && !isActive ? (
          <span className="absolute top-2 right-3 w-1.5 h-1.5 rounded-full bg-sol-red" aria-label={`${unread} threads with new replies`} />
        ) : null
      ) : (
        <>
          <span>Threads</span>
          {unread > 0 && <NavCount n={unread} tone="bg-sol-red text-white" />}
        </>
      )}
    </Link>
  );
}

/** The team's feed row, under the team's own icon. */
export function FeedNavRowView({
  team,
  isActive,
  isNarrow,
  onMobileClose,
}: {
  team: { name: string; icon?: string; icon_color?: string };
  isActive: boolean;
  isNarrow: boolean;
  onMobileClose?: () => void;
}) {
  return (
    <Link
      href="/team/activity"
      onClick={onMobileClose}
      {...paneDragProps("/team/activity", "Feed")}
      className={railRowClass(isActive, isNarrow)}
      title={team.name}
    >
      <TeamIcon icon={team.icon} color={team.icon_color} className="w-5 h-5 flex-shrink-0" />
      {!isNarrow && <span>Feed</span>}
    </Link>
  );
}

/** The decision queue's row, with what waits on a person. The count hides at zero; the row stays. */
export function QuestionsNavRowView({
  isActive,
  isNarrow,
  onMobileClose,
  pending,
}: {
  isActive: boolean;
  isNarrow: boolean;
  onMobileClose?: () => void;
  pending: number;
}) {
  const label = "Decisions";
  return (
    <Link
      href="/decisions"
      onClick={onMobileClose}
      {...paneDragProps("/decisions", label)}
      className={railRowClass(isActive, isNarrow, "border-sol-violet")}
      title="Decisions you own, and the team's"
    >
      <svg className="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
      {!isNarrow && (
        <>
          <span>{label}</span>
          {pending > 0 && <NavCount n={pending} tone="bg-sol-cyan text-white" />}
        </>
      )}
    </Link>
  );
}

/** Chat's row: unread is weight plus a dot, and only a mention gets a number. */
export function ChatNavSectionView({
  isActive,
  isNarrow,
  onMobileClose,
  channels,
  mentions,
  items,
  headerAction,
  expanded,
  onToggle,
  onDrill,
}: {
  isActive: boolean;
  isNarrow: boolean;
  onMobileClose?: () => void;
  onDrill?: () => void;
  /** Channels with unread messages. */
  channels: number;
  mentions: number;
  items?: SectionRowSpec[];
  headerAction?: ReactNode;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <NavSection
      label="Chat"
      href="/chat"
      isActive={isActive}
      isNarrow={isNarrow}
      onMobileClose={onMobileClose}
      unread={channels > 0 || mentions > 0}
      badge={
        mentions > 0 ? (
          <NavCount n={mentions} tone="bg-sol-red text-white" kind="mention" />
        ) : channels > 0 && !isActive ? (
          <span className="w-1.5 h-1.5 rounded-full bg-sol-cyan" aria-label="Unread messages" />
        ) : null
      }
      icon={<MessageSquare className="w-5 h-5 flex-shrink-0" strokeWidth={1.5} />}
      items={items}
      popped="chat"
      headerAction={headerAction}
      expanded={expanded}
      onToggle={onToggle}
      onDrill={onDrill}
    />
  );
}

/** A section that nests rows under it: the saved views under Tasks and Docs. */
export type NavSectionList = { items: SectionRowSpec[]; expanded: boolean; onToggle: () => void; onDrill?: () => void };

export type SidebarNavActive = {
  /** The inbox page (/inbox). */
  inbox?: boolean;
  tasks: boolean;
  docs: boolean;
  code: boolean;
  files: boolean;
  /** The team Vault (/vault). */
  vault?: boolean;
  pages: boolean;
  sessions: boolean;
  line: boolean;
  /** Ops (/ops): the running product's issues, replays, metrics and sources. */
  ops?: boolean;
  triggers: boolean;
  /** The Org screen (/org and an object opened on it). */
  org: boolean;
  /** The goals list and a goal (/goals…). */
  goals?: boolean;
  /** The projects list and a project's board (/projects…). */
  projects?: boolean;
  /** Absent where the rail never shows Changes (the marketing hero). */
  changes?: boolean;
  deploys?: boolean;
  windows: boolean;
};

/** Which of the Goals, Projects and Org rows a pathname lights. */
export function orgRowsActive(pathname: string | null | undefined): Pick<SidebarNavActive, "org" | "goals" | "projects"> {
  const p = pathname ?? "";
  const under = (base: string) => p === base || p.startsWith(`${base}/`);
  return { org: under("/org"), goals: under("/goals"), projects: under("/projects") };
}

/**
 * The rail's groups in order. Conversations takes its rows as rendered
 * elements (each reads its own live count); Work and Agents are the app's
 * fixed sections, with Org's read views and the saved views under Tasks and
 * Docs.
 */
export function SidebarNavView({
  isNarrow,
  scope,
  onMobileClose,
  threads,
  feed,
  questions,
  chat,
  calls,
  workAction,
  active,
  tasks,
  docs,
  orgOn,
  orgBadge,
  offers,
  changesOn,
  flowsOn = true,
  railMore,
  workspaceHeader,
}: {
  isNarrow: boolean;
  scope?: "work";
  onMobileClose?: () => void;
  threads?: ReactNode;
  feed?: ReactNode;
  questions?: ReactNode;
  chat?: ReactNode;
  /** The Calls row and the huddles live right now. */
  calls?: ReactNode;
  workAction?: ReactNode;
  active: SidebarNavActive;
  tasks: NavSectionList;
  docs: NavSectionList;
  orgOn: boolean;
  /** The Org row's count of what waits on you; renders nothing at zero. */
  orgBadge?: ReactNode;
  /** Features the workspace's team never decided on (workspaceFeatureState
   *  "offer"): their row stays under More and opens the feature's landing. */
  offers?: { org?: boolean; line?: boolean };
  /** The active team has Changes on (teams.features.changes): its row sits under Feed. */
  changesOn?: boolean;
  /** The workspace has the Flows feature on (teams.features.line). */
  flowsOn?: boolean;
  /** The More toggle (lib/railFocus.ts): `focused` while every page past the
   *  six daily ones is folded away. Absent (the marketing hero), every row shows. */
  railMore?: { focused: boolean; onToggle: () => void };
  /** The workspace switcher, drawn above the rows. */
  workspaceHeader?: ReactNode;
}) {
  // Six daily surfaces lead; every other page sits under More, open or
  // folded as the person left it (ui.rail_everything). Nothing is removed:
  // each page stays reachable from More, search, the palette and links.
  const moreOpen = !!railMore && !railMore.focused;
  const row = (label: string, href: string, isActive: boolean | undefined, icon: ReactNode, extra?: { popped?: "work"; title?: string }) => (
    <NavSection label={label} href={href} isActive={!!isActive} isNarrow={isNarrow} onMobileClose={onMobileClose} icon={icon} {...extra} />
  );
  const icon = (I: typeof Flag) => <I className="w-4 h-4 flex-shrink-0" strokeWidth={1.75} />;
  const moreRows = (
    <>
      {threads}
      {feed}
      {changesOn && row("Changes", "/changes", active.changes, icon(Newspaper), { title: "Changes: what the team shipped and why, day by day" })}
      {row("Deploys", "/deploys", active.deploys, icon(Rocket), { title: "Deploys: what is live, and what waits to go out" })}
      {(flowsOn || offers?.line) && row("Flows", "/flows", active.line, icon(Waypoints), { title: "Flows: every change through steps your team can see" })}
      {row("Ops", "/ops", active.ops, icon(Radar), { title: "Ops: what is wrong in the running product right now" })}
      {row("Goals", "/goals", active.goals, icon(Flag), { popped: "work", title: "Goals: what the company is trying to move" })}
      {row("Projects", "/projects", active.projects, icon(FolderKanban), { popped: "work", title: "Projects: the work that moves the goals" })}
      {(orgOn || offers?.org) && (
        <NavSection label="Org" href="/org" isActive={active.org} popped="work" isNarrow={isNarrow} onMobileClose={onMobileClose}
          title="Org: who carries the work, people and agent roles" badge={orgOn ? orgBadge : undefined} icon={icon(Network)} />
      )}
      {row("Code", "/repo", active.code, icon(FolderGit2))}
      {row("Vault", "/vault", active.vault, icon(KeyRound))}
      {row("Pages", "/pages", active.pages, icon(Globe))}
      {row("Triggers", "/triggers", active.triggers, icon(Zap))}
      {row("Windows", "/windows", active.windows, icon(AppWindow))}
      {row("Files", "/files", active.files, icon(FolderOpen))}
    </>
  );
  return (
    <>
      {workspaceHeader && <div data-rail-workspace className={isNarrow ? "mx-1 mt-2 mb-2" : "mx-2 mt-2 mb-2"}>{workspaceHeader}</div>}
      <div className="text-sm" data-rail-group="primary">
        {scope === "work" ? null : (<>
          {row("Inbox", "/inbox", active.inbox, icon(Inbox), { title: "Inbox: every session, sorted by who acts next" })}
          {questions}
          {chat}
        </>)}
        <NavSection label="Tasks" href="/tasks" isActive={active.tasks} popped="work" isNarrow={isNarrow} onMobileClose={onMobileClose}
          headerAction={scope === "work" ? undefined : workAction}
          items={tasks.onDrill ? undefined : tasks.items} expanded={tasks.expanded} onToggle={tasks.onToggle} onDrill={tasks.onDrill} icon={<TasksNavIcon />} />
        <NavSection label="Docs" href="/docs" isActive={active.docs} popped="work" isNarrow={isNarrow} onMobileClose={onMobileClose}
          items={docs.items} expanded={docs.expanded} onToggle={docs.onToggle} icon={<DocsNavIcon />} />
        {scope === "work" ? null : calls}
      </div>
      {/* The Work window lists its own pages in full: More is the main
          window's way to reach everything else. */}
      {scope === "work" && (
        <div className="text-sm" data-rail-group="work">
          {row("Goals", "/goals", active.goals, icon(Flag))}
          {row("Projects", "/projects", active.projects, icon(FolderKanban))}
          {(orgOn || offers?.org) && (
            <NavSection label="Org" href="/org" isActive={active.org} isNarrow={isNarrow} onMobileClose={onMobileClose} badge={orgOn ? orgBadge : undefined} icon={icon(Network)} />
          )}
          {row("Code", "/repo", active.code, icon(FolderGit2))}
          {row("Vault", "/vault", active.vault, icon(KeyRound))}
          {row("Pages", "/pages", active.pages, icon(Globe))}
        </div>
      )}
      {railMore && scope !== "work" && (
        <button
          type="button"
          onClick={railMore.onToggle}
          aria-expanded={moreOpen}
          title={moreOpen ? "Fold the other pages away" : "Show every other page"}
          className={`${railRowClass(false, isNarrow)} mt-1 text-sm text-sol-text-dim`}
          data-rail-more
        >
          <ChevronRight className={`w-4 h-4 flex-shrink-0 transition-transform duration-150 ${moreOpen ? "rotate-90" : ""}`} strokeWidth={1.75} />
          {!isNarrow && <span>More</span>}
        </button>
      )}
      {scope !== "work" && (moreOpen || !railMore) && <div className="text-sm" data-rail-group="more">{moreRows}</div>}
    </>
  );
}
