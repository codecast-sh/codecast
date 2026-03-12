import { useEffect } from "react";
import { useQuery } from "convex/react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore } from "../store/inboxStore";

const api = _api as any;

export function useSyncPlans(statusFilter?: string) {
  const plans = useQuery(api.plans.webList, {
    status: statusFilter || undefined,
  });
  const syncTable = useInboxStore((s) => s.syncTable);

  useEffect(() => {
    if (plans) {
      syncTable("plans", plans as any);
    }
  }, [plans, syncTable]);
}
