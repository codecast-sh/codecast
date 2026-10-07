"use client";

/**
 * The rail's three groups (Conversations, Work, Agents) drawn from props: no
 * store reads, no queries. Sidebar fills it from the live app; a surface
 * outside the app (the marketing hero) feeds it fixtures. The rows that carry
 * live counts arrive as their own views, so a heartbeat re-renders one row,
 * never the rail.
 */

import type { ReactNode } from "react";
import Link from "next/link";
import { FolderGit2, Globe, Radar, Waypoints, Workflow, Zap, MessageSquare, MessagesSquare, FolderKanban, Flag, Newspaper } from "lucide-react";
import { RailHeading, NavCount, NavSection, type SectionRowSpec } from "./navPrimitives";
import { DocsNavIcon, TasksNavIcon } from "./navIcons";
import { TeamIcon } from "../TeamIcon";
import { paneDragProps, railRowClass } from "../../lib/railRow";
import { DEVELOPER_MODE, type SurfaceMode } from "../../lib/surfaceRules";

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
          <span className="absolute top-2 right-3 w-1.5 h-1.5 rounded-full bg-sol-cyan" aria-label={`${unread} threads with new replies`} />
        ) : null
      ) : (
        <>
          <span>Threads</span>
          {unread > 0 && <NavCount n={unread} tone="bg-sol-cyan text-sol-bg" />}
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
  unread,
}: {
  team: { name: string; icon?: string; icon_color?: string };
  isActive: boolean;
  isNarrow: boolean;
  unread?: number | null;
}) {
  return (
    <Link
      href="/team/activity"
      {...paneDragProps("/team/activity", "Activity")}
      className={railRowClass(isActive, isNarrow)}
      title={team.name}
    >
      <TeamIcon icon={team.icon} color={team.icon_color} className="w-5 h-5 flex-shrink-0" />
      {!isNarrow && (
        <>
          <span>Feed</span>
          {unread != null && unread > 0 && !isActive && (
            <NavCount n={unread} tone="bg-sol-cyan text-sol-bg" />
          )}
        </>
      )}
    </Link>
  );
}

/** The decision queue's row, with what waits on a person. The container hides it at zero. */
export function QuestionsNavRowView({
  isActive,
  isNarrow,
  onMobileClose,
  pending,
  label = "Questions",
  tip = "Decisions waiting on you",
}: {
  isActive: boolean;
  isNarrow: boolean;
  onMobileClose?: () => void;
  pending: number;
  /** The page's name in this mode (ModeWords.questionsPage). */
  label?: string;
  /** The row's tooltip in this mode (ModeWords.questionsTip). */
  tip?: string;
}) {
  return (
    <Link
      href="/questions"
      onClick={onMobileClose}
      {...paneDragProps("/questions", label)}
      className={railRowClass(isActive, isNarrow, "border-sol-violet")}
      title={tip}
    >
      <svg className="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
      {!isNarrow && (
        <>
          <span>{label}</span>
          {pending > 0 && <NavCount n={pending} tone="bg-sol-violet text-white" />}
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
}: {
  isActive: boolean;
  isNarrow: boolean;
  onMobileClose?: () => void;
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
    />
  );
}

/** A section that nests rows under it: the projects under Projects, the saved views under Tasks and Docs. */
export type NavSectionList = { items: SectionRowSpec[]; expanded: boolean; onToggle: () => void };

export type SidebarNavActive = {
  initiatives: boolean;
  projects: boolean;
  tasks: boolean;
  docs: boolean;
  code: boolean;
  files: boolean;
  pages: boolean;
  sessions: boolean;
  workflows: boolean;
  line: boolean;
  triggers: boolean;
  ops: boolean;
  org: boolean;
  /** Absent where the rail never shows Changes (the marketing hero). */
  changes?: boolean;
  rootAgent: boolean;
  windows: boolean;
};

/**
 * The rail's groups in order. Conversations takes its rows as rendered
 * elements (each reads its own live count); Work and Agents are the app's
 * fixed sections, with the lists that nest under Projects, Tasks and Docs.
 */
export function SidebarNavView({
  isNarrow,
  scope,
  onMobileClose,
  inbox,
  threads,
  feed,
  questions,
  chat,
  calls,
  workAction,
  active,
  projects,
  tasks,
  docs,
  orgOn,
  changesOn,
  agent,
  mode = DEVELOPER_MODE,
}: {
  isNarrow: boolean;
  scope?: "work";
  onMobileClose?: () => void;
  inbox: ReactNode;
  threads?: ReactNode;
  feed?: ReactNode;
  questions?: ReactNode;
  chat?: ReactNode;
  /** The Calls row and the huddles live right now. */
  calls?: ReactNode;
  workAction?: ReactNode;
  active: SidebarNavActive;
  projects: NavSectionList;
  tasks: NavSectionList;
  docs: NavSectionList;
  orgOn: boolean;
  /** The active team has Changes on (teams.features.changes): its row sits under Feed. */
  changesOn?: boolean;
  /** The workspace's agent: its name, its hover title and its face. */
  agent: { label: string; title: string; icon: ReactNode };
  /** Hosted mode's rows and words (lib/surfaces.ts); developer mode when absent. */
  mode?: SurfaceMode;
}) {
  const { words, page, showsPage, shows } = mode;
  const agentsGroup = shows("nav.agentsGroup");
  const routines = (
    <NavSection
      label={page("/triggers", "Triggers")}
      href="/triggers"
      isActive={active.triggers}
      isNarrow={isNarrow}
      onMobileClose={onMobileClose}
      icon={<Zap className="w-5 h-5 flex-shrink-0" strokeWidth={1.5} />}
    />
  );
  return (
    <>
      {scope === "work" ? null : (<>
      <RailHeading label="Conversations" isNarrow={isNarrow} />
      <div className="text-sm">
        {inbox}
        {shows("nav.threads") && threads}
        {shows("nav.feed") && feed}
        {changesOn && showsPage("/changes") && (
          <NavSection
            label={page("/changes", "Changes")}
            href="/changes"
            isActive={!!active.changes}
            isNarrow={isNarrow}
            onMobileClose={onMobileClose}
            title="Changes: what the team shipped and why, day by day"
            icon={<Newspaper className="w-5 h-5 flex-shrink-0" strokeWidth={1.5} />}
          />
        )}
        {questions}
        {chat}
        {calls}
      </div>

      </>)}
      {/* What you are working on. Projects leads: it is the container the rest
          of this group files into, so the rail reads top-down as project →
          its tasks → the docs and files around them. */}
      <RailHeading label="Work" isNarrow={isNarrow} action={workAction} />
      <div className="text-sm">
        {/* The goals above the projects (initiatives-projects-role-page.md I1). */}
        {shows("nav.initiatives") && <NavSection
          label={page("/goals", "Goals")}
          href="/goals"
          isActive={active.initiatives}
          popped="work"
          isNarrow={isNarrow}
          onMobileClose={onMobileClose}
          title="Goals: what the company is trying to reach"
          icon={<Flag className="w-5 h-5 flex-shrink-0" strokeWidth={1.5} />}
        />}
        {showsPage("/projects") && <NavSection
          label={page("/projects", "Projects")}
          href="/projects"
          isActive={active.projects}
          popped="work"
          isNarrow={isNarrow}
          onMobileClose={onMobileClose}
          items={projects.items}
          expanded={projects.expanded}
          onToggle={projects.onToggle}
          icon={<FolderKanban className="w-5 h-5 flex-shrink-0" strokeWidth={1.5} />}
        />}
        <NavSection
          label={page("/tasks", "Tasks")}
          href="/tasks"
          isActive={active.tasks}
          popped="work"
          isNarrow={isNarrow}
          onMobileClose={onMobileClose}
          items={tasks.items}
          expanded={tasks.expanded}
          onToggle={tasks.onToggle}
          icon={<TasksNavIcon />}
        />
        <NavSection
          label={page("/docs", "Docs")}
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
        {/* Hosted mode files the routines with the rest of the person's work. */}
        {!agentsGroup && scope !== "work" && routines}
        {showsPage("/repo") && <NavSection
          label={page("/repo", "Code")}
          href="/repo"
          isActive={active.code}
          isNarrow={isNarrow}
          onMobileClose={onMobileClose}
          icon={<FolderGit2 className="w-5 h-5 flex-shrink-0" strokeWidth={1.5} />}
        />}
        {showsPage("/files") && <NavSection
          label={page("/files", "Files")}
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
        {showsPage("/pages") && <NavSection
          label="Pages"
          href="/pages"
          isActive={active.pages}
          isNarrow={isNarrow}
          onMobileClose={onMobileClose}
          icon={<Globe className="w-5 h-5 flex-shrink-0" strokeWidth={1.5} />}
        />}
      </div>

      {/* The Work window keeps the pinned rail and the Work group, the
          two things its pages are reached through; the rest is the main
          window's. */}
      {scope === "work" || !agentsGroup ? null : (<>
      {/* The machinery that does the work: what is running right now, and the
          standing things that set it running. */}
      <RailHeading label={words.agentsGroup} isNarrow={isNarrow} />
      <div data-rail-group="agents" className="text-sm">
        {showsPage("/routines") && <NavSection
          label={page("/routines", "Workflows")}
          href="/routines"
          isActive={active.workflows}
          isNarrow={isNarrow}
          onMobileClose={onMobileClose}
          icon={<Workflow className="w-5 h-5 flex-shrink-0" strokeWidth={1.5} />}
        />}
        {showsPage("/line") && <NavSection
          label={page("/line", "Line")}
          href="/line"
          isActive={active.line}
          isNarrow={isNarrow}
          onMobileClose={onMobileClose}
          title="The line: from a signal to a shipped, watched change"
          icon={<Waypoints className="w-5 h-5 flex-shrink-0" strokeWidth={1.5} />}
        />}
        {routines}
        {showsPage("/ops") && <NavSection
          label={page("/ops", "Ops")}
          href="/ops"
          isActive={active.ops}
          isNarrow={isNarrow}
          onMobileClose={onMobileClose}
          title="Ops: your product's errors, checks, replays and metrics"
          icon={<Radar className="w-5 h-5 flex-shrink-0" strokeWidth={1.5} />}
        />}
        {orgOn && (<>
        <NavSection
          label={page("/org", "Org")}
          href="/org"
          isActive={active.org}
          isNarrow={isNarrow}
          onMobileClose={onMobileClose}
          title="Org — who reports to whom"
          icon={
            <svg className="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <rect x="9" y="3" width="6" height="4.5" rx="1" strokeWidth={1.5} />
              <rect x="3" y="16.5" width="6" height="4.5" rx="1" strokeWidth={1.5} />
              <rect x="15" y="16.5" width="6" height="4.5" rx="1" strokeWidth={1.5} />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 7.5V12M12 12H6v4.5M12 12h6v4.5" />
            </svg>
          }
        />
        <NavSection
          label={agent.label}
          href="/anchor"
          isActive={active.rootAgent}
          isNarrow={isNarrow}
          onMobileClose={onMobileClose}
          title={agent.title}
          icon={agent.icon}
        />
        </>)}
        {showsPage("/windows") && <NavSection
          label={page("/windows", "Windows")}
          href="/windows"
          isActive={active.windows}
          isNarrow={isNarrow}
          onMobileClose={onMobileClose}
          icon={
            <svg className="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 5a1 1 0 011-1h4a1 1 0 011 1v5a1 1 0 01-1 1H5a1 1 0 01-1-1V5zm10 0a1 1 0 011-1h4a1 1 0 011 1v3a1 1 0 01-1 1h-4a1 1 0 01-1-1V5zM4 16a1 1 0 011-1h4a1 1 0 011 1v3a1 1 0 01-1 1H5a1 1 0 01-1-1v-3zm10-2a1 1 0 011-1h4a1 1 0 011 1v5a1 1 0 01-1 1h-4a1 1 0 01-1-1v-5z" />
          </svg>
          }
        />}
      </div>
      </>)}
    </>
  );
}
