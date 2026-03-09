import { useEffect } from "react";
import { useQuery } from "convex/react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore, DocItem, DocDetail } from "../store/inboxStore";

const api = _api as any;

export function useSyncDocs(typeFilter?: string, searchQuery?: string, projectFilter?: string, scope?: string) {
  const result = useQuery(
    searchQuery ? api.docs.webSearch : api.docs.webList,
    searchQuery
      ? { query: searchQuery, doc_type: typeFilter || undefined, scope: scope || undefined }
      : { doc_type: typeFilter || undefined, project_path: projectFilter || undefined, scope: scope || undefined }
  );
  const syncDocs = useInboxStore((s) => s.syncDocs);

  useEffect(() => {
    if (!result) return;
    if (searchQuery) {
      // webSearch returns array directly
      syncDocs(result as unknown as DocItem[]);
    } else {
      // webList returns { docs, projectPaths }
      const { docs, projectPaths } = result as any;
      syncDocs(docs as unknown as DocItem[], projectPaths);
    }
  }, [result, syncDocs, searchQuery]);
}

export function useSyncDocDetail(id?: string) {
  const data = useQuery(
    api.taskMining.webGetDocDetail,
    id ? { id: id as any } : "skip"
  );
  const syncDocDetail = useInboxStore((s) => s.syncDocDetail);

  useEffect(() => {
    if (data && id) {
      syncDocDetail(id, data as unknown as DocDetail);
    }
  }, [data, id, syncDocDetail]);
}
