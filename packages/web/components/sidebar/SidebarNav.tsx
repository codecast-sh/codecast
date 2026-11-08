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
import { ChevronsDown, ChevronsUp, Flag, FolderGit2, FolderKanban, Globe, KeyRound, Network, Radar, Waypoints, Zap, MessageSquare, MessagesSquare, Newspaper, Rocket } from "lucide-react";
import { RailHeading, NavCount, NavSection, type SectionRowSpec } from "./navPrimitives";
import { DocsNavIcon, TasksNavIcon } from "./navIcons";
import { TeamIcon } from "../TeamIcon";
import { paneDragProps, railRowClass } from "../../lib/railRow";
import { focusHidesPage } from "../../lib/railFocus";

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
}: {
  team: { name: string; icon?: string; icon_color?: string };
  isActive: boolean;
  isNarrow: boolean;
}) {
  return (
    <Link
      href="/team/activity"
      {...paneDragProps("/team/activity", "Activity")}
      className={railRowClass(isActive, isNarrow)}
      title={team.name}
    >
      <TeamIcon icon={team.icon} color={team.icon_color} className="w-5 h-5 flex-shrink-0" />
      {!isNarrow && <span>Feed</span>}
    </Link>
  );
}

/** The decision queue's row, with what waits on a person. The container hides it at zero. */
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
          {pending > 0 && <NavCount n={pending} tone="bg-teal-600 text-white" />}
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
   *  "offer"): their row stays, marked new, and opens the feature's landing. */
  offers?: { org?: boolean; line?: boolean };
  /** The active team has Changes on (teams.features.changes): its row sits under Feed. */
  changesOn?: boolean;
  /** The workspace has the Flows feature on (teams.features.line). */
  flowsOn?: boolean;
  /** A solo account's More/Fewer row (lib/railFocus.ts): `focused` while the
   *  team and fleet rows are folded away. Absent for everyone else. */
  railMore?: { focused: boolean; onToggle: () => void };
  /** The workspace switcher, drawn as the header of the block of rows whose
   *  content follows it. Absent (the marketing hero), the rows render unboxed. */
  workspaceHeader?: ReactNode;
}) {
  // A solo account's focused rail leaves the team and fleet rows to More (lib/railFocus.ts).
  const focused = !!railMore?.focused;
  const shown = (path: string) => !focused || !focusHidesPage(path);
  return (
    <>
      {/* Rows that read every workspace you are in, whichever is active. */}
      {scope === "work" ? null : (
        <div className="text-sm" data-rail-group="everywhere">
          {questions}
        </div>
      )}
      {/* Everything inside this block shows the active workspace only: its
          header is the switcher, so the layout says what a switch changes. */}
      <WorkspaceBlock header={workspaceHeader} isNarrow={isNarrow}>
      {scope === "work" ? null : (<>
      <div className="text-sm">
        {shown("/threads") && threads}
        {shown("/feed") && feed}
        {changesOn && shown("/changes") && (
          <NavSection
            label="Changes"
            href="/changes"
            isActive={!!active.changes}
            isNarrow={isNarrow}
            onMobileClose={onMobileClose}
            title="Changes: what the team shipped and why, day by day"
            icon={<Newspaper className="w-5 h-5 flex-shrink-0" strokeWidth={1.5} />}
          />
        )}
        {shown("/deploys") && (
          <NavSection
            label="Deploys"
            href="/deploys"
            isActive={!!active.deploys}
            isNarrow={isNarrow}
            onMobileClose={onMobileClose}
            title="Deploys: what is live, and what waits to go out"
            icon={<Rocket className="w-5 h-5 flex-shrink-0" strokeWidth={1.5} />}
          />
        )}
        {shown("/flows") && (flowsOn || offers?.line) && <NavSection
          label="Flows"
          href="/flows"
          isActive={active.line}
          isNarrow={isNarrow}
          onMobileClose={onMobileClose}
          title="Flows: every change through steps your team can see"
          badge={offers?.line ? <NewMark /> : undefined}
          icon={<Waypoints className="w-5 h-5 flex-shrink-0" strokeWidth={1.5} />}
        />}
        {/* Ops is its own area: the running product, beside the team's own streams, above chat and calls so the live huddles' heading never sits over it. */}
        <NavSection
          label="Ops"
          href="/ops"
          isActive={!!active.ops}
          isNarrow={isNarrow}
          onMobileClose={onMobileClose}
          title="Ops: what is wrong in the running product right now"
          icon={<Radar className="w-5 h-5 flex-shrink-0" strokeWidth={1.5} />}
        />
        {chat}
        {calls}
      </div>

      </>)}
      {/* What you are working on. Org leads: the company the rest of this
          group files into, then its tasks and the docs and files around them. */}
      {/* One hover group for the heading and its rows: pointing anywhere in
          Work reveals the heading's pop-out, since the window holds all of it. */}
      <div data-rail-group="work" className="group/rail mt-2 first:mt-0">
      <RailHeading label="Work" isNarrow={isNarrow} action={workAction} />
      <div className="text-sm">
        {/* Goals and projects are work in their own right: they need no org.
            Org is the people and agent roles who carry them. */}
        {shown("/goals") && <NavSection
          label="Goals"
          href="/goals"
          isActive={!!active.goals}
          popped="work"
          isNarrow={isNarrow}
          onMobileClose={onMobileClose}
          title="Goals: what the company is trying to move"
          icon={<Flag className="w-5 h-5 flex-shrink-0" strokeWidth={1.5} />}
        />}
        {shown("/projects") && <NavSection
          label="Projects"
          href="/projects"
          isActive={!!active.projects}
          popped="work"
          isNarrow={isNarrow}
          onMobileClose={onMobileClose}
          title="Projects: the work that moves the goals"
          icon={<FolderKanban className="w-5 h-5 flex-shrink-0" strokeWidth={1.5} />}
        />}
        {shown("/org") && (orgOn || offers?.org) && <NavSection
          label="Org"
          href="/org"
          isActive={active.org}
          popped="work"
          isNarrow={isNarrow}
          onMobileClose={onMobileClose}
          title="Org: who carries the work, people and agent roles"
          badge={orgOn ? orgBadge : <NewMark />}
          icon={<Network className="w-5 h-5 flex-shrink-0" strokeWidth={1.5} />}
        />}
        <NavSection
          label="Tasks"
          href="/tasks"
          isActive={active.tasks}
          popped="work"
          isNarrow={isNarrow}
          onMobileClose={onMobileClose}
          items={tasks.onDrill ? undefined : tasks.items}
          expanded={tasks.expanded}
          onToggle={tasks.onToggle}
          onDrill={tasks.onDrill}
          icon={<TasksNavIcon />}
        />
        <NavSection
          label="Docs"
          href="/docs"
          isActive={active.docs}
          popped="work"
          isNarrow={isNarrow}
          onMobileClose={onMobileClose}
          items={docs.items}
          expanded={docs.expanded}
          onToggle={docs.onToggle}
          icon={<DocsNavIcon />}
        />
        {shown("/repo") && <NavSection
          label="Code"
          href="/repo"
          isActive={active.code}
          isNarrow={isNarrow}
          onMobileClose={onMobileClose}
          icon={<FolderGit2 className="w-5 h-5 flex-shrink-0" strokeWidth={1.5} />}
        />}
        <NavSection
          label="Vault"
          href="/vault"
          isActive={!!active.vault}
          isNarrow={isNarrow}
          onMobileClose={onMobileClose}
          icon={<KeyRound className="w-5 h-5 flex-shrink-0" strokeWidth={1.5} />}
        />
        {shown("/pages") && <NavSection
          label="Pages"
          href="/pages"
          isActive={active.pages}
          isNarrow={isNarrow}
          onMobileClose={onMobileClose}
          icon={<Globe className="w-5 h-5 flex-shrink-0" strokeWidth={1.5} />}
        />}
      </div>
      </div>
      </WorkspaceBlock>

      {/* The Work window keeps the pinned rail and the Work group, the
          two things its pages are reached through; the rest is the main
          window's. */}
      {scope === "work" || focused ? null : (<>
      {/* The machinery that does the work: what is running right now, and the
          standing things that set it running. */}
      <RailHeading label="Agents" isNarrow={isNarrow} />
      <div data-rail-group="agents" className="text-sm">
        <NavSection
          label="Triggers"
          href="/triggers"
          isActive={active.triggers}
          isNarrow={isNarrow}
          onMobileClose={onMobileClose}
          icon={<Zap className="w-5 h-5 flex-shrink-0" strokeWidth={1.5} />}
        />
        <NavSection
          label="Windows"
          href="/windows"
          isActive={active.windows}
          isNarrow={isNarrow}
          onMobileClose={onMobileClose}
          icon={
            <svg className="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 5a1 1 0 011-1h4a1 1 0 011 1v5a1 1 0 01-1 1H5a1 1 0 01-1-1V5zm10 0a1 1 0 011-1h4a1 1 0 011 1v3a1 1 0 01-1 1h-4a1 1 0 01-1-1V5zM4 16a1 1 0 011-1h4a1 1 0 011 1v3a1 1 0 01-1 1H5a1 1 0 01-1-1v-3zm10-2a1 1 0 011-1h4a1 1 0 011 1v5a1 1 0 01-1 1h-4a1 1 0 01-1-1v-5z" />
          </svg>
          }
        />
        {shown("/files") && <NavSection
          label="Files"
          href="/files"
          isActive={active.files}
          isNarrow={isNarrow}
          onMobileClose={onMobileClose}
          icon={
            <svg className="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 13h6m-6 3h4" />
            </svg>
          }
        />}
      </div>
      </>)}
      {railMore && scope !== "work" && (
        <button
          type="button"
          onClick={railMore.onToggle}
          title={railMore.focused ? "Show every page in the rail" : "Keep the rail to your sessions and work"}
          className={`${railRowClass(false, isNarrow)} mt-2 text-sm text-sol-text-dim`}
          data-rail-more
        >
          {railMore.focused
            ? <ChevronsDown className="w-5 h-5 flex-shrink-0" strokeWidth={1.5} />
            : <ChevronsUp className="w-5 h-5 flex-shrink-0" strokeWidth={1.5} />}
          {!isNarrow && <span>{railMore.focused ? "More" : "Fewer"}</span>}
        </button>
      )}
    </>
  );
}

/** A feature row's mark while its team has not decided on it. */
function NewMark() {
  return <span className="text-[10px] font-semibold tracking-wide px-1.5 h-[16px] inline-flex items-center rounded-md" style={{ color: "var(--sol-cyan)", background: "color-mix(in srgb, var(--sol-cyan) 14%, transparent)" }} data-feature-new>NEW</span>;
}

/** The block of rail rows that follow the active workspace, under the
 *  switcher as its header. A hairline frame: the crest carries the color. */
function WorkspaceBlock({ header, isNarrow, children }: { header?: ReactNode; isNarrow: boolean; children: ReactNode }) {
  if (!header) return <>{children}</>;
  return (
    <div data-rail-workspace className={`${isNarrow ? "mx-1" : "mx-2"} mt-3 mb-1 overflow-hidden rounded-lg border border-sol-border/50 pb-1`}>
      <div className="border-b border-sol-border/40">{header}</div>
      {children}
    </div>
  );
}
