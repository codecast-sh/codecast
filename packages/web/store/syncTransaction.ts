// One subscriber visit per burst of incoming data (ct-49548).
//
// Feeders coalesce at their own edge (useConvexSync, 300 ms trailing) but they
// coalesce SEPARATELY, and several of them push in the same Convex frame: the
// inbox feeder alone applies sessions, clientState, currentUser and bookmarks,
// the chat feeder applies five tables, and the sync host's replication stream
// replays a whole page of keys in one loop. Each apply is its own committed
// zustand write, so N applies meant N subscriber visits — every mounted
// selector ran N times for one logical change, and the visible result was
// identical after the first and the last.
//
// A sync transaction folds those visits. State still commits SYNCHRONOUSLY on
// every apply, so `getState()` is never behind and no caller has to await a
// window; only the notification is held. The first apply inside a transaction
// opens a 33 ms trailing window (one frame at 30 Hz), every later apply from
// any feeder joins it, and the subscribers are visited once at the end with the
// newest state and the oldest previous state.
//
// A write from outside a transaction — a user gesture, a raw setState — never
// waits: it flushes the folded backlog and publishes with it, so the ordering a
// subscriber sees is exactly the ordering the store committed.
//
// The fold plugs into the one place every notification passes through, the
// subscribe wrapper in store/storeListenerCensus.ts.

export const SYNC_PUBLISH_WINDOW_MS = 33;

type FanOut = (state: unknown, previous: unknown) => void;

let depth = 0;
// The held publish: `previous` from the first apply in the window, `state` from
// the most recent one, so one visit reports the whole window as one transition.
let deferred: { previous: unknown; state: unknown } | null = null;
let deferredFanOut: FanOut | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

function disarm(): void {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  deferred = null;
}

/**
 * Run `apply` as one incoming-data transaction. Re-entrant: a nested call joins
 * the open window instead of opening its own.
 */
export function syncTransaction<T>(apply: () => T): T {
  depth++;
  try {
    return apply();
  } finally {
    depth--;
  }
}

/** Visit every subscriber now with whatever the window has folded so far. */
export function flushSyncPublishes(): void {
  const held = deferred;
  const fanOut = deferredFanOut;
  disarm();
  if (held && fanOut) fanOut(held.state, held.previous);
}

/**
 * The notification gate. Called by the store's subscribe wrapper for every
 * committed write; `fanOut` visits the subscribers.
 */
export function foldPublish(state: unknown, previous: unknown, fanOut: FanOut): void {
  if (depth > 0) {
    deferredFanOut = fanOut;
    if (deferred) {
      deferred.state = state;
    } else {
      deferred = { previous, state };
      timer = setTimeout(flushSyncPublishes, SYNC_PUBLISH_WINDOW_MS);
    }
    return;
  }
  // Outside a transaction: publish immediately, carrying the held backlog so a
  // gesture never renders on top of unpublished incoming data.
  const held = deferred;
  disarm();
  fanOut(state, held ? held.previous : previous);
}

export function resetSyncTransactionForTests(): void {
  depth = 0;
  disarm();
  deferredFanOut = null;
}
