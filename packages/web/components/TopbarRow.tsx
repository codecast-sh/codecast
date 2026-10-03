"use client";

// The top bar's layout, as slots. The shell (DashboardLayout) fills them with
// the live controls; this file owns only where they sit and how far apart, so
// the whole row's rhythm is decided in one place.
//
//   nav · workspace + people  |  search  |  status · actions · panels
//
// Inside a zone controls sit 2px apart (they are one set); between zones a
// hairline or the zone gap, never both.

import type { ReactNode } from "react";
import { TopbarDivider } from "./TopbarButton";

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
  return (
    <div data-cc-topbar-row className="px-2 sm:px-3 py-1 sm:py-1.5 flex items-center gap-1.5 sm:gap-3">
      <div className="flex items-center gap-0.5 flex-shrink-0">{nav}</div>
      <div className="hidden sm:flex items-center gap-2 flex-shrink-0 min-w-0">{workspace}</div>
      <div data-cc-topbar-search className="hidden sm:flex flex-1 justify-center min-w-0">{search}</div>
      <div data-cc-topbar-actions className="ml-auto flex items-center gap-1.5 sm:gap-3 flex-shrink-0">
        {status}
        <div data-cc-topbar-group className="flex items-center gap-0.5">{actions}</div>
        <TopbarDivider />
        <div data-cc-topbar-group className="flex items-center gap-0.5">{panels}</div>
      </div>
    </div>
  );
}
