// A task and its owning session are one unit of work with two faces
// (components/work/WorkUnitBar). The hooks and context the faces share live
// here, apart from the components, so those files stay Fast Refresh
// boundaries.

import { createContext, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { sessionPanePath, stageNavigateLeaf } from "./stage";
import { leavesOf } from "../store/stageSplit";
import { useInboxStore } from "../store/inboxStore";
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

// Which sessions are stacked under a bar right now ("Both" in a narrow pane).
// One home for the fact: the bar toggles it, and the task's work panel reads
// it to step aside while the session's own transcript and composer are on
// screen (two composers on one conversation would race for its draft).
const stackedSessions = new Set<string>();
const stackListeners = new Set<() => void>();
export function setSessionStacked(sessionId: string, on: boolean): void {
  if (on === stackedSessions.has(sessionId)) return;
  if (on) stackedSessions.add(sessionId); else stackedSessions.delete(sessionId);
  for (const l of stackListeners) l();
}
const subscribeStack = (l: () => void) => { stackListeners.add(l); return () => { stackListeners.delete(l); }; };
export function useSessionStacked(sessionId: string): boolean {
  return useSyncExternalStore(subscribeStack, () => stackedSessions.has(sessionId), () => false);
}

/** Is the session's own page on screen in this tab: stacked under a bar, or
 *  a pane of the stage. */
export function useSessionOnScreen(sessionId: string): boolean {
  const stacked = useSessionStacked(sessionId);
  const path = sessionPanePath(sessionId);
  const inPane = useInboxStore((s) => {
    const tab = s.tabs.find((t) => t.id === s.activeTabId);
    return !!tab?.layout && leavesOf(tab.layout).some((l) => l.path === path);
  });
  return stacked || inPane;
}
