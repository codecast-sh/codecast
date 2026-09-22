// The tab shell's lazy route registry, and the warm-up that imports every one.
//
// Its own module so TabContent.tsx stays a Fast Refresh boundary: a .tsx file
// exporting `warmTabRoutes` alongside its components remounted every tab on an
// unrelated edit. The registry has to live here too — `warmTabRoutes` walks the
// same map `lazyPage` fills, and a second copy would warm nothing.
import { lazy, type ComponentType, type LazyExoticComponent } from "react";
import { isChunkLoadError } from "./chunkReloadGuard";
import { errorSummary } from "./errorCause";

type PageModule = { default: ComponentType<any> };

// The lazy wrappers are cached on globalThis rather than recreated on every
// module execution. In dev, a hot update that re-executes the caller would
// otherwise mint new lazy components: React sees a new element type for every
// pane, unmounts the page through its Suspense fallback and mounts it again —
// a blank flash and lost page state (open dialogs, scroll) on an unrelated
// edit. Keyed by page path, so a genuinely new route still gets a fresh lazy.
const lazyPages: Map<string, LazyExoticComponent<ComponentType<any>>> =
  ((globalThis as any).__codecastLazyPages ??= new Map());
const lazyLoaders = new Map<string, () => Promise<unknown>>();

export function lazyPage(key: string, loader: () => Promise<PageModule>) {
  lazyLoaders.set(key, loader);
  let c = lazyPages.get(key);
  if (!c) { c = lazy(() => loadPage(key, loader)); lazyPages.set(key, c); }
  return c;
}

// How a page import that failed in dev gets another chance. Injectable so the
// loop is testable without a dev server; null in a production build.
export interface LazyPageRecovery {
  /** Resolves true when the dev server pushes an update, false at the timeout. */
  waitForUpdate: (timeoutMs: number) => Promise<boolean>;
  /** Import the page at a URL the browser has not seen yet. */
  reimport: (key: string) => Promise<PageModule>;
}

const PAGE_RECOVERY_WINDOW_MS = 20_000;

// In dev the module graph is served straight from the working tree, and other
// sessions edit that tree in bursts: a file that imports a sibling the same
// burst is about to create, an export renamed one save before its importer.
// A page whose chain crosses such a file rejects with "Failed to fetch
// dynamically imported module" (2026-09-21: the inbox page reaches
// components/org/scope/ScopePanel.tsx, which for one second imported a
// TemplateSections.tsx that did not exist yet). React.lazy memoizes that
// rejection and the browser's module map pins the failed URL, so the pane sat
// in its error UI, and the one auto-reload the boundary allows landed while
// the burst was still going. The tree heals with the next save, and Vite
// announces every save, so: import again at a fresh URL right away (the fix
// may have landed while the failed fetch was in flight), then once after each
// update, for a bounded window. Vite's own HMR client re-imports modules with
// a `?t=` query the same way, and the server keys the module by path, so the
// retried instance shares every import and its Fast Refresh identity with the
// original. Past the window the last rejection goes to the boundary, whose
// reload path is unchanged.
const viteRecovery: LazyPageRecovery | null = import.meta.hot
  ? {
      waitForUpdate: (timeoutMs) =>
        new Promise((resolve) => {
          const hot = import.meta.hot!;
          const settle = (updated: boolean) => {
            clearTimeout(timer);
            hot.off("vite:afterUpdate", onUpdate);
            resolve(updated);
          };
          const onUpdate = () => settle(true);
          const timer = setTimeout(() => settle(false), timeoutMs);
          hot.on("vite:afterUpdate", onUpdate);
        }),
      // Every shell page is a .tsx file under the web root, which is what the
      // `@/` alias names. A page that is not would 404 here and fall through
      // to the boundary, the same outcome as having no retry at all.
      reimport: (key) => import(/* @vite-ignore */ `${key.replace(/^@\//, "/")}.tsx?t=${Date.now()}`),
    }
  : null;

export async function loadPage(
  key: string,
  loader: () => Promise<PageModule>,
  recovery: LazyPageRecovery | null = viteRecovery,
  windowMs = PAGE_RECOVERY_WINDOW_MS,
  now: () => number = Date.now,
): Promise<PageModule> {
  try {
    return await loader();
  } catch (error) {
    // Only a fetch or link failure of the module graph. An error thrown by the
    // page's own top level is a bug, and hiding it behind retries helps nobody.
    if (!recovery || !isChunkLoadError(errorSummary(error))) throw error;
    const deadline = now() + windowMs;
    let last: unknown = error;
    for (let updated = true; updated; updated = await recovery.waitForUpdate(deadline - now())) {
      try {
        return await recovery.reimport(key);
      } catch (retryError) {
        last = retryError;
      }
      if (now() >= deadline) break;
    }
    throw last;
  }
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
