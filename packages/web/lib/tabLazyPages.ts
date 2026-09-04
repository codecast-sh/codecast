// The tab shell's lazy route registry, and the warm-up that imports every one.
//
// Its own module so TabContent.tsx stays a Fast Refresh boundary: a .tsx file
// exporting `warmTabRoutes` alongside its components remounted every tab on an
// unrelated edit. The registry has to live here too — `warmTabRoutes` walks the
// same map `lazyPage` fills, and a second copy would warm nothing.
import { lazy, type ComponentType, type LazyExoticComponent } from "react";

// The lazy wrappers are cached on globalThis rather than recreated on every
// module execution. In dev, a hot update that re-executes the caller would
// otherwise mint new lazy components: React sees a new element type for every
// pane, unmounts the page through its Suspense fallback and mounts it again —
// a blank flash and lost page state (open dialogs, scroll) on an unrelated
// edit. Keyed by page path, so a genuinely new route still gets a fresh lazy.
const lazyPages: Map<string, LazyExoticComponent<ComponentType<any>>> =
  ((globalThis as any).__codecastLazyPages ??= new Map());
const lazyLoaders = new Map<string, () => Promise<unknown>>();

export function lazyPage(key: string, loader: () => Promise<{ default: ComponentType<any> }>) {
  lazyLoaders.set(key, loader);
  let c = lazyPages.get(key);
  if (!c) { c = lazy(loader); lazyPages.set(key, c); }
  return c;
}

// Import every shell route's module now. A route this window never imported is
// a landmine after a deploy: the SW swap purges the old-hash chunk, the first
// navigation to it fails, and ErrorBoundary heals with a full reload that
// loses the destination. Once imported, the module registry keeps the route
// for the window's lifetime, so navigation never fetches at click time.
// Failures are ignored — the route's own lazy() retries the fetch on visit.
export function warmTabRoutes(): void {
  for (const load of lazyLoaders.values()) void load().catch(() => {});
}

export interface TabRouteWarmupScheduler {
  isHidden: () => boolean;
  onVisibilityChange: (listener: () => void) => () => void;
  setTimer: (listener: () => void, delayMs: number) => () => void;
}

const browserScheduler: TabRouteWarmupScheduler = {
  isHidden: () => document.visibilityState === "hidden",
  onVisibilityChange(listener) {
    document.addEventListener("visibilitychange", listener);
    return () => document.removeEventListener("visibilitychange", listener);
  },
  setTimer(listener, delayMs) {
    const id = window.setTimeout(listener, delayMs);
    return () => window.clearTimeout(id);
  },
};

export function scheduleTabRouteWarmup(
  scheduler: TabRouteWarmupScheduler = browserScheduler,
): void {
  let warmed = false;
  let cancelVisibility = () => {};
  let cancelTimer = () => {};
  const warm = () => {
    if (warmed) return;
    warmed = true;
    cancelVisibility();
    cancelTimer();
    warmTabRoutes();
  };
  const onVisibilityChange = () => {
    if (scheduler.isHidden()) warm();
  };
  cancelVisibility = scheduler.onVisibilityChange(onVisibilityChange);
  cancelTimer = scheduler.setTimer(warm, 60_000);
  if (scheduler.isHidden()) warm();
}
