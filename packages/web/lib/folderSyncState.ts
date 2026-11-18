import { folderUnderHome, isFolderSyncing, type SyncSettings } from "@codecast/shared/team/syncPlan";

/** Where a folder stands in the person's sync, read off their lists. "off": not
 *  one of their chosen folders, so only sessions started from codecast sync
 *  there. "excluded": they excluded it, so nothing there syncs and a start is
 *  refused. Null when the folder syncs, and for a home folder: syncing one
 *  would sync every session on every machine, and a codecast launch there
 *  syncs anyway. */
export function folderSyncState(settings: SyncSettings | null, folder: string): "off" | "excluded" | null {
  if (!settings || !folder.startsWith("/") || folderUnderHome(folder) === "" || isFolderSyncing(settings, folder)) return null;
  return settings.sync_mode === "selected" ? "off" : "excluded";
}
