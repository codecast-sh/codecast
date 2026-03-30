import { useEffect } from "react";
import { useQuery } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore } from "@codecast/web/store/inboxStore";

export function useSyncPlans() {
  const syncTable = useInboxStore((s) => s.syncTable);

  const plans = useQuery(api.plans.webList, {
    workspace: "personal" as const,
  });

  useEffect(() => {
    if (plans) syncTable("plans", plans as any);
  }, [plans, syncTable]);

  return { ready: plans !== undefined };
}
