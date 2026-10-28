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
  // Browsing a repository: history, source and blame all own their canvas.
  /^\/repo(\/|$)/,
  /^\/inbox(\/|$)/,
  // The decision queue deletes layout by construction: one card, full width.
  /^\/questions(\/|$)/,
  // A decision's document page and a stack own their reading column.
  /^\/decisions(\/|$)/,
  // The trial's review page: a card list beside the card, each its own scroll.
  /^\/trial$/,
  // The flows app owns its canvas: six stations side by side, each its own scroll.
  // Its settings page is the same floor, with its own index and scroll.
  // A trace (LX4) is the same canvas: the map beside the story.
  // A project's workspace (line-workspace.md LW1) owns its canvas too.
  /^\/(line|flows)(\/[^/]+|\/trace\/[^/]+)?$/,
  // Chat owns its whole canvas: three columns, each with its own scroll region.
  /^\/chat(\/|$)/,
  // The public rooms are the same three column surface.
  /^\/community(\/|$)/,
  // The Threads inbox: its own header and scroll region, chat-style.
  /^\/threads(\/|$)/,
  // Calls too: list · transcript · chat rail, each its own scroll region.
  /^\/calls(\/|$)/,
  /^\/tasks(\/|$)/,
  /^\/workflows(\/|$)/,
  /^\/routines(\/|$)/,
  /^\/triggers(\/|$)/,
  /^\/schedules(\/|$)/,
  /^\/plans(\/|$)/,
  /^\/docs(\/|$)/,
  /^\/capabilities$/,
  // Agent features: a category rail beside a card grid, its own scroll.
  /^\/agent-features$/,
  // The resource monitor: strip, table and review drawer, each its own scroll.
  /^\/resources$/,
  /^\/crosstalk$/,
  // A browser pane is all content: its own 32px address strip, then the page.
  /^\/browser$/,
  /^\/org(\/|$)/,
  // The daily edition sets its own 1180px column and scrolls itself.
  /^\/changes$/,
  /^\/goals(\/|$)/,
  // /vault is the team Vault; its old /vault?f=… Files links redirect to /files.
  /^\/files(\/|$)/,
  /^\/vault(\/|$)/,
  /^\/projects(\/|$)/,
  /^\/windows(\/|$)/,
  // Self-contained full-bleed pages: own dark background + wide (1200–1600px)
  // layouts and internal scroll regions. Centering them in a padded column
  // would break them.
  /^\/sessions(\/|$)/,
  // The session map: one zoomable canvas, edge to edge (components/sessionMap).
  /^\/map$/,
  /^\/anchor(\/|$)/,
  /^\/admin\//,
  // Agent config: file list + editor, owns its canvas the way /sessions does.
  /^\/config(\/|$)/,
  // Memory: project rail + map/index + editor, owns its canvas.
  /^\/memory(\/|$)/,
  // Evals: its own nav, wall and charts edge to edge, each view its own scroll.
  /^\/evals(\/|$)/,
  // Ops: its own tab bar, then a table, a timeline or a player edge to edge.
  /^\/ops(\/|$)/,
  // A mod's pane: its own header and scroll, edge to edge (components/mods).
  /^\/m\//,
  // Mod objects: a kind's list (its own wide column) and one object's page.
  /^\/objects\//,
  /^\/o\//,
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
  if (p === "/pages" || p === "/artifacts") return "max-w-6xl"; // card grid wants the wider column
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
    <div className="h-full flex flex-col">
      <div
        data-main-scroll
        className="flex-1 min-h-0 overflow-y-auto px-4 sm:px-6 lg:px-8 py-6"
      >
        <div className={`mx-auto w-full ${pageMaxWidth(pathname)}`}>{children}</div>
      </div>
    </div>
  );
}
