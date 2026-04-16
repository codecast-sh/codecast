import { useSyncPlansWithArgs } from "@codecast/web/hooks/useSyncPlans";
import { useWorkspaceArgs } from "./useWorkspaceArgs";

export function useSyncPlans(statusFilter?: string) {
  return useSyncPlansWithArgs(useWorkspaceArgs(), statusFilter);
}
