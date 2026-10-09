// Pages whose address changed. The router redirects an old address
// (lib/laneRedirect.ts), and a reader of a stored path (a tab, a recent
// visit, a saved link) reads it through currentPagePath. Imports nothing, so
// any path reader may use it.
//
// The company's pages live under Org: the goals list is /org/goals and a goal
// opens there (/goals/in-7 is /org/goals/in-7), the projects list is
// /org/projects, and the team directory and the company document are the Org
// canvas itself. A project's board (/projects/<pj-…>) and a teammate's
// activity profile (/team/<handle>) keep their own pages.

/** An old root and everything under it moved together: the root and a path
 *  under it keep their shape under the new root. */
export const RENAMED_PAGE_ROOTS: Readonly<Record<string, string>> = {
  "/goals": "/org/goals",
  "/initiatives": "/org/goals",
};

/** Old pages that moved alone: the paths under them are still their own
 *  pages (/projects/<pj-…> is the board, /team/<handle> the profile). */
export const RENAMED_PAGES: Readonly<Record<string, string>> = {
  "/projects": "/org/projects",
  "/team": "/org",
  "/company": "/org",
  "/roadmap": "/org/goals",
};

/** `path` at its page's current address, query and fragment kept; any other path as it is. */
export function currentPagePath(path: string): string {
  const cut = path.search(/[?#]/);
  const raw = cut === -1 ? path : path.slice(0, cut);
  const rest = cut === -1 ? "" : path.slice(cut);
  const pathname = raw.length > 1 ? raw.replace(/\/+$/, "") : raw;
  if (RENAMED_PAGES[pathname]) return RENAMED_PAGES[pathname] + rest;
  for (const [from, to] of Object.entries(RENAMED_PAGE_ROOTS)) {
    if (pathname === from || pathname.startsWith(`${from}/`)) return to + pathname.slice(from.length) + rest;
  }
  return path;
}
