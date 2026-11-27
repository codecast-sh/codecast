/** Run `fn` when the browser has a moment, and within `timeout` ms regardless.
 *  For work that must not land on a first paint or a keystroke. */
export function whenIdle<T>(fn: () => T, timeout = 2000): Promise<T> {
  return new Promise((resolve, reject) => {
    const run = () => {
      try {
        resolve(fn());
      } catch (e) {
        reject(e);
      }
    };
    if (typeof requestIdleCallback === "function") requestIdleCallback(run, { timeout });
    else setTimeout(run, 0);
  });
}

/** Run `fn` now if the page is visible, else once it next becomes visible.
 *  For refreshes nobody can see: a hidden tab (an agent's, a window behind
 *  others) asks the daemon nothing until it is looked at. Returns a cancel
 *  while it waits, null when it already ran. */
export function whenVisible(fn: () => void): (() => void) | null {
  if (typeof document === "undefined" || document.visibilityState !== "hidden") {
    fn();
    return null;
  }
  const onChange = () => {
    if (document.visibilityState === "hidden") return;
    document.removeEventListener("visibilitychange", onChange);
    fn();
  };
  document.addEventListener("visibilitychange", onChange);
  return () => document.removeEventListener("visibilitychange", onChange);
}
