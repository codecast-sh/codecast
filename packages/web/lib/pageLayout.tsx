import { ReactNode } from "react";

// A route is "full-width" when the page owns its entire canvas — its own scroll
// container, width, padding, and sometimes its own background (the zinc-themed
// sessions / admin pages). Those render bare. Every *other* view gets the shared
// PageShell so it is consistently inset from the chrome and centered.
//
// This is the single source of truth for that classification, shared by the tab
// shell (TabContent) and the legacy non-tab path (DashboardLayout) so a page can
// never pad in one render mode and go edge-to-edge in the other.
const FULL_WIDTH_PATTERNS: RegExp[] = [
  /^\/conversation\//,
  /^\/commit\//,
  /^\/pr\//,
  /^\/inbox(\/|$)/,
  /^\/tasks(\/|$)/,
  /^\/workflows(\/|$)/,
  /^\/routines(\/|$)/,
  /^\/schedules(\/|$)/,
  /^\/plans(\/|$)/,
  /^\/docs(\/|$)/,
  /^\/projects(\/|$)/,
  /^\/windows(\/|$)/,
  // Self-contained full-bleed pages: own dark background + wide (1200–1600px)
  // layouts and internal scroll regions. Centering them in a padded column
  // would break them.
  /^\/sessions(\/|$)/,
  /^\/anchor(\/|$)/,
  /^\/admin\//,
];

function routePath(pathname: string): string {
  return (pathname || "").split("?")[0].split("#")[0];
}

export function isFullWidthRoute(pathname: string): boolean {
  return FULL_WIDTH_PATTERNS.some((re) => re.test(routePath(pathname)));
}

// Per-route content width. Most reading/list views want a comfortable column;
// the team page packs wider cards.
function pageMaxWidth(pathname: string): string {
  const p = routePath(pathname);
  if (p === "/team" || p.startsWith("/team/")) return "max-w-6xl";
  return "max-w-4xl";
}

// The global page frame for non-full-width views: one scroll container, symmetric
// edge padding, and a centered max-width column. `data-main-scroll` marks it as
// the page's primary scroller (same marker the inbox and old non-tab path use).
export function PageShell({
  pathname,
  children,
}: {
  pathname: string;
  children: ReactNode;
}) {
  return (
    <div
      data-main-scroll
      className="h-full overflow-y-auto px-4 sm:px-6 lg:px-8 py-6"
    >
      <div className={`mx-auto w-full ${pageMaxWidth(pathname)}`}>{children}</div>
    </div>
  );
}
