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
