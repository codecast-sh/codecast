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
