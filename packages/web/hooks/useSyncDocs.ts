import { useCallback, useEffect, useRef } from "react";
import { useQuery, usePaginatedQuery } from "convex/react";
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

const PAGE_SIZE = 200;

type WorkspaceArgs =
  | { team_id: Id<"teams">; workspace: "team" }
  | { workspace: "personal" }
  | "skip";

/**
 * Shared paginated docs sync — used by both web and mobile.
 * Each page stays under Convex's 64 MB query limit.
 */
export function useSyncDocsPaginated(wsArgs: WorkspaceArgs) {
  const syncTable = useInboxStore((s) => s.syncTable);

  const { results, status, loadMore } = usePaginatedQuery(
    api.docs.webListPaged,
    wsArgs === "skip" ? "skip" : wsArgs,
    { initialNumItems: PAGE_SIZE }
  );

  // Auto-load all remaining pages
  const loadMoreRef = useRef(loadMore);
  loadMoreRef.current = loadMore;
  useEffect(() => {
    if (status === "CanLoadMore") {
      loadMoreRef.current(PAGE_SIZE);
    }
  }, [status, results?.length]);

  // Sync accumulated results to store
  useConvexSync(
    status !== "LoadingFirstPage" ? results : undefined,
    useCallback((docs: any) => {
      const rawPaths: string[] = docs.map((d: any) => d.project_path).filter(Boolean);
      const projectPaths = dedupeProjectPaths([...new Set(rawPaths)]);
      syncTable("docs", docs, { extra: { docProjectPaths: projectPaths } });
    }, [syncTable])
  );

  return { ready: status !== "LoadingFirstPage" };
}

/**
 * Web-specific wrapper — reads workspace args from the store.
 */
export function useSyncDocs() {
  const activeTeamId = useInboxStore(
    (s) => s.clientState.ui?.active_team_id
  ) as Id<"teams"> | undefined;
  const initialized = useInboxStore((s) => s.clientStateInitialized);

  const wsArgs: WorkspaceArgs = !initialized ? "skip" : activeTeamId
    ? { team_id: activeTeamId, workspace: "team" as const }
    : { workspace: "personal" as const };

  return useSyncDocsPaginated(wsArgs);
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
