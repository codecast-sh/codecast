"use client";

/**
 * The Modern rail's rows, drawn from props: no store reads, no queries.
 * Which rows exist, their order, names and icons come from lib/navRegistry:
 * Inbox, Decisions and Threads unheaded at the top, then Team, Work,
 * Automation and Code & Ops, then More, which opens a level of its own. The
 * rows that carry live counts arrive as their own elements (ModernSidebar),
 * so a heartbeat re-renders one row, never the rail. Rows are the classic
 * rail's NavSection; components/sidebar/modernRail.css gives them the Modern
 * look under [data-modern-rail].
 */

import { NewSessionButton } from "../inbox/NewSessionButton";
import { Fragment, type ComponentProps, type ReactNode } from "react";
import { NavSection, RailHeading } from "./navPrimitives";
import type { NavSectionList } from "./SidebarNav";
import { RailIcon } from "./RailIcon";
import { NewMark, RailButtonRow } from "./modernRailParts";
import { RAIL_GROUPS, keptOnShortRail, navRow, navRowShown, navRowsIn, type NavGates, type NavId, type NavRow } from "../../lib/navRegistry";

/** A registry row as a rail row: its name, address, icon and hover text from
 *  lib/navRegistry, the rest from the caller. */
export function RegistryNavSection({ id, ...rest }: { id: NavId } & Omit<ComponentProps<typeof NavSection>, "label" | "href" | "icon">) {
  const row = navRow(id);
  return <NavSection label={row.label} href={row.path} icon={<RailIcon name={row.icon} />} title={row.title} {...rest} />;
}

/** The rows whose live counts the caller renders and hands in. */
type LiveRowId = "inbox" | "decisions" | "threads" | "chat" | "calls" | "activity";

export function ModernNavView({
  isNarrow,
  scope,
  onMobileClose,
  live,
  activeId,
  gates,
  tasks,
  docs,
  orgBadge,
  opsBadge,
  workAction,
  focused = false,
  daily = false,
  onMore,
  workspaceHeader,
}: {
  isNarrow: boolean;
  /** The Work window draws the Work group alone. */
  scope?: "work";
  onMobileClose?: () => void;
  /** The live rows, each already rendered; absent or false where its gate is
   *  off (chat, calls, an active team). */
  live: Partial<Record<LiveRowId, ReactNode>>;
  /** The row the current page lights (navActiveId). */
  activeId: NavId | null;
  /** The gates the drawn rows answer to (org and Flows may be "offer"). */
  gates: NavGates;
  tasks: NavSectionList;
  docs: NavSectionList;
  /** The Org row's count of what waits on you; renders nothing at zero. */
  orgBadge?: ReactNode;
  /** The Ops row's count of what is wrong now; renders nothing at zero. */
  opsBadge?: ReactNode;
  /** The Work heading's pop-out to its own window. */
  workAction?: ReactNode;
  /** A solo account's short rail (lib/railFocus.ts): only the registry's
   *  "keep" rows, everything else behind More. */
  focused?: boolean;
  /** Modern focused: the short rail keeps its daily pages too (keptOnShortRail). */
  daily?: boolean;
  /** Opens the More level. */
  onMore?: () => void;
  /** The workspace switcher, the header of everything under it. */
  workspaceHeader?: ReactNode;
}) {
  const activeRow = activeId ? navRow(activeId) : null;
  // More is lit while the page you are on lives behind it.
  const moreLit = !!activeRow && (activeRow.group === "more" || (focused && !keptOnShortRail(activeRow, daily)));

  const rowEl = (row: NavRow): ReactNode => {
    if (focused && !keptOnShortRail(row, daily)) return null;
    if (row.id in LIVE_IDS) return live[row.id as LiveRowId] || null;
    const on = navRowShown(row, gates);
    if (!on) return null;
    const list = row.id === "tasks" ? tasks : row.id === "docs" ? docs : null;
    return (
      <RegistryNavSection
        id={row.id}
        isActive={activeId === row.id}
        isNarrow={isNarrow}
        onMobileClose={onMobileClose}
        popped={row.group === "work" ? "work" : undefined}
        badge={on === "offer" ? <NewMark /> : row.id === "org" ? orgBadge : row.id === "ops" ? opsBadge : undefined}
        // Tasks drills into its saved views; Docs lists its own.
        items={list && !list.onDrill ? list.items : undefined}
        expanded={list?.expanded}
        onToggle={list?.onToggle}
        onDrill={list?.onDrill}
      />
    );
  };

  const group = (name: (typeof RAIL_GROUPS)[number]["group"], heading: string | null) => {
    const rows = navRowsIn(name).flatMap((row) => {
      const el = rowEl(row);
      return el ? [<Fragment key={row.id}>{el}</Fragment>] : [];
    });
    if (rows.length === 0) return null;
    return (
      // The Work group is one hover group with its heading, so pointing
      // anywhere in it reveals the heading's pop-out (its window holds all of it).
      <div key={name} data-rail-group={name} className={heading ? `mt-3${name === "work" ? " group/rail" : ""}` : undefined}>
        {heading && <RailHeading label={heading} isNarrow={isNarrow} action={name === "work" ? workAction : undefined} />}
        {rows}
      </div>
    );
  };

  if (scope === "work") return <>{group("work", "Work")}</>;
  return (
    <>
      {workspaceHeader && (
        <div data-rail-workspace="" className={`${isNarrow ? "mx-1" : "mx-2"} mb-2 overflow-hidden rounded-lg border border-sol-border/50`}>
          {workspaceHeader}
        </div>
      )}
      <div data-rail-new-session="" className={`${isNarrow ? "mx-1 flex justify-center" : "mx-2"} mb-2`}>
        <NewSessionButton variant={isNarrow ? "icon" : "row"} />
      </div>
      {RAIL_GROUPS.map(({ group: name, heading }) => group(name, heading))}
      <div className="mt-3">
        <RailButtonRow
          data-rail-more=""
          icon={<RailIcon name="Ellipsis" />}
          label="More"
          title={focused ? "More: every other page" : "More pages"}
          drill
          isActive={moreLit}
          isNarrow={isNarrow}
          onClick={onMore}
        />
      </div>
    </>
  );
}

const LIVE_IDS: Record<LiveRowId, true> = { inbox: true, decisions: true, threads: true, chat: true, calls: true, activity: true };
