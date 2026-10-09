// Pages whose address changed. The router redirects an old address
// (lib/laneRedirect.ts), and a reader of a stored path (a tab, a recent
// visit, a saved link) reads it through currentPagePath. Imports nothing, so
// any path reader may use it.
//
// The company's pages became one screen, Org: the goals list is its Goals
// filter, the projects list its Projects filter, the team directory its
// People filter, and a goal opens as a sheet on it (/goals/in-7 is
// /org/in-7). A project's board (/projects/<pj-…>) and a teammate's activity
// profile (/team/<handle>) keep their own pages.

/** An old root and everything under it moved together: the root to `page`,
 *  a path under it to the same path under `under`. */
export const RENAMED_PAGE_ROOTS: Readonly<Record<string, { page: string; under: string }>> = {
  "/goals": { page: "/org?lens=goals", under: "/org" },
  "/initiatives": { page: "/org?lens=goals", under: "/org" },
};

/** Old pages that moved alone: the paths under them are still their own
 *  pages (/projects/<pj-…> is the board, /team/<handle> the profile). */
export const RENAMED_PAGES: Readonly<Record<string, string>> = {
  "/projects": "/org?lens=projects",
  "/team": "/org?lens=people",
  "/company": "/org",
  "/roadmap": "/org?lens=goals",
};

/** `target` with the visitor's query and fragment added; a target that
 *  carries its own query keeps it first. */
function withRest(target: string, rest: string): string {
  if (!rest) return target;
  if (rest.startsWith("?") && target.includes("?")) return `${target}&${rest.slice(1)}`;
  return target + rest;
}

/** `path` at its page's current address, query and fragment kept; any other path as it is. */
export function currentPagePath(path: string): string {
  const cut = path.search(/[?#]/);
  const raw = cut === -1 ? path : path.slice(0, cut);
  const rest = cut === -1 ? "" : path.slice(cut);
  const pathname = raw.length > 1 ? raw.replace(/\/+$/, "") : raw;
  if (RENAMED_PAGES[pathname]) return withRest(RENAMED_PAGES[pathname], rest);
  for (const [from, to] of Object.entries(RENAMED_PAGE_ROOTS)) {
    if (pathname === from) return withRest(to.page, rest);
    if (pathname.startsWith(`${from}/`)) return to.under + pathname.slice(from.length) + rest;
  }
  return path;
}
