import { useEffect } from "react";
import { useQuery } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore } from "@codecast/web/store/inboxStore";

export function useSyncDocs() {
  const syncTable = useInboxStore((s) => s.syncTable);

  const result = useQuery(api.docs.webList as any, {
    workspace: "personal" as const,
  });

  useEffect(() => {
    if (result) {
      const { docs, projectPaths } = result as any;
      syncTable("docs", docs as any, { docProjectPaths: projectPaths });
    }
  }, [result, syncTable]);

  return { ready: result !== undefined };
}
