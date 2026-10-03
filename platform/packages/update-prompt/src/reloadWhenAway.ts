// Reload the page only while nobody is using it: immediately if the window is
// already hidden, otherwise on the next visibilitychange to hidden, or once
// the window has gone IDLE_RELOAD_MS without any input. Built for the service
// worker's autoUpdate flow. A deploy activates a new worker in EVERY open
// window (clientsClaim), and the default response is an instant
// location.reload(), which blinks visible windows out from under the person
// (codecast's always-alive palette popup repainted from scratch and lost its
// compose draft).
//
// The idle leg is for the window that never hides: a desktop main window on
// its own screen stays visible for days, so waiting for a hide left it on the
// old bundle until the day-old update prompt, and a fix that had shipped hours
// earlier still looked unfixed there. A window nobody has touched for a few
// minutes can take the blink. `busy` vetoes it for a window that is in use
// without input (a call); the reload then waits for the next quiet check.

export const IDLE_RELOAD_MS = 5 * 60 * 1000;

const INPUT_EVENTS = ["pointerdown", "pointermove", "keydown", "wheel", "touchstart"] as const;

type VisibilityHost = {
  hidden: boolean;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
};

type InputHost = {
  addEventListener(type: string, listener: () => void, options?: { passive?: boolean; capture?: boolean }): void;
  removeEventListener(type: string, listener: () => void, options?: { capture?: boolean }): void;
};

export type ReloadWhenAwayOptions = {
  idleMs?: number;
  /** In use without input (a call in progress): the idle reload waits. A hide still reloads. */
  busy?: () => boolean;
  input?: InputHost;
  now?: () => number;
  after?: (fn: () => void, ms: number) => unknown;
};

export function createReloadWhenAway(
  reload: () => void = () => window.location.reload(),
  doc: VisibilityHost = document,
  { idleMs = IDLE_RELOAD_MS, busy = () => false, input = window, now = Date.now, after = (fn, ms) => setTimeout(fn, ms) }: ReloadWhenAwayOptions = {},
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
    let done = false;
    let lastInput = now();
    const onInput = () => { lastInput = now(); };
    const fire = () => {
      if (done) return;
      done = true;
      doc.removeEventListener("visibilitychange", onHide);
      for (const type of INPUT_EVENTS) input.removeEventListener(type, onInput, { capture: true });
      reload();
    };
    const onHide = () => {
      if (doc.hidden) fire();
    };
    // Input only stamps a time; the check runs when the idle window could
    // first have elapsed, so a stream of pointer moves costs one assignment each.
    const check = () => {
      if (done) return;
      const quietFor = now() - lastInput;
      if (quietFor >= idleMs && !busy()) fire();
      else after(check, quietFor >= idleMs ? idleMs : idleMs - quietFor);
    };
    doc.addEventListener("visibilitychange", onHide);
    for (const type of INPUT_EVENTS) input.addEventListener(type, onInput, { passive: true, capture: true });
    after(check, idleMs);
  };
}
