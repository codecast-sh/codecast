// The collab editor's sync layer (@convex-dev/prosemirror-sync) reads a
// sessionStorage cache keyed `convex-sync-<docId>` before asking the server
// for a snapshot; the library only ever reads it, so we own every write.
//
// Two writers share this module: the editor caches confirmed state on
// open/update/unmount (revisits mount instantly), and a doc created in this
// tab is seeded here at create-acknowledgement time (the very first open
// mounts instantly too — a doc we just made has no server snapshot, so a
// round trip to learn that is pure waste; the library creates the server
// snapshot itself from a cached version <= 1).

export const EMPTY_PM_DOC = { type: "doc", content: [{ type: "paragraph" }] };

const FRESH_DOC_TTL_MS = 10 * 60 * 1000;

function storage(): Storage | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null;
  }
}

export function writeDocSyncCache(docId: string, content: unknown, version: number): void {
  try {
    storage()?.setItem(`convex-sync-${docId}`, JSON.stringify({ content, version }));
  } catch {
    // best-effort — without the cache, loading falls back to the server path
  }
}

/**
 * A doc created in this tab. Seeds the sync cache when it was created empty
 * (the editor mounts live with no server round trip) and marks it fresh so the
 * doc page opens straight into edit mode instead of an empty read view.
 */
export function noteFreshDoc(docId: string, opts: { empty: boolean }): void {
  if (opts.empty) writeDocSyncCache(docId, EMPTY_PM_DOC, 1);
  try {
    storage()?.setItem(`fresh-doc-${docId}`, String(Date.now()));
  } catch {
    // best-effort — the doc merely opens in read mode
  }
}

export function isFreshDoc(docId: string): boolean {
  const raw = storage()?.getItem(`fresh-doc-${docId}`);
  if (!raw) return false;
  return Date.now() - Number(raw) < FRESH_DOC_TTL_MS;
}
