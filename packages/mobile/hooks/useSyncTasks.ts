import { useSyncTasksWithArgs } from "@codecast/web/hooks/useSyncTasks";
import { useWorkspaceArgs } from "./useWorkspaceArgs";

export function useSyncTasks() {
  return useSyncTasksWithArgs(useWorkspaceArgs());
}
