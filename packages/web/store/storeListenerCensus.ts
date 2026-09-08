// Live count of the inbox store's subscribers, and the single point every
// notification passes through (ct-49548).
//
// Why this installs on the RAW api and not on the exported hook: zustand's
// create() builds the inner api first, then copies `subscribe` onto the bound
// hook. useStore() — every React subscription in the app — reads the INNER
// api.subscribe, so a wrapper applied to the hook's copy afterwards counts only
// the handful of imperative useInboxStore.subscribe() callers and misses every
// component. The inner api is reachable only as the state creator's third
// argument, so that is where this runs.
//
// The count is what a listener budget test pins: a surface that subscribes per
// row costs a selector run per row on every store write, and the number only
// ever going down is the guarantee worth enforcing.
//
// Cost is per subscribe (a component mount), never per write.

import { foldPublish } from "./syncTransaction";

type Listener = (state: any, previous: any) => void;

type CensusApi = {
  subscribe: (listener: Listener) => () => void;
};

let liveListenerCount: number | null = null;
const installedOn = new WeakSet<object>();

/** Subscribers alive right now, or null if the census never installed. */
export function readStoreListenerCount(): number | null {
  return liveListenerCount;
}

/**
 * Call once from inside the store's state creator, passing its `api` argument.
 * Every listener is held here and reached through one real subscription, so the
 * sync transaction can fold a burst of writes into one visit.
 */
export function installStoreListenerCensus(api: CensusApi): void {
  try {
    const originalSubscribe = api?.subscribe;
    if (typeof originalSubscribe !== "function" || installedOn.has(api)) return;
    installedOn.add(api);

    const listeners = new Set<Listener>();
    let master: (() => void) | null = null;
    liveListenerCount = 0;

    api.subscribe = (listener: Listener) => {
      listeners.add(listener);
      liveListenerCount = listeners.size;
      if (!master) {
        master = originalSubscribe((state, previous) =>
          foldPublish(state, previous, (s, p) => {
            // Copy: a listener may unsubscribe (or subscribe) while being run.
            for (const l of [...listeners]) l(s, p);
          }),
        );
      }
      let released = false;
      return () => {
        // Why: React can call the same cleanup twice; only the first counts.
        if (released) return;
        released = true;
        listeners.delete(listener);
        liveListenerCount = listeners.size;
      };
    };
  } catch {
    liveListenerCount = null;
  }
}
