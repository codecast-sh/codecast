import { useEffect } from "react";
import { useQuery } from "convex/react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore } from "../store/inboxStore";
import { useWorkspaceArgs } from "./useWorkspaceArgs";

const api = _api as any;

export function useSyncPlans(statusFilter?: string) {
  const workspaceArgs = useWorkspaceArgs();
  const plans = useQuery(api.plans.webList,
    workspaceArgs === "skip" ? "skip" : {
      status: statusFilter || undefined,
      ...workspaceArgs,
    }
  );
  const syncTable = useInboxStore((s) => s.syncTable);

  useEffect(() => {
    if (plans) {
      syncTable("plans", plans as any);
    }
  }, [plans, syncTable]);
}
