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
const CHUNK_LOAD_ERROR_PATTERNS = [
  "Failed to fetch dynamically imported module",
  "Importing a module script failed",
  "error loading dynamically imported module",
  "ChunkLoadError",
  "Loading chunk",
  "Loading CSS chunk",
  // Chrome / Firefox / Safari wordings of a missing named export at link time.
  "does not provide an export named",
  "doesn't provide an export named",
  "Importing binding name",
];

export function isChunkLoadError(msg: string): boolean {
  return !!msg && CHUNK_LOAD_ERROR_PATTERNS.some((p) => msg.includes(p));
}
