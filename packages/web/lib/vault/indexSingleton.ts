// The index instances and the diff that feeds them.
//
// indexHost.ts owns the React binding and the store subscription, which means
// it imports the vault store — and the store needs the index too (renamePath
// plans its link rewrite from it, and must not plan against an index that
// hasn't caught up yet). Holding the instances and the diff here keeps that a
// straight line instead of an import cycle: this module imports nothing of
// either side. Components keep importing `vaultIndex` from indexHost, which
// re-exports it.

import { isVaultMarkdownPath } from "@codecast/shared/contracts";
import { VaultIndex } from "./vaultIndex";
import { VaultSearchIndex } from "./searchIndex";

export const vaultIndex = new VaultIndex();
export const vaultSearch = new VaultSearchIndex();

let version = 0;
let indexedVaultId: string | null = null;
/** Mutations not yet announced: a sync that yields part way keeps its changes
 *  quiet until the pass that finishes, so readers see one bump per build. */
let unannounced = false;
/** Content refs we've indexed, to diff cheaply against the store's bodies. */
const indexedContent = new Map<string, string>();
const listeners = new Set<() => void>();

export function vaultIndexVersion(): number {
  return version;
}

export function subscribeVaultIndex(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** True when the index has nothing in it yet — the caller may want to sync
 *  before asking it questions. */
export function vaultIndexIsEmpty(): boolean {
  return indexedContent.size === 0;
}

/**
 * Bring the index in line with a body table. Idempotent and cheap when nothing
 * changed (a ref compare per file), so callers that need a guaranteed-current
 * index may just call it.
 *
 * With `shouldYield`, the sync stops after any note once it returns true and
 * reports false: call again (with the store's current bodies) to continue. The
 * diff is per-file, so the next call picks up exactly where this one stopped.
 * Listeners hear about the changes only from the call that finishes.
 */
export function syncVaultIndex(
  vaultId: string | null,
  bodies: Record<string, { content: string }>,
  shouldYield?: () => boolean,
): boolean {
  if (vaultId !== indexedVaultId) {
    // Vault switch: rebuild from scratch.
    for (const path of [...indexedContent.keys()]) {
      vaultIndex.remove(path);
      vaultSearch.removeNote(path);
    }
    if (indexedContent.size > 0) unannounced = true;
    indexedContent.clear();
    indexedVaultId = vaultId;
  }
  for (const [path, body] of Object.entries(bodies)) {
    if (!isVaultMarkdownPath(path)) continue;
    if (indexedContent.get(path) === body.content) continue;
    vaultIndex.upsert(path, body.content);
    const parsed = vaultIndex.note(path)?.parsed;
    if (parsed) vaultSearch.upsertNote(path, parsed);
    indexedContent.set(path, body.content);
    unannounced = true;
    if (shouldYield?.()) return false;
  }
  for (const path of [...indexedContent.keys()]) {
    if (!bodies[path]) {
      vaultIndex.remove(path);
      vaultSearch.removeNote(path);
      indexedContent.delete(path);
      unannounced = true;
    }
  }
  if (!unannounced) return true;
  unannounced = false;
  version += 1;
  for (const l of listeners) l();
  return true;
}
