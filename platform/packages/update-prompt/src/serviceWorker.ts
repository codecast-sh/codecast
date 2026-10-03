import { createReloadWhenHidden } from "./reloadWhenHidden";

// The two registerSW callbacks (vite-plugin-pwa's virtual:pwa-register, 1.0
// or later) that make the autoUpdate flow quiet:
//
//  - onRegisteredSW polls for a new worker. Browsers only look for a new sw.js
//    on navigation (or every 24h), and a single page app or a desktop window
//    stays open for days without navigating, so a stale shell would pin it to
//    an old bundle across deploys. Fifteen minutes: a deploy reaches a window
//    that never navigates within a quarter hour plus its next hide.
//  - onNeedReload replaces autoUpdate's instant reload of every open window
//    with a reload on the next hide, and tells the update prompt an update is
//    waiting (createUpdatePrompt's noteUpdateWaiting).

export const UPDATE_POLL_MS = 15 * 60 * 1000;

type Registration = { update(): Promise<unknown> };

export function serviceWorkerHooks(
  onUpdateWaiting: () => void,
  { pollMs = UPDATE_POLL_MS, reloadWhenHidden = createReloadWhenHidden(), every = (fn: () => void, ms: number): unknown => setInterval(fn, ms) } = {},
) {
  return {
    onRegisteredSW(_url: string, reg: Registration | undefined) {
      if (!reg) return;
      every(() => { reg.update().catch(() => {}); }, pollMs);
    },
    onNeedReload() {
      reloadWhenHidden();
      onUpdateWaiting();
    },
  };
}
