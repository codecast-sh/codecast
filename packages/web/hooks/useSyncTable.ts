import { useCallback } from "react";
import { useQuery } from "convex/react";
import { useInboxStore } from "../store/inboxStore";
import { useConvexSync } from "./useConvexSync";

export function useSyncTable(
  tableName: string,
  queryFn: any,
  queryArgs: any,
  extra?: Record<string, any>,
) {
  const data = useQuery(queryFn, queryArgs);
  const syncTable = useInboxStore((s) => s.syncTable);

  useConvexSync(data, useCallback((d: any) => {
    const items = Array.isArray(d) ? d : [d];
    syncTable(tableName, items as any, extra ? { extra } : undefined);
  }, [tableName, syncTable, extra]));

  return data;
}
