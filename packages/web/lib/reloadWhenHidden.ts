// Reload the page only while nobody is looking: immediately if the window is
// already hidden, otherwise on the next visibilitychange to hidden. Built for
// the service worker's autoUpdate flow — a deploy activates a new worker in
// EVERY open window (clientsClaim), and the default response is an instant
// location.reload(). That blinked visible windows out from under the user;
// worst was the always-alive palette popup, which repainted from scratch and
// came back on the search face with the compose draft gone. Deferring to
// hidden costs nothing there (the popup hides on every dismissal, so updates
// still land within minutes), and the window that stays visible for hours is
// covered by ErrorBoundary's stale-chunk guard if it trips over the new
// precache before its deferred reload fires.

type VisibilityHost = Pick<Document, "hidden" | "addEventListener" | "removeEventListener">;

export function createReloadWhenHidden(
  reload: () => void = () => window.location.reload(),
  doc: VisibilityHost = document,
): () => void {
  let armed = false;
  return () => {
    if (doc.hidden) {
      reload();
      return;
    }
    // Repeat activations while still visible (stacked deploys) must not stack
    // listeners — one armed reload covers them all; the reload picks up the
    // newest bundle regardless of how many deploys queued behind it.
    if (armed) return;
    armed = true;
    const onHide = () => {
      if (!doc.hidden) return;
      doc.removeEventListener("visibilitychange", onHide);
      reload();
    };
    doc.addEventListener("visibilitychange", onHide);
  };
}
