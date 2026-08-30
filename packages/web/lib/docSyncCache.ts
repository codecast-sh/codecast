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

/**
 * Drop the cached sync state for a doc so the next mount loads the server
 * snapshot. Used when the cache can no longer be bridged (see isSyncGap).
 */
export function clearDocSyncCache(docId: string): void {
  try {
    storage()?.removeItem(`convex-sync-${docId}`);
  } catch {
    // best-effort
  }
}

/**
 * True when a doc's `cli_edited_at` stamp just moved to a genuinely new value
 * while this editor instance has been live the whole time — i.e. `docs.resetSync`
 * rebuilt the snapshot (see isSyncGap) *after* this tab already opened the doc.
 *
 * The first time an editor sees a `cliEditedAt` stamp (mount, or reopening a
 * doc that was CLI-edited before this tab ever looked at it) is not this case:
 * `useTiptapSync` already loads the current server snapshot at mount, so
 * nothing needs to change. Only a stamp that *changes* under a live editor
 * means content moved server-side while this collab session was running.
 *
 * That must never be pushed into the live editor with `setContent` — a
 * whole-doc replace performed outside a tracked transaction leaves
 * prosemirror-collab's version/step bookkeeping describing a document that no
 * longer exists, and the next step it rebases against the real doc throws
 * ProseMirror's "Inconsistent open depths" (`TransformError`, 2026-08-28). The
 * only safe recovery is the same one `isSyncGap` uses: drop the cache and
 * remount, so the editor re-initializes cleanly from the fresh server
 * snapshot instead of mutating a live, actively-synced document in place.
 */
export function shouldResyncOnExternalEdit(
  seenCliEditedAt: number | null | undefined,
  nextCliEditedAt: number | null | undefined,
): boolean {
  if (nextCliEditedAt == null) return false;
  return seenCliEditedAt != null && nextCliEditedAt !== seenCliEditedAt;
}

/**
 * True when a client can never catch up by replaying deltas: the server is
 * ahead, but a getSteps fetch from the client's version returned nothing.
 *
 * That shape has exactly one cause — a CLI edit (`docs.resetSync`) rebuilt the
 * snapshot at a bumped version and deleted every delta, because deltas
 * computed against the old doc no longer apply. The sync library only ever
 * replays deltas, so a client behind that rewrite (a tab open through a
 * network flap, or one restored from a stale sessionStorage cache) stays
 * anchored at its old version forever: it never sees the new content and its
 * own edits never leave the tab (the 2026-08-27 Q3 planning doc wedge). The
 * only way forward is to drop the cache and remount from the snapshot.
 *
 * `serverVersion <= 1` is a doc still being created; never a gap.
 */
export function isSyncGap(args: {
  serverVersion: number | null | undefined;
  localVersion: number;
  /** `getSteps(localVersion).version` — equals localVersion when no steps came back. */
  stepsVersion: number;
}): boolean {
  const { serverVersion, localVersion, stepsVersion } = args;
  if (serverVersion == null || serverVersion <= 1) return false;
  if (serverVersion <= localVersion) return false;
  return stepsVersion <= localVersion;
}
