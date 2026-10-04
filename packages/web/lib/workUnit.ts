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
import { sessionLiveAt } from "./liveness";
import { identityLine, identityRowOf } from "./sessionIdentity";
import { cleanTitle } from "./conversationProcessor";
import { useCoarseNow } from "../hooks/useCoarseNow";
import { usePersonifyAll } from "../hooks/usePersonifyAll";

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

// How recently a session must have moved to count as working when its daemon
// is not heartbeating: the server's own rule (convex lib/taskOwner.ts
// isSessionWorking), so the composer's promise and the relay agree.
const RECENT_ACTIVITY_MS = 15 * 60 * 1000;

/** The name of the task's owning session when it is working, so a comment
 *  composer can say who will receive the comment (convex tasks.ts
 *  deliverCommentToOwner relays a person's comment to it). Null otherwise. */
export function useWorkingOwnerName(ownerSessionId: string | null | undefined): string | null {
  const personifyAll = usePersonifyAll();
  const now = useCoarseNow(30_000);
  return useInboxStore((s) => {
    const r: any = ownerSessionId ? s.sessions[ownerSessionId] : null;
    if (!r || r.status === "completed" || r.inbox_killed_at) return null;
    const working = sessionLiveAt(r, now) || now - (r.updated_at ?? 0) < RECENT_ACTIVITY_MS;
    if (!working) return null;
    const title = cleanTitle(String(r.title || "")) || "the session";
    return identityLine(identityRowOf(r), title, personifyAll).name ?? title;
  });
}
