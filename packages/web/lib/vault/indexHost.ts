// Keeps the vault index (links/tags/headings/resolution + search) in sync with
// the vault store's bodies, and exposes it to React via useSyncExternalStore.
//
// The index lives here as a module singleton rather than inside the zustand
// store: it's a mutable class with internal maps — putting it through store
// snapshots would either freeze it or defeat structural sharing. Consumers
// subscribe to a VERSION COUNTER; any index mutation bumps it, and components
// re-read whatever queries they need during render.
//
// Parse cost is ~0.2ms per typical note (measured by the engine's benchmark),
// so a 240-note vault indexes in ~50ms and a 5k-note vault in ~1-2s. The
// initial build is chunked through idle callbacks to keep first paint clean;
// per-file updates after boot are effectively free. A worker migration slot is
// reserved for vaults an order of magnitude bigger (the snapshot() API exists
// for exactly that hand-off).

import { useSyncExternalStore } from "react";
import { VaultIndex } from "./vaultIndex";
import { VaultSearchIndex } from "./searchIndex";
import { useVaultStore, type VaultBody } from "../../store/vaultStore";
import { isVaultMarkdownPath } from "@codecast/shared/contracts";

export const vaultIndex = new VaultIndex();
export const vaultSearch = new VaultSearchIndex();

let version = 0;
let indexedVaultId: string | null = null;
/** Content refs we've indexed, to diff cheaply against the store's bodies. */
const indexedContent = new Map<string, string>();
const listeners = new Set<() => void>();

function bump() {
  version += 1;
  for (const l of listeners) l();
}

function applyDiff(vaultId: string | null, bodies: Record<string, VaultBody>) {
  if (vaultId !== indexedVaultId) {
    // Vault switch: rebuild from scratch.
    for (const path of [...indexedContent.keys()]) {
      vaultIndex.remove(path);
      vaultSearch.removeNote(path);
    }
    indexedContent.clear();
    indexedVaultId = vaultId;
  }
  let changed = false;
  for (const [path, body] of Object.entries(bodies)) {
    if (!isVaultMarkdownPath(path)) continue;
    if (indexedContent.get(path) === body.content) continue;
    vaultIndex.upsert(path, body.content);
    const parsed = vaultIndex.note(path)?.parsed;
    if (parsed) vaultSearch.upsertNote(path, parsed);
    indexedContent.set(path, body.content);
    changed = true;
  }
  for (const path of [...indexedContent.keys()]) {
    if (!bodies[path]) {
      vaultIndex.remove(path);
      vaultSearch.removeNote(path);
      indexedContent.delete(path);
      changed = true;
    }
  }
  if (changed) bump();
}

let started = false;
let pending = false;

/** Chunked initial sync: parse in idle slices so a large vault doesn't block
 *  first paint; steady-state diffs are small and run synchronously. */
function scheduleSync() {
  if (pending) return;
  pending = true;
  const run = () => {
    pending = false;
    const s = useVaultStore.getState();
    applyDiff(s.activeVaultId, s.bodies);
  };
  if (indexedContent.size === 0 && typeof requestIdleCallback === "function") {
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
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => version,
  );
}
