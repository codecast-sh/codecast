// Stale-chunk auto-reload guard shared by ErrorBoundary and the boot entry.
// Kept out of components/ErrorBoundary.tsx so that module exports only the
// boundary component: src/boot.tsx imports this, and a helper export next to a
// component makes the whole file a failed Fast Refresh boundary that reloads
// the page on every edit.

// Hard cap on auto-reloads per tab session. Even if a chunk-load error
// recurs (e.g. the deploy is mid-rollout), we never silently reload more
// than once — instead we surface the error UI so the user can see what's
// happening.
export const RELOAD_COUNT_KEY = "eb_reload_count";
export const MAX_AUTO_RELOADS = 1;

// Reset the auto-reload guard after the app has run stably, so the "reload at
// most once" cap is per stale-chunk INCIDENT, not per whole tab session.
// Without this, one early chunk error spends the single allowed reload, and a
// LATER genuine stale-chunk crash (e.g. navigating to a new lazy route after a
// deploy) hits the dead-end error UI instead of recovering. A reload that
// immediately re-crashes never survives the delay to call this, so the
// infinite-loop guard still holds.
export function armChunkReloadGuardReset(delayMs = 15_000): void {
  setTimeout(() => {
    try {
      sessionStorage.removeItem(RELOAD_COUNT_KEY);
    } catch {
      // sessionStorage unavailable — nothing to reset.
    }
  }, delayMs);
}

// Narrowly-scoped: errors that mean "the JS the browser has is incompatible
// with what the server is serving" — a stale tab whose chunk hashes no longer
// exist after a deploy, or a Vite dev-server module that was served from a
// half-written file. Generic TypeErrors ("is not a function", "Cannot read
// properties of undefined") are NOT included: they are ordinary code bugs, and
// auto-reloading on them hides the real failure and produces the "needs
// multiple reloads to load" symptom (the throttle then suppresses subsequent
// reloads, leaving a blank app).
//
// The "export named" family is the link-time shape of the same staleness: an
// importer fetched fine but the module it names lacks the binding. In dev that
// is Vite serving a file mid-edit (2026-09-13, EntityIdPill.tsx lost
// EntityAwareCode for a moment). React.lazy memoizes the rejected import, so
// no re-render can heal it; only a reload refetches the module graph.
export const CHUNK_LOAD_ERROR_PATTERNS = [
  "Failed to fetch dynamically imported module",
  "Importing a module script failed",
  "error loading dynamically imported module",
  "ChunkLoadError",
  "Loading chunk",
  "Loading CSS chunk",
  // Vite's preload helper when a <link rel=stylesheet> for a hashed CSS chunk
  // 404s — the same post-deploy staleness as a missing JS chunk, reached
  // through the stylesheet rather than the module. It arrived as an
  // unactionable production Sentry issue precisely because it was missing
  // here: nothing reloaded the stale tab, so the error was all we ever got.
  "Unable to preload CSS for",
  // Chrome / Firefox / Safari wordings of a missing named export at link time.
  "does not provide an export named",
  "doesn't provide an export named",
  "Importing binding name",
];

export function isChunkLoadError(msg: string): boolean {
  return !!msg && CHUNK_LOAD_ERROR_PATTERNS.some((p) => msg.includes(p));
}

// The one place that spends the auto-reload budget. Both callers — the React
// error boundary and the window-level `vite:preloadError` listener — share one
// counter, so a stale tab reloads once per incident however the failure
// surfaced, and a build that re-crashes immediately after the reload falls
// through to the error UI instead of looping.
//
// Returns whether the reload was started, so a caller can decide what to show.
export function tryReloadForStaleChunk(): boolean {
  try {
    const count = Number(sessionStorage.getItem(RELOAD_COUNT_KEY) ?? "0");
    if (count >= MAX_AUTO_RELOADS) return false;
    sessionStorage.setItem(RELOAD_COUNT_KEY, String(count + 1));
    window.location.reload();
    return true;
  } catch {
    // sessionStorage unavailable (private mode quota etc.) — decline to reload
    // rather than risk an unbounded loop with no counter to stop it.
    return false;
  }
}

// Vite dispatches `vite:preloadError` when a dynamic import's JS or CSS
// preload fails, and rethrows unless the event is cancelled. A preload that
// fails OUTSIDE a React boundary (a route warmup, an idle prefetch, a lazy
// import awaited in an event handler) therefore reaches Sentry as an unhandled
// rejection and nothing recovers the tab. Reload on it instead, under the same
// budget as the boundary path.
export function installStaleChunkReload(): void {
  window.addEventListener("vite:preloadError", (event) => {
    const message = (event as Event & { payload?: unknown }).payload;
    const summary = message instanceof Error ? message.message : String(message ?? "");
    // Only staleness. A preload that failed because the user is offline, or
    // for any other reason, must not spend the budget or hide its own report.
    if (!isChunkLoadError(summary)) return;
    // Order matters. Cancelling the event makes Vite RESOLVE the failed
    // dynamic import instead of rejecting it, so a React.lazy waiting on it
    // receives undefined and throws something far less legible. Only cancel
    // once a reload is actually under way (the page is leaving, and the
    // rejection would add a report nobody reads). If the budget is spent, let
    // Vite rethrow so the error boundary still renders its reload UI.
    if (tryReloadForStaleChunk()) event.preventDefault();
  });
}
