// Issue sync sources (issue_sync_sources) — store-fed. Mount the feeder once
// app-wide (DashboardLayout's HostFeeders); every surface reads the store
// through the reader below.
//
// docs/architecture/issue-sync.md S1.3: one row per imported container (a
// Linear project or team, a GitHub repo), each mapped to one codecast project.
import { useMemo } from "react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { useSyncCollection } from "./useSyncCollection";
import { useWorkspaceCollection } from "./useWorkspaceCollection";

const api = _api as any;

/** Feeder: the workspace's complete source set (snapshot sync — see registry). */
export function useSyncIssueSyncSources(enabled = true) {
  return useSyncCollection("issueSyncSources", api.issueSync.listSources, enabled ? {} : "skip");
}

/** The fields the sources UI renders. Anything else on the row — the import
 *  cursor, the webhook bookkeeping — must not wake it. */
export const issueSyncSourceSig = (s: any) =>
  `${s.status}|${s.name}|${s.project_id ?? ""}|${s.last_synced_at ?? 0}|${s.last_webhook_at ?? 0}|${s.last_error ?? ""}|${s.delegate_label ?? ""}|${s.delegate_assignee ?? ""}|${s.auto_spawn ? 1 : 0}|${s.push_new_tasks ? 1 : 0}`;

const newestFirst = (a: any, b: any) => (b.created_at ?? 0) - (a.created_at ?? 0);

/**
 * Reader: the active workspace's sources, newest first, optionally narrowed to
 * one provider. Goes through useWorkspaceCollection because the collection is
 * workspace-scoped — the store caches rows from every workspace the user has
 * viewed, and a raw enumeration would show another team's imports.
 */
export function useIssueSyncSources(provider?: "linear" | "github"): any[] {
  const rows = useWorkspaceCollection<any>("issueSyncSources", issueSyncSourceSig);
  return useMemo(
    () => rows.filter((r) => !provider || r.provider === provider).sort(newestFirst),
    [rows, provider],
  );
}
