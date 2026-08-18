import { createContext, useContext } from "react";

// Tab params context: overrides next/navigation hooks when inside a tab. Lives
// here, not in components/TabContent.tsx, so the router compat layer
// (src/compat/next-navigation.ts) never imports a component module — that
// edge wired the router into the component graph and made TabContent a failed
// Fast Refresh boundary (a context object + hook exported next to a component).

export const TabParamsCtx = createContext<{
  pathname: string;
  params: Record<string, string>;
  searchParams: URLSearchParams;
  // Whether this is the currently-visible tab. Background tabs stay mounted
  // (display:none) so their scroll/state survive — a pane uses this to freeze
  // itself on its own route/params instead of following global view state.
  isActive: boolean;
} | null>(null);

export function useTabContext() {
  return useContext(TabParamsCtx);
}
