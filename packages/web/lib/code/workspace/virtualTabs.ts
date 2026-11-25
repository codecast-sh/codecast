// Tabs that are not files. A workspace tab is named by its path; a virtual
// tab's path starts with a colon, which no vault-relative path the tree lists
// does, so it rides the same tabs, groups, splits, Cmd-W and recency list as a
// file while every file-only path (the address bar, the tree, quick open's
// recents, persistence across a reload) leaves it out.

/** The project search results editor (components/code/search). */
export const SEARCH_RESULTS_TAB = ":search-results";

export const isVirtualTab = (path: string | null | undefined): boolean => !!path && path.startsWith(":");

export function virtualTabTitle(path: string): string {
  return path === SEARCH_RESULTS_TAB ? "Search results" : path.slice(1);
}
