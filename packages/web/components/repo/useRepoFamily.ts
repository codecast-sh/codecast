import { useLocation } from "react-router";
import { useTabContext } from "../../lib/tabParams";
import { repoFamilyOf, type RepoRouteFamily } from "../../lib/repoView";

/**
 * Where this repository page actually is, and which of its two forms that
 * makes it: the app form under /repo inside the dashboard, or the standalone
 * form under /r, outside every shell.
 *
 * It reads the pane's own path when the page is mounted in a tab, and the real
 * URL otherwise. It must NOT use `usePathname`, which answers with the ACTIVE
 * TAB's path whenever any tab exists — on /r there is no tab shell, so that
 * answer names a page in another window entirely, and a standalone page read
 * itself as the app form and drew the whole dashboard around itself.
 */
export function useRepoLocation(): {
  pathname: string;
  search: string;
  hash: string;
  family: RepoRouteFamily;
} {
  const tab = useTabContext();
  const location = useLocation();
  const pathname = tab ? tab.pathname : location.pathname;
  const query = tab ? tab.searchParams.toString() : location.search.replace(/^\?/, "");
  const hash = tab ? tab.hash ?? "" : location.hash;
  return { pathname, search: query ? `?${query}` : "", hash, family: repoFamilyOf(pathname) };
}

/** Every href builder takes this, so a link never leaves the family it is in. */
export function useRepoFamily(): RepoRouteFamily {
  return useRepoLocation().family;
}
