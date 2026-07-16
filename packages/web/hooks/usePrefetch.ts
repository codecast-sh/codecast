import { usePathname } from "next/navigation";
import { useSyncTasksWithArgs } from "./useSyncTasks";
import { useWorkspaceArgs } from "./useWorkspaceArgs";

// Keeps the task store warm while the user is anywhere BUT the tasks/projects
// pages (which mount their own useSyncTasks and own the channel — hence the
// skip, so we never run two cursor state machines for the same args).
//
// This reuses the full sync hook rather than holding a bare webList
// subscription: a subscription without the delta cursor re-executes the whole
// 300-row-per-scope scan server-side and re-ships the multi-MB payload on
// EVERY task write anywhere in the workspace. That standing re-run load is
// what pushed tasks:webList over the "too many system operations" budget
// whenever the backend hit a slow window.
export function usePrefetch() {
  const pathname = usePathname();
  const workspaceArgs = useWorkspaceArgs();
  const isOnTasksPage = pathname === "/tasks" || pathname?.startsWith("/tasks/");
  const isOnProjectsPage = pathname === "/projects" || pathname?.startsWith("/projects/");

  useSyncTasksWithArgs(isOnTasksPage || isOnProjectsPage ? "skip" : workspaceArgs);
}
