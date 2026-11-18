"use client";

import { useShallow } from "zustand/react/shallow";
import { CloudOff } from "lucide-react";
import type { SyncSettings } from "@codecast/shared/team/syncPlan";
import { folderSyncState } from "../../lib/folderSyncState";
import { useInboxStore } from "../../store/inboxStore";

/** Beside a session's folder: the folder's sync state when it isn't syncing,
 *  and the one press that syncs it. */
export function FolderSyncControl({ folder }: { folder: string }) {
  // The raw fields only: a `?? []` inside the selector is a new array on every
  // read, useShallow never sees two equal snapshots, and React loops (#185).
  const raw = useInboxStore(useShallow((s) => {
    const u = s.currentUser as any;
    return u ? { sync_mode: u.sync_mode, sync_projects: u.sync_projects, sync_excluded: u.sync_excluded } : null;
  }));
  const settings: SyncSettings | null = raw
    ? { sync_mode: raw.sync_mode ?? "all", sync_projects: raw.sync_projects ?? [], sync_excluded: raw.sync_excluded ?? [] }
    : null;
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
