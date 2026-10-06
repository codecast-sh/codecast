// Pages whose address changed. An old root and everything under it name the
// same page as the new root (/initiatives/in-7 is /goals/in-7): the router
// redirects an old address (lib/laneRedirect.ts), and a reader of a stored
// path (a tab, a recent visit, a saved link) reads it through currentPagePath.
// Imports nothing, so any path reader may use it.
export const RENAMED_PAGE_ROOTS: Readonly<Record<string, string>> = {
  "/initiatives": "/goals",
};

/** `path` under its page's current root, query and fragment kept; any other path as it is. */
export function currentPagePath(path: string): string {
  for (const [from, to] of Object.entries(RENAMED_PAGE_ROOTS)) {
    if (path.startsWith(from) && /^([/?#]|$)/.test(path.slice(from.length, from.length + 1))) return to + path.slice(from.length);
  }
  return path;
}
