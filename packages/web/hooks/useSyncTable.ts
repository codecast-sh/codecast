import { useEffect } from "react";
import { useQuery } from "convex/react";
import { useInboxStore } from "../store/inboxStore";

export function useSyncTable(
  tableName: string,
  queryFn: any,
  queryArgs: any,
  extra?: Record<string, any>,
) {
  const data = useQuery(queryFn, queryArgs);
  const syncTable = useInboxStore((s) => s.syncTable);

  useEffect(() => {
    if (data) {
      const items = Array.isArray(data) ? data : [data];
      syncTable(tableName, items as any, extra);
    }
  }, [data, tableName, syncTable, extra]);

  return data;
}
