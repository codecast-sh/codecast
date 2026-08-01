// Keeps bookmarks tied to the vault they belong to, and to the files they
// point at.
//
// Two jobs, both driven by store subscriptions rather than by editing the
// store's own file operations: load this vault's list whenever the active
// vault changes, and follow a bookmarked path when it is renamed or deleted.
// The rename case reads the store's own move ledger (resolveRecentMove), which
// renamePath records for every path a move touches — a folder rename included,
// since it records each descendant too.

import { useVaultStore, resolveRecentMove } from "../../store/vaultStore";
import type { BookmarkItem } from "./bookmarks";

let started = false;

/** A path that left the file table: where it went (new path), or null when it
 *  was deleted. `undefined` means nothing happened to it — leave it alone. */
function pathChange(
  files: Record<string, unknown>,
  prevFiles: Record<string, unknown>,
  path: string,
): string | null | undefined {
  if (files[path]) return undefined;
  // Never seen in the file table either: a bookmark made against a vault state
  // we no longer have (or an asset outside the scan). Not this scan's business.
  if (!prevFiles[path]) return undefined;
  return resolveRecentMove(path);
}

export function ensureBookmarksStarted(): void {
  if (started) return;
  started = true;

  const initial = useVaultStore.getState();
  if (initial.activeVaultId && initial.bookmarksVaultId !== initial.activeVaultId) {
    void initial.loadBookmarks();
  }

  useVaultStore.subscribe((s, prev) => {
    if (s.activeVaultId !== prev.activeVaultId) {
      void s.loadBookmarks();
      return;
    }
    if (s.files === prev.files || !s.bookmarks.length) return;
    // An empty table on either side is a vault switch or a scan in flight, not
    // a vault whose files were all deleted — retargeting through it would wipe
    // the list.
    if (!Object.keys(s.files).length || !Object.keys(prev.files).length) return;
    s.retargetBookmarks((path) => pathChange(s.files, prev.files, path));
  });
}

/** Subscribe a component to the bookmark list (and start the host on the way). */
export function useVaultBookmarks(): BookmarkItem[] {
  ensureBookmarksStarted();
  return useVaultStore((s) => s.bookmarks);
}
