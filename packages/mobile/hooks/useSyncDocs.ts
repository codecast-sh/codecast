import { useEffect } from "react";
import { useQuery } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore } from "@codecast/web/store/inboxStore";
import { useWorkspaceArgs } from "./useWorkspaceArgs";

export function useSyncDocs() {
  const syncTable = useInboxStore((s) => s.syncTable);
  const wsArgs = useWorkspaceArgs();

  const result = useQuery(api.docs.webList as any,
    wsArgs === "skip" ? "skip" : wsArgs,
  );

  useEffect(() => {
    if (result) {
      const { docs, projectPaths } = result as any;
      syncTable("docs", docs as any, { docProjectPaths: projectPaths });
    }
  }, [result, syncTable]);

  return { ready: result !== undefined };
}
