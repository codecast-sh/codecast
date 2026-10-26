"use client";

// The top bar's layout, as slots. The shell (DashboardLayout) fills them with
// the live controls; this file owns only where they sit and how far apart, so
// the whole row's rhythm is decided in one place.
//
//   nav · workspace + people  |  search  |  status · actions · panels
//
// Inside a zone controls sit 2px apart (they are one set); between zones a
// hairline or the zone gap, never both.
//
// The row never overlaps itself. The search zone holds at least its own
// controls (the search icon and New), so when the row runs out of room it
// overflows, and useSqueezeToFit sheds the lowest-value pieces until it fits
// again (levels in globals.css, `[data-cc-topbar-row][data-squeeze]`).

import { useRef, type ReactNode } from "react";
import { TopbarDivider } from "./TopbarButton";
import { useSqueezeToFit } from "../hooks/useSqueezeToFit";

/** How many shedding levels the top bar has; globals.css names each one. */
const TOPBAR_SQUEEZE_LEVELS = 4;

export function TopbarRow({
  nav,
  workspace,
  search,
  status,
  actions,
  panels,
}: {
  nav: ReactNode;
  workspace: ReactNode;
  search: ReactNode;
  status: ReactNode;
  actions: ReactNode;
  panels: ReactNode;
}) {
  const rowRef = useRef<HTMLDivElement>(null);
  useSqueezeToFit(rowRef, TOPBAR_SQUEEZE_LEVELS);
  return (
    <div ref={rowRef} data-cc-topbar-row className="px-2 sm:px-3 py-1 sm:py-1.5 flex items-center gap-1.5 sm:gap-3">
      <div className="flex items-center gap-0.5 flex-shrink-0">{nav}</div>
      <div className="hidden sm:flex items-center gap-2 flex-shrink-0 min-w-0">{workspace}</div>
      <div data-cc-topbar-search className="hidden sm:flex flex-1 items-center justify-center gap-2 min-w-min">{search}</div>
      <div data-cc-topbar-actions className="ml-auto flex items-center gap-1.5 sm:gap-3 flex-shrink-0">
        {status}
        <div data-cc-topbar-group className="flex items-center gap-0.5">{actions}</div>
        <TopbarDivider />
        <div data-cc-topbar-group className="flex items-center gap-0.5">{panels}</div>
      </div>
    </div>
  );
}
