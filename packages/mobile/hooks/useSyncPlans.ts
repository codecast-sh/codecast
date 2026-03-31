import { useEffect } from "react";
import { useQuery } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore } from "@codecast/web/store/inboxStore";
import { useWorkspaceArgs } from "./useWorkspaceArgs";

export function useSyncPlans() {
  const syncTable = useInboxStore((s) => s.syncTable);
  const wsArgs = useWorkspaceArgs();

  const plans = useQuery(api.plans.webList,
    wsArgs === "skip" ? "skip" : wsArgs,
  );

  useEffect(() => {
    if (plans) syncTable("plans", plans as any);
  }, [plans, syncTable]);

  return { ready: plans !== undefined };
}
