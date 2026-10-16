// The main window's spaces: the icon rail at the far left picks one, and the
// sidebar column beside it lists only that space's rows. Each space is one of
// the sidebar's groups (SidebarNav), and Chat is a space of its own whose
// column is the chat page's room list, so the sidebar column folds away there.
//
// The space follows the route: the page on screen names it, so the rail and
// the column can never disagree with what you are looking at.
// Pure: no React, no store.

export type NavSpace = "home" | "chat" | "work" | "agents";

const SPACE_ROUTES: Record<Exclude<NavSpace, "home">, string[]> = {
  chat: ["/chat"],
  work: ["/goals", "/projects", "/initiatives", "/org", "/tasks", "/plans", "/docs", "/repo", "/commit", "/pr", "/files", "/vault", "/pages", "/artifacts"],
  agents: ["/line", "/workflows", "/routines", "/triggers", "/schedules", "/ops", "/anchor", "/windows", "/sessions"],
};

/** Where a space opens the first time you go to it in a window. */
export const NAV_SPACE_LANDING: Record<NavSpace, string> = {
  home: "/inbox",
  chat: "/chat",
  work: "/tasks",
  agents: "/line",
};

/** The space a route belongs to. Anything no other space claims is home. */
export function navSpaceFor(pathname: string | null | undefined): NavSpace {
  const p = pathname ?? "";
  for (const space of Object.keys(SPACE_ROUTES) as Array<keyof typeof SPACE_ROUTES>) {
    if (SPACE_ROUTES[space].some((r) => p === r || p.startsWith(`${r}/`))) return space;
  }
  return "home";
}
