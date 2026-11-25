// Keeps the vault index (links/tags/headings/resolution + search) in sync with
// the vault store's bodies, and exposes it to React via useSyncExternalStore.
//
// The index lives in indexSingleton.ts rather than inside the zustand store:
// it's a mutable class with internal maps — putting it through store snapshots
// would either freeze it or defeat structural sharing. Consumers subscribe to
// a VERSION COUNTER; any index mutation bumps it, and components re-read
// whatever queries they need during render.
//
// Parse cost is ~0.2ms per typical note (measured by the engine's benchmark),
// so a 240-note vault indexes in ~50ms and a 5k-note vault in ~1-2s. The
// initial build runs in idle callbacks, at most ~50ms each, so neither first
// paint nor a click waits on it;
// per-file updates after boot are effectively free. A worker migration slot is
// reserved for vaults an order of magnitude bigger (the snapshot() API exists
// for exactly that hand-off).

import { useSyncExternalStore } from "react";
import {
  subscribeVaultIndex,
  syncVaultIndex,
  vaultIndex,
  vaultIndexIsEmpty,
  vaultIndexVersion,
  vaultSearch,
} from "./indexSingleton";
import { useVaultStore } from "../../store/vaultStore";

export { vaultIndex, vaultSearch };

let started = false;
let pending = false;

/** Longest stretch one idle slice may parse. Chrome's idle deadline is at
 *  most 50 ms; a timed-out callback gets 0, so a slice still parses this much
 *  before yielding back to input. */
const SLICE_MS = 50;
const MIN_SLICE_MS = 8;

/** Deferred initial sync: parse off the critical path so a large vault doesn't
 *  block first paint, and in idle-sized slices so it doesn't block input
 *  either (one slice per callback; a 5k-note build is many short tasks, not
 *  one long one). Steady-state diffs are small and run on a microtask. */
function scheduleSync() {
  if (pending) return;
  pending = true;
  if (vaultIndexIsEmpty() && typeof requestIdleCallback === "function") {
    requestIdleCallback(runSlice, { timeout: 500 });
  } else {
    queueMicrotask(() => {
      pending = false;
      const s = useVaultStore.getState();
      syncVaultIndex(s.activeVaultId, s.bodies);
    });
  }
}

/** One slice of the initial build. Store changes made between slices are
 *  picked up by the next slice (it re-reads the bodies), so `pending` stays set
 *  until the build finishes. */
function runSlice(deadline: IdleDeadline) {
  const budget = Math.min(SLICE_MS, Math.max(MIN_SLICE_MS, deadline.timeRemaining()));
  const end = performance.now() + budget;
  const s = useVaultStore.getState();
  const done = syncVaultIndex(s.activeVaultId, s.bodies, () => performance.now() >= end);
  if (done) pending = false;
  else requestIdleCallback(runSlice, { timeout: 500 });
}

function ensureStarted() {
  if (started) return;
  started = true;
  useVaultStore.subscribe((s, prev) => {
    if (s.bodies !== prev.bodies || s.activeVaultId !== prev.activeVaultId) scheduleSync();
  });
  scheduleSync();
}

/** Subscribe a component to index changes. Returns the version counter — read
 *  index queries directly off `vaultIndex`/`vaultSearch` during render. */
export function useVaultIndexVersion(): number {
  ensureStarted();
  return useSyncExternalStore(subscribeVaultIndex, vaultIndexVersion);
}
