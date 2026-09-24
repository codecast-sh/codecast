// Which folders upload to codecast, and what a change to that writes. The
// settings page, `cast sharing` and the daemon's sync rule (cli syncScope.ts)
// read the same lists the same way through here.
//
// Two modes: "all" uploads every folder except the excluded ones (and the
// folders inside them); "selected" uploads only the chosen folders (and the
// folders inside them).

import { folderCovers } from "./folderLists";

export { folderCovers };

export type SyncSettings = { sync_mode: "all" | "selected"; sync_projects: string[]; sync_excluded?: string[] };

/** Whether a folder's sessions upload, read off the lists alone. The daemon
 *  also counts a worktree outside its checkout as the checkout; callers that
 *  can read the disk pass that rule to planSyncChange instead. */
export function isFolderSyncing(settings: SyncSettings, folder: string): boolean {
  if (settings.sync_mode !== "selected") return !(settings.sync_excluded ?? []).some((e) => folderCovers(folder, e));
  return settings.sync_projects.some((c) => folderCovers(folder, c));
}

export type SyncChange = { all: true } | { sync: string[] } | { unsync: string[] };

export type SyncPlan = {
  /** The write, or null when the settings already say so. */
  next: Partial<SyncSettings> | null;
  /** Folders the change cannot reach because a folder above them decides:
   *  a chosen folder keeps them syncing, or an excluded one keeps them off. */
  stillCovered: { folder: string; by: string }[];
};

/**
 * The sync settings a change leads to. With everything syncing, stopping a
 * folder adds it to the excluded list and syncing one takes it off; with
 * chosen folders, the change edits that list. A folder that a folder above it
 * still decides is reported, not silently kept.
 */
export function planSyncChange(
  settings: SyncSettings,
  change: SyncChange,
  isSyncing: (settings: SyncSettings, folder: string) => boolean = isFolderSyncing,
): SyncPlan {
  const none: SyncPlan = { next: null, stillCovered: [] };
  const excluded = settings.sync_excluded ?? [];
  const all = settings.sync_mode !== "selected";
  if ("all" in change) return all && excluded.length === 0 ? none : { ...none, next: { sync_mode: "all", sync_excluded: [] } };

  if ("sync" in change) {
    if (all) {
      // Take the folders off the excluded list, with any excluded inside them.
      const kept = excluded.filter((e) => !change.sync.some((f) => folderCovers(e, f)));
      const stillCovered = change.sync.flatMap((f) => {
        const by = kept.find((e) => folderCovers(f, e));
        return by ? [{ folder: f, by }] : [];
      });
      return { next: kept.length === excluded.length ? null : { sync_excluded: kept }, stillCovered };
    }
    const missing = change.sync.filter((f) => !isSyncing(settings, f));
    if (missing.length === 0) return none;
    return { ...none, next: { sync_mode: "selected", sync_projects: [...settings.sync_projects, ...missing] } };
  }

  if (all) {
    const adding = change.unsync.filter((f) => isSyncing(settings, f));
    if (adding.length === 0) return none;
    // An exclusion inside a newly excluded folder says nothing more.
    return { ...none, next: { sync_excluded: [...excluded.filter((e) => !adding.some((a) => folderCovers(e, a))), ...adding] } };
  }
  // A folder taken off the chosen list takes the folders inside it along.
  const kept = settings.sync_projects.filter((f) => !change.unsync.some((d) => folderCovers(f, d)));
  const after: SyncSettings = { ...settings, sync_projects: kept };
  const stillCovered = change.unsync.flatMap((f) => {
    if (!isSyncing(after, f)) return [];
    return [{ folder: f, by: kept.find((k) => folderCovers(f, k)) ?? f }];
  });
  return { next: kept.length === settings.sync_projects.length ? null : after, stillCovered };
}
