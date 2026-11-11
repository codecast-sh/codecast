"use client";

// The rail in the Modern interface style. components/Sidebar.tsx computes
// what both rails show (pins, saved views, bookmarks, folders, the short-rail
// facts) and hands it here when Modern is on; this draws it the Modern way:
// lib/navRegistry's groups and names, an Inbox row, a More level, Bookmarks
// and Folders folded behind their headings, Layouts only once there is one.
// The look lives in modernRail.css under [data-modern-rail], so Simple view's
// and Minimal's [data-sv-nav] rules keep to the classic rail.

import { lazy, memo, Suspense, useRef, type ReactNode, type Ref } from "react";
import { PhoneCall, Plus } from "lucide-react";
import { useInboxStore } from "../../store/inboxStore";
import { useCallsAvailable, useTeamFeature, useWorkspaceFeature, useWorkspaceFeatureState } from "../../lib/teamFeatures";
import { FOLDERS_HEADING, type NavGates } from "../../lib/navRegistry";
import { placeSection, RAIL_MORE_EVENT } from "../../lib/navPlace";
import { useMountEffect } from "../../hooks/useMountEffect";
import { sortedWorkbenches } from "../../lib/workbenchSwitch";
import { useNeedsInputCount } from "../../hooks/useNeedsInputCount";
import { useOwnedDecisionCount } from "../../hooks/useDecisionRows";
import { useThreadUnread } from "../../hooks/useThreadsSync";
import { useLiveRoomCount } from "../../hooks/useLiveRoomCount";
import { usePoppedOut } from "../../hooks/usePoppedOut";
import { useRailLevel } from "../../hooks/useRailLevel";
import { NavCount, NeedsInputCount, RailHeading, SectionRow, type SectionRowSpec } from "./navPrimitives";
import { ChatDrillList, ChatNavRow } from "./ChatNav";
import { SidebarDrillStack } from "./SidebarDrill";
import { ModernNavView, RegistryNavSection } from "./ModernNav";
import { MoreDrillList } from "./MoreNav";
import { RailFoldHeading } from "./modernRailParts";
import { ModSidebarSections } from "../mods/ModSidebarSections";
import { WorkbenchSection } from "../WorkbenchSection";
import { TeamSwitcher } from "../TeamSwitcher";
import { ErrorBoundary } from "../ErrorBoundary";
import { AppPopOutButton } from "../desktop/AppPopOutButton";
import "./modernRail.css";

const LiveNowRail = lazy(() => import("../calls/LiveNow").then((module) => ({ default: module.LiveNowRail })));
// The Ops count reads the Ops models, which the shell's first paint never needs.
const OpsRailCount = lazy(() => import("./OpsRailCount").then((module) => ({ default: module.OpsRailCount })));

/** What waits on you: a tinted pill. A count of replies: a red one. */
const NEEDS_YOU = "bg-sol-cyan/15 text-sol-cyan";
const UNREAD = "bg-sol-red/15 text-sol-red";

type RowProps = { isActive: boolean; isNarrow: boolean; onMobileClose?: () => void };

// Each live row is a leaf of its own: its count moves on its own clock (an
// agent asks, someone replies, a huddle starts), and that must re-render one
// row, not the rail.

/** The sessions that need you: the session rail's Questions and Needs You,
 *  mine-scoped (useNeedsInputCount, over wake signatures, never the raw
 *  sessions map). Silent at zero. */
export const ModernInboxRow = memo(function ModernInboxRow({ isActive, isNarrow, onMobileClose }: RowProps) {
  const needs = useNeedsInputCount();
  return <RegistryNavSection id="inbox" isActive={isActive} isNarrow={isNarrow} onMobileClose={onMobileClose} badge={needs > 0 ? <NavCount n={needs} tone={NEEDS_YOU} /> : undefined} />;
});

/** The open decisions you own. Always drawn: at zero the count goes, the row stays. */
const DecisionsRow = memo(function DecisionsRow({ isActive, isNarrow, onMobileClose }: RowProps) {
  const pending = useOwnedDecisionCount();
  return <RegistryNavSection id="decisions" isActive={isActive} isNarrow={isNarrow} onMobileClose={onMobileClose} badge={pending > 0 ? <NavCount n={pending} tone={NEEDS_YOU} /> : undefined} />;
});

/** Every conversation you are in, with how many moved. */
const ThreadsRow = memo(function ThreadsRow({ isActive, isNarrow, onMobileClose }: RowProps) {
  const unread = useThreadUnread();
  return <RegistryNavSection id="threads" isActive={isActive} isNarrow={isNarrow} onMobileClose={onMobileClose} badge={unread > 0 ? <NavCount n={unread} tone={UNREAD} /> : undefined} />;
});

/** Calls, with a still dot while a huddle is live (the rail runs no infinite
 *  animation), and Start huddle on hover or keyboard focus. In the Chat
 *  window while there is one. */
const CallsRow = memo(function CallsRow({ isActive, isNarrow, onMobileClose }: RowProps) {
  const live = useLiveRoomCount();
  const openCreateModal = useInboxStore((s) => s.openCreateModal);
  return (
    <RegistryNavSection
      id="calls"
      isActive={isActive}
      isNarrow={isNarrow}
      onMobileClose={onMobileClose}
      popped="chat"
      badge={live > 0 ? <span className="block w-2 h-2 mx-1.5 rounded-full bg-sol-green" aria-label="Live huddle" /> : undefined}
      headerAction={
        <button
          onClick={() => openCreateModal("huddle")}
          className="p-1 rounded text-sol-text-dim opacity-0 group-hover/nav:opacity-100 focus-visible:opacity-100 hover:text-sol-green transition-opacity"
          title="Start huddle"
          aria-label="Start huddle"
        >
          <PhoneCall className="w-3.5 h-3.5" />
        </button>
      }
    />
  );
});

/** The needs-you count on a level's Back row, so going in never hides it. */
const NeedsYouPeek = memo(function NeedsYouPeek() {
  return <NeedsInputCount n={useNeedsInputCount()} />;
});

export function ModernSidebar({
  isMobileOpen,
  onMobileClose,
  isNarrow,
  scope,
  peek,
  pathname,
  titlebarStripRef,
  pinnedRail,
  taskViewItems,
  docViewItems,
  decisionViewItems,
  viewSectionOverride,
  setViewSectionOverride,
  bookmarkRows,
  folderRows,
  appFooter,
  openCompose,
  counts,
  hasTeam,
  hasTeams,
  focus,
}: {
  isMobileOpen: boolean;
  onMobileClose?: () => void;
  isNarrow: boolean;
  scope?: "work";
  /** Drawn in the edge hover panel: Chat stays a row, not a level. */
  peek: boolean;
  pathname: string | null;
  titlebarStripRef: Ref<HTMLDivElement>;
  pinnedRail: ReactNode;
  taskViewItems: SectionRowSpec[];
  docViewItems: SectionRowSpec[];
  decisionViewItems: SectionRowSpec[];
  /** The person's open and shut sections (client_state.ui.nav_sections). */
  viewSectionOverride: Record<string, boolean>;
  setViewSectionOverride: (next: (cur: Record<string, boolean>) => Record<string, boolean>) => void;
  bookmarkRows: ReactNode;
  folderRows: ReactNode;
  appFooter: ReactNode;
  openCompose: () => void;
  counts: { bookmarks: number; folders: number };
  /** An active team: Activity is its feed. */
  hasTeam: boolean;
  /** Any team: the workspace switcher heads the rail. */
  hasTeams: boolean;
  /** A solo account's short rail (lib/railFocus.ts). */
  focus: { offered: boolean; focused: boolean };
}) {
  // Every page lights its section, an object page reached by link included
  // (a session lights Inbox, a teammate Org): lib/navPlace.
  const activeId = placeSection(pathname);
  const isChat = pathname === "/chat" || !!pathname?.startsWith("/chat/");
  const isTasks = pathname === "/tasks" || !!pathname?.startsWith("/tasks/");
  const isDocs = activeId === "docs";
  const isDecisions = pathname === "/decisions";

  // Every condition a row shows under, as the registry names them: the same
  // flags the classic rail reads.
  const chatOn = useTeamFeature("chat");
  const callsOn = useCallsAvailable();
  const changesOn = useTeamFeature("changes");
  const orgOn = useWorkspaceFeature("org");
  const orgOffer = useWorkspaceFeatureState("org") === "offer";
  const flowsOn = useWorkspaceFeature("line");
  const flowsOffer = useWorkspaceFeatureState("line") === "offer";
  const staff = useInboxStore((s) => (s.currentUser as { staff?: boolean } | null | undefined)?.staff === true);
  const gates: NavGates = {
    chat: chatOn, calls: callsOn, changes: changesOn, team: hasTeam, staff,
    org: orgOn || (orgOffer ? "offer" : false), line: flowsOn || (flowsOffer ? "offer" : false),
  };
  // Saving the first layout is the palette's; the rail lists them once there is one.
  const layoutCount = useInboxStore((s) => sortedWorkbenches({ savedViews: s.savedViews ?? {}, clientState: { ui: { active_team_id: s.clientState.ui?.active_team_id } } }).length);

  // Chat, Tasks and More are levels of the rail (SidebarDrill), open while the
  // route belongs to one or after the person opens one, never left over from
  // an earlier page (hooks/useRailLevel). A section in an app window of its
  // own stays a door to that window instead.
  const chatAway = usePoppedOut("chat");
  const workAway = usePoppedOut("work");
  const drillOn = !isNarrow;
  const chatDrills = drillOn && chatOn && !chatAway && !peek;
  const tasksDrill = drillOn && !workAway && taskViewItems.length > 0;
  const drill = useRailLevel<"chat" | "tasks" | "more">(isChat ? "chat" : isTasks ? "tasks" : null, { chat: chatDrills, tasks: tasksDrill, more: drillOn });
  // The "More" crumb above a page that lives there opens this level
  // (components/nav/PlaceCrumbs).
  const openMore = useRef(() => {});
  openMore.current = () => drill.open("more");
  useMountEffect(() => {
    const onMore = () => openMore.current();
    window.addEventListener(RAIL_MORE_EVENT, onMore);
    return () => window.removeEventListener(RAIL_MORE_EVENT, onMore);
  });

  const sectionOpen = (key: string, fallback: boolean) => viewSectionOverride[key] ?? fallback;
  const toggleSection = (key: string, fallback: boolean) => setViewSectionOverride((o) => ({ ...o, [key]: !(o[key] ?? fallback) }));
  const row = { isNarrow, onMobileClose };

  const nav = (
    <ModernNavView
      isNarrow={isNarrow}
      scope={scope}
      onMobileClose={onMobileClose}
      activeId={activeId}
      gates={gates}
      focused={focus.focused}
      onMore={drillOn ? () => drill.open("more") : undefined}
      live={{
        inbox: <ModernInboxRow isActive={activeId === "inbox"} {...row} />,
        decisions: (
          <>
            <DecisionsRow isActive={activeId === "decisions"} {...row} />
            {/* The page's saved views, while it is open. */}
            {!isNarrow && isDecisions && decisionViewItems.map((view) => <SectionRow key={view.id} row={view} className="pl-6" />)}
          </>
        ),
        threads: <ThreadsRow isActive={activeId === "threads"} {...row} />,
        chat: chatOn && (
          <ChatNavRow
            isActive={isChat}
            isNarrow={isNarrow}
            pathname={pathname}
            pinsShown={!isNarrow && !scope}
            expanded={sectionOpen("chat", isChat)}
            onToggle={() => toggleSection("chat", isChat)}
            onDrill={chatDrills ? () => drill.open("chat") : undefined}
            onMobileClose={onMobileClose}
          />
        ),
        calls: callsOn && (
          <>
            <CallsRow isActive={activeId === "calls"} {...row} />
            {/* The huddles running right now, one row each; nothing when none is live. */}
            <Suspense fallback={null}>
              <LiveNowRail isNarrow={isNarrow} onNavigate={onMobileClose} />
            </Suspense>
          </>
        ),
        activity: hasTeam && <RegistryNavSection id="activity" isActive={activeId === "activity"} {...row} />,
      }}
      tasks={{ items: taskViewItems, expanded: sectionOpen("tasks", isTasks), onToggle: () => toggleSection("tasks", isTasks), onDrill: tasksDrill ? () => drill.open("tasks") : undefined }}
      docs={{ items: docViewItems, expanded: sectionOpen("docs", isDocs), onToggle: () => toggleSection("docs", isDocs) }}
      opsBadge={<Suspense fallback={null}><OpsRailCount /></Suspense>}
      workAction={<AppPopOutButton app="work" className="-my-1" />}
      // A person in no team has one workspace and nothing to switch.
      workspaceHeader={hasTeams ? (
        <ErrorBoundary name="TeamSwitcher" level="inline">
          <TeamSwitcher variant="rail" isNarrow={isNarrow} />
        </ErrorBoundary>
      ) : undefined}
    />
  );

  const bookmarksOpen = sectionOpen("bookmarks", false);
  const foldersOpen = sectionOpen("folders", false);
  return (
    <nav
      data-modern-rail=""
      className={`h-full w-full pb-3 sm:pb-4 flex flex-col bg-sol-bg-alt select-none ${isMobileOpen ? "shadow-xl" : "hidden md:flex"}`}
    >
      {/* Zen mode on desktop: the rail is the leftmost surface, so a lent
          strip clears the traffic lights. */}
      <div ref={titlebarStripRef} className="titlebar-strip shrink-0" />
      <SidebarDrillStack
        level={drill.level}
        shown={drill.shown}
        label={drill.shown === "tasks" ? "Tasks" : drill.shown === "more" ? "More" : "Chat"}
        peek={<NeedsYouPeek />}
        onBack={drill.back}
        pane={drill.shown === "chat" ? (
          <ChatDrillList pathname={pathname} onMobileClose={onMobileClose} />
        ) : drill.shown === "tasks" ? (
          <>
            <RailHeading label="Saved views" isNarrow={false} />
            {taskViewItems.map((view) => <SectionRow key={view.id} row={view} />)}
          </>
        ) : drill.shown === "more" ? (
          <MoreDrillList
            activeId={activeId}
            gates={gates}
            focused={focus.focused}
            focusToggle={focus.offered ? () => useInboxStore.getState().updateClientUI({ rail_everything: focus.focused }) : undefined}
            onMobileClose={onMobileClose}
          />
        ) : null}
      >
        <div className="flex-1 flex flex-col min-h-0">
          {/* Pins lead the rail. */}
          {!isNarrow && pinnedRail}
          {nav}
          <ModSidebarSections isNarrow={isNarrow} />
          {scope === "work" ? null : (
            <>
              {!isNarrow && counts.bookmarks > 0 && (
                <div data-rail-group="bookmarks" className="mt-3">
                  <RailFoldHeading label="Bookmarks" open={bookmarksOpen} onToggle={() => toggleSection("bookmarks", false)} count={counts.bookmarks} />
                  {bookmarksOpen && bookmarkRows}
                </div>
              )}
              {/* Saved layouts (store/workbench.ts): the frame, not the work. */}
              {!focus.focused && layoutCount > 0 && <WorkbenchSection isNarrow={isNarrow} onMobileClose={onMobileClose} />}
              {!isNarrow && counts.folders > 0 && (
                <div data-rail-group="folders" className="mt-3">
                  <RailFoldHeading
                    label={FOLDERS_HEADING.label}
                    open={foldersOpen}
                    onToggle={() => toggleSection("folders", false)}
                    count={Math.min(counts.folders, 8)}
                    action={
                      <button
                        onClick={() => openCompose()}
                        className="p-0.5 rounded text-sol-text-dim hover:text-sol-text transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-sol-cyan/60"
                        title="New session"
                        aria-label="New session"
                      >
                        <Plus className="w-3.5 h-3.5" />
                      </button>
                    }
                  />
                  {foldersOpen && folderRows}
                </div>
              )}
            </>
          )}
        </div>
      </SidebarDrillStack>
      {appFooter}
    </nav>
  );
}
