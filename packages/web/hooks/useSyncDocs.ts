import { useCallback } from "react";
import { useQuery } from "convex/react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore, DocDetail } from "../store/inboxStore";
import { useConvexSync } from "./useConvexSync";
import { Id } from "@codecast/convex/convex/_generated/dataModel";

const api = _api as any;

function normalizeProjectPath(path: string): string {
  const parts = path.split("/");
  const srcIndex = parts.findIndex((p) => p === "src" || p === "projects" || p === "repos" || p === "code");
  if (srcIndex >= 0 && srcIndex < parts.length - 1) {
    return parts.slice(0, srcIndex + 2).join("/");
  }
  return path;
}

function dedupeProjectPaths(paths: string[]): string[] {
  const byName = new Map<string, string>();
  for (const path of paths) {
    const root = normalizeProjectPath(path);
    const name = root.split("/").filter(Boolean).pop() || path;
    const existing = byName.get(name);
    if (!existing || (path.includes("/src/") && !existing.includes("/src/"))) {
      byName.set(name, path);
    }
  }
  return Array.from(byName.values());
}

/**
 * Fetches ALL docs for the current workspace into the store.
 * No pagination, no server-side filters — every doc is loaded and cached.
 * All filtering (type, source, project, label) happens client-side.
 */
export function useSyncDocs() {
  const activeTeamId = useInboxStore(
    (s) => s.clientState.ui?.active_team_id
  ) as Id<"teams"> | undefined;
  const initialized = useInboxStore((s) => s.clientStateInitialized);
  const syncTable = useInboxStore((s) => s.syncTable);

  const stableArgs = !initialized ? "skip" : activeTeamId
    ? { team_id: activeTeamId, workspace: "team" as const }
    : { workspace: "personal" as const };

  const result = useQuery(api.docs.webList,
    stableArgs === "skip" ? "skip" : stableArgs
  );

  useConvexSync(result, useCallback((data: any) => {
    const docs = data?.docs ?? data ?? [];
    const rawPaths: string[] = docs.map((d: any) => d.project_path).filter(Boolean);
    const projectPaths = dedupeProjectPaths([...new Set(rawPaths)]);
    syncTable("docs", docs, { extra: { docProjectPaths: projectPaths } });
  }, [syncTable]));
}

export function useSyncDocDetail(id?: string) {
  const data = useQuery(
    api.taskMining.webGetDocDetail,
    id ? { id: id as any } : "skip"
  );
  const syncRecord = useInboxStore((s) => s.syncRecord);

  useConvexSync(data, useCallback((d: any) => {
    if (id) syncRecord("docDetails", id, d as unknown as DocDetail);
  }, [id, syncRecord]));
}
