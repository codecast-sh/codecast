"use client";

import { useShallow } from "zustand/react/shallow";
import { CloudOff } from "lucide-react";
import { folderUnderHome, isFolderSyncing, type SyncSettings } from "@codecast/shared/team/syncPlan";
import { useInboxStore } from "../../store/inboxStore";

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

/** Beside a session's folder: the folder's sync state when it isn't syncing,
 *  and the one press that syncs it. */
export function FolderSyncControl({ folder }: { folder: string }) {
  const settings = useInboxStore(useShallow((s) => {
    const u = s.currentUser as any;
    return u ? { sync_mode: u.sync_mode ?? "all", sync_projects: u.sync_projects ?? [], sync_excluded: u.sync_excluded ?? [] } as SyncSettings : null;
  }));
  const state = folderSyncState(settings, folder);
  if (!state) return null;
  const name = folder.split("/").filter(Boolean).pop() ?? folder;
  return (
    <div className={`inline-flex items-center gap-2 text-xs ${state === "excluded" ? "text-sol-red" : "text-sol-text-dim"}`}>
      <CloudOff className="w-3.5 h-3.5 shrink-0" aria-hidden />
      <span title={folder}>{name} {state === "excluded" ? "is excluded from sync" : "isn't synced"}</span>
      <button
        type="button"
        onClick={() => useInboxStore.getState().syncFolder(folder)}
        className="rounded px-2 py-0.5 border border-sol-cyan/40 text-sol-cyan hover:bg-sol-cyan/10 transition-colors"
      >
        Sync folder
      </button>
    </div>
  );
}
