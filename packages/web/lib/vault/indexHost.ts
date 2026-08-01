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
// initial build is deferred to an idle callback to keep first paint clean;
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

/** Deferred initial sync: parse off the critical path so a large vault doesn't
 *  block first paint; steady-state diffs are small and run on a microtask. */
function scheduleSync() {
  if (pending) return;
  pending = true;
  const run = () => {
    pending = false;
    const s = useVaultStore.getState();
    syncVaultIndex(s.activeVaultId, s.bodies);
  };
  if (vaultIndexIsEmpty() && typeof requestIdleCallback === "function") {
    requestIdleCallback(run, { timeout: 500 });
  } else {
    queueMicrotask(run);
  }
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
