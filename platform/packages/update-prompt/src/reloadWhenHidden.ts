// Reload the page only while nobody is looking: immediately if the window is
// already hidden, otherwise on the next visibilitychange to hidden. Built for
// the service worker's autoUpdate flow. A deploy activates a new worker in
// EVERY open window (clientsClaim), and the default response is an instant
// location.reload(), which blinks visible windows out from under the person
// (codecast's always-alive palette popup repainted from scratch and lost its
// compose draft). Deferring to hidden costs nothing for windows that hide
// often, and a window that stays visible for hours is covered by the update
// prompt (createUpdatePrompt) and by the app's own stale-chunk guard.

type VisibilityHost = {
  hidden: boolean;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
};

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
    // listeners: one armed reload covers them all; the reload picks up the
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
