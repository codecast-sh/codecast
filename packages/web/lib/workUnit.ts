// A task and its owning session are one unit of work with two faces
// (components/work/WorkUnitBar). The hooks and context the faces share live
// here, apart from the components, so those files stay Fast Refresh
// boundaries.

import { createContext } from "react";
import { useRouter } from "next/navigation";
import { stageNavigateLeaf } from "./stage";
import { useTabContext } from "./tabParams";

export type WorkFace = "task" | "session";

/** True inside the other face shown stacked under a WorkUnitBar: that copy
 *  draws neither its own bar nor the task's work panel, which the face
 *  around it already shows. */
export const InsideWorkUnit = createContext(false);

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
