import { useCallback } from "react";
import { useQuery } from "convex/react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore } from "../store/inboxStore";
import { useWorkspaceArgs, type WorkspaceArgs } from "./useWorkspaceArgs";
import { useConvexSync } from "./useConvexSync";

const api = _api as any;

export function useSyncPlansWithArgs(wsArgs: WorkspaceArgs, statusFilter?: string) {
  const plans = useQuery(api.plans.webList,
    wsArgs === "skip" ? "skip" : {
      status: statusFilter || undefined,
      ...wsArgs,
    }
  );
  const syncTable = useInboxStore((s) => s.syncTable);

  useConvexSync(plans, useCallback((data: any) => {
    syncTable("plans", data as any);
  }, [syncTable]));

  return { ready: plans !== undefined };
}

export function useSyncPlans(statusFilter?: string) {
  return useSyncPlansWithArgs(useWorkspaceArgs(), statusFilter);
}
