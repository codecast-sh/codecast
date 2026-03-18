import { useCallback } from "react";
import { useQuery } from "convex/react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore } from "../store/inboxStore";
import { useWorkspaceArgs } from "./useWorkspaceArgs";
import { useConvexSync } from "./useConvexSync";

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

  useConvexSync(plans, useCallback((data: any) => {
    syncTable("plans", data as any);
  }, [syncTable]));
}
