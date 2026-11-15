import { api } from "@codecast/convex/convex/_generated/api";
import type { TaskCost } from "@codecast/convex/convex/taskCost";
import { useQueryNoThrow } from "./useQueryNoThrow";
import { scopeArgsOf } from "../lib/workspaceScope";

/** The task's cost, or null while unknown and when none of its sessions reported tokens. */
export function useTaskCost(shortId: string, workspace?: string | null): TaskCost | null {
  const { data } = useQueryNoThrow(api.taskCost.cost, workspace ? { ...scopeArgsOf(workspace), task: shortId } : "skip");
  return data && data.sessions > 0 ? data : null;
}
