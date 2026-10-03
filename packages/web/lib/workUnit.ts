// A task and its owning session are one unit of work with two faces: the
// session carries its task on its context rail (components/work/
// TaskContextPanel), the task page carries its session in place
// (TaskSessionSection). The hooks the faces share live here, apart from the
// components, so those files stay Fast Refresh boundaries.

import { useRouter } from "next/navigation";
import { sessionPanePath, stageNavigateLeaf } from "./stage";
import { leavesOf } from "../store/stageSplit";
import { useInboxStore } from "../store/inboxStore";
import { useTabContext } from "./tabParams";

export function taskFacePath(task: { _id: string; short_id?: string | null }): string {
  return `/tasks/${task.short_id || task._id}`;
}

/** Re-point the pane this face renders in; a plain tab navigates. */
export function useSwitchFace(): (path: string) => void {
  const router = useRouter();
  const ctx = useTabContext();
  return (path: string) => {
    if (ctx?.leafId) stageNavigateLeaf(ctx.leafId, path, "replace");
    else router.push(path);
  };
}

/** The stage leaf of the active tab showing `path`, or null. */
export function useLeafShowing(path: string): string | null {
  return useInboxStore((s) => {
    const tab = s.tabs.find((t) => t.id === s.activeTabId);
    return tab?.layout ? leavesOf(tab.layout).find((l) => l.path === path)?.id ?? null : null;
  });
}

/** Is the session's own page a pane of this tab's stage. */
export function useSessionOnScreen(sessionId: string): boolean {
  return useLeafShowing(sessionPanePath(sessionId)) !== null;
}
