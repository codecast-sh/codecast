import { useCallback } from "react";
import { useQuery } from "convex/react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore, DocDetail } from "../store/inboxStore";
import { useWorkspaceArgs } from "./useWorkspaceArgs";
import { useConvexSync } from "./useConvexSync";

const api = _api as any;

export function useSyncDocs(typeFilter?: string, searchQuery?: string, projectFilter?: string, scope?: string) {
  const workspaceArgs = useWorkspaceArgs();
  const result = useQuery(
    searchQuery ? api.docs.webSearch : api.docs.webList,
    workspaceArgs === "skip" ? "skip"
      : searchQuery
        ? { query: searchQuery, doc_type: typeFilter || undefined, scope: scope || undefined, ...workspaceArgs }
        : { doc_type: typeFilter || undefined, scope: scope || undefined, ...workspaceArgs, ...(projectFilter ? { project_path: projectFilter } : {}) }
  );
  const syncTable = useInboxStore((s) => s.syncTable);

  useConvexSync(result, useCallback((data: any) => {
    if (searchQuery) {
      syncTable("docs", data as any);
    } else {
      const { docs, projectPaths } = data as any;
      syncTable("docs", docs as any, { docProjectPaths: projectPaths });
    }
  }, [syncTable, searchQuery]));
}

export function useSyncDocDetail(id?: string) {
  const data = useQuery(
    api.taskMining.webGetDocDetail,
    id ? { id: id as any } : "skip"
  );
  const syncDocDetail = useInboxStore((s) => s.syncDocDetail);

  useConvexSync(data, useCallback((d: any) => {
    if (id) syncDocDetail(id, d as unknown as DocDetail);
  }, [id, syncDocDetail]));
}
