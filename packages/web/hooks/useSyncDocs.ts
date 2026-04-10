import { useCallback, useEffect } from "react";
import { usePaginatedQuery, useQuery } from "convex/react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore, DocDetail } from "../store/inboxStore";
import { useWorkspaceArgs } from "./useWorkspaceArgs";
import { useConvexSync } from "./useConvexSync";

const api = _api as any;
// Small pages to stay under Convex 16MB read limit (docs carry large content).
// Pages are drained eagerly so the store fills up fast.
const DOCS_PAGE_SIZE = 50;

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

export function useSyncDocs(typeFilter?: string, searchQuery?: string, projectFilter?: string, scope?: string) {
  const workspaceArgs = useWorkspaceArgs();
  const result = useQuery(
    api.docs.webSearch,
    workspaceArgs === "skip" || !searchQuery
      ? "skip"
      : { query: searchQuery, doc_type: typeFilter || undefined, scope: scope || undefined, ...workspaceArgs }
  );
  const paginated = usePaginatedQuery(
    api.docs.webListPaginated,
    !searchQuery && workspaceArgs !== "skip"
      ? { doc_type: typeFilter || undefined, scope: scope || undefined, ...workspaceArgs, ...(projectFilter ? { project_path: projectFilter } : {}) }
      : "skip",
    { initialNumItems: DOCS_PAGE_SIZE }
  );
  const syncTable = useInboxStore((s) => s.syncTable);

  useConvexSync(result, useCallback((data: any) => {
    if (searchQuery) {
      syncTable("docs", data as any);
    }
  }, [syncTable, searchQuery]));

  useConvexSync(!searchQuery && paginated.status !== "LoadingFirstPage" ? paginated.results : undefined, useCallback((docs: any[]) => {
    const projectPaths = dedupeProjectPaths(
      [...new Set(docs.map((d: any) => d.project_path).filter(Boolean))]
    );
    syncTable("docs", docs as any, { extra: { docProjectPaths: projectPaths } });
  }, [syncTable]));

  // Eagerly drain all pages into the store so the list feels fully loaded.
  // Each page is small (50) to stay under Convex read limits, but we
  // immediately request the next one as soon as each arrives.
  useEffect(() => {
    if (paginated.status === "CanLoadMore") {
      paginated.loadMore(DOCS_PAGE_SIZE);
    }
  }, [paginated.status, paginated.results.length]);
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
