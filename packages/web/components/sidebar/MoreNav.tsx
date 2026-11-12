"use client";

// The Modern rail's More level (SidebarDrill): the pages that are not rows of
// the rail itself, drawn from lib/navRegistry in its order. On a solo
// account's short rail (lib/railFocus.ts) the rows the rail leaves out come
// first, under their own group headings, and the level ends on the switch
// between the short rail and the whole one. No store reads: ModernSidebar
// hands in what it knows.

import { ChevronsDownUp, ChevronsUpDown } from "lucide-react";
import { RailHeading } from "./navPrimitives";
import { RegistryNavSection } from "./ModernNav";
import { NewMark, RailButtonRow } from "./modernRailParts";
import { RAIL_GROUPS, keptOnShortRail, navRowShown, navRowsIn, type NavGates, type NavGroup, type NavId } from "../../lib/navRegistry";

export function MoreDrillList({
  activeId,
  gates,
  focused,
  daily = false,
  focusToggle,
  onMobileClose,
}: {
  activeId: NavId | null;
  gates: NavGates;
  /** The short rail: the rows it leaves out are listed here too. */
  focused: boolean;
  /** Modern focused: the short rail keeps its daily pages too (keptOnShortRail). */
  daily?: boolean;
  /** A solo account's switch between the short rail and every page. */
  focusToggle?: () => void;
  onMobileClose?: () => void;
}) {
  const rowsOf = (group: NavGroup) =>
    navRowsIn(group).flatMap((row) => {
      if (group !== "more" && keptOnShortRail(row, daily)) return [];
      const on = navRowShown(row, gates);
      if (!on) return [];
      return [
        <RegistryNavSection
          key={row.id}
          id={row.id}
          isActive={activeId === row.id}
          isNarrow={false}
          onMobileClose={onMobileClose}
          badge={on === "offer" ? <NewMark /> : undefined}
        />,
      ];
    });
  const sections = [
    ...(focused ? RAIL_GROUPS.map(({ group, heading }) => ({ group, heading, rows: rowsOf(group) })) : []),
    { group: "more" as const, heading: focused ? "More" : null, rows: rowsOf("more") },
  ].filter((s) => s.rows.length > 0);
  return (
    <div data-rail-more-list="">
      {sections.map(({ group, heading, rows }) => (
        <div key={group} data-rail-group={`more-${group}`} className="mt-3 first:mt-0">
          {heading && <RailHeading label={heading} isNarrow={false} />}
          {rows}
        </div>
      ))}
      {focusToggle && (
        <div className="mt-3 pt-2 border-t border-sol-border/40">
          <RailButtonRow
            data-rail-focus-toggle=""
            icon={focused
              ? <ChevronsUpDown data-rail-icon="" aria-hidden className="w-4 h-4 flex-shrink-0" strokeWidth={1.75} />
              : <ChevronsDownUp data-rail-icon="" aria-hidden className="w-4 h-4 flex-shrink-0" strokeWidth={1.75} />}
            label={focused ? "Show every page in the rail" : "Keep the rail short"}
            title={focused ? "Show every page in the rail" : "Keep the rail to your inbox, decisions, tasks and docs"}
            isNarrow={false}
            onClick={focusToggle}
          />
        </div>
      )}
    </div>
  );
}
