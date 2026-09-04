import { createContext, useContext } from "react";

export function parseTabLocation(path: string) {
  const url = new URL(path, "https://codecast.local");
  return { pathname: url.pathname, searchParams: url.searchParams, hash: url.hash };
}

// Tab params context: overrides next/navigation hooks when inside a tab. Lives
// here, not in components/TabContent.tsx, so the router compat layer
// (src/compat/next-navigation.ts) never imports a component module — that
// edge wired the router into the component graph and made TabContent a failed
// Fast Refresh boundary (a context object + hook exported next to a component).

export const TabParamsCtx = createContext<{
  /** The tab this pane renders in — router calls from the pane navigate THIS
   *  tab, which matters for background (prewarm) panes mounted hidden. */
  tabId: string;
  pathname: string;
  params: Record<string, string>;
  searchParams: URLSearchParams;
  hash?: string;
  // Whether this is the currently-visible tab. Background tabs stay mounted
  // (display:none) so their scroll/state survive — a pane uses this to freeze
  // itself on its own route/params instead of following global view state.
  isActive: boolean;
  /** Pane-local routing. When set, `useRouter().push/replace` from inside the
   *  pane call this instead of moving the tab — how a page can be hosted in a
   *  workspace slot (the Files pane) and keep its URL-driven state. */
  navigate?: (path: string, mode: "push" | "replace") => void;
} | null>(null);

export function useTabContext() {
  return useContext(TabParamsCtx);
}
