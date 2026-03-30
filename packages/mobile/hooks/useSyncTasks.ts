import { useEffect, useState, useCallback } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore } from "@codecast/web/store/inboxStore";

export function useSyncTasks() {
  const [limit, setLimit] = useState(300);
  const syncTable = useInboxStore((s) => s.syncTable);
  const _setDispatch = useInboxStore((s) => s._setDispatch);
  const dispatchMutation = useMutation(api.dispatch.dispatch);

  useEffect(() => {
    _setDispatch((action, args, patches) => dispatchMutation({ action, args, patches }));
  }, [dispatchMutation, _setDispatch]);

  const result = useQuery(api.tasks.webList, {
    workspace: "personal" as const,
    limit,
    include_derived: true,
  });

  useEffect(() => {
    if (result) {
      const items = (result as any).items ?? result;
      syncTable("tasks", items);
    }
  }, [result, syncTable]);

  const hasMore = (result as any)?.hasMore ?? false;
  const loadMore = useCallback(() => setLimit((n) => n + 300), []);
  const ready = result !== undefined;

  return { hasMore, loadMore, ready };
}
