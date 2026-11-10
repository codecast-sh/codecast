// Wake-signature readers for the plan surfaces (PlanDetailPanel, the plan
// page). Kept out of the component module so it stays a Fast Refresh boundary.
import { useMemo } from "react";
import { useInboxStore } from "../../store/inboxStore";

// The plan surfaces read only their own tasks and those tasks' live sessions,
// but both store maps are replaced on writes anywhere (any task's edit, every
// session push). These subscribe to a wake signature of the rows the plan
// draws and hand back the current map, so the rest of the store's churn does
// not repaint the plan (AGENTS.md "Reading state in components").

/** The store's tasks map, woken only by a change to one of `taskIds`. */
export function usePlanStoreTasks(taskIds: readonly string[]): Record<string, any> {
  const sig = useInboxStore((s) => {
    let out = "";
    for (const id of taskIds) {
      const t = (s.tasks as Record<string, any>)[id];
      out += t ? `${id}:${t.updated_at ?? 0}:${t.status}:${t.assignee ?? ""}:${t.parent_id ?? ""}|` : `${id}:-|`;
    }
    return out;
  });
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the signature stands in for the churny map
  return useMemo(() => useInboxStore.getState().tasks as Record<string, any>, [sig]);
}

/** The live-session map, woken only by the drawn fields of `tasks`' sessions. */
export function usePlanActiveSessions(tasks: readonly any[]): Record<string, any> {
  const sig = useInboxStore((s) => {
    let out = "";
    for (const t of tasks) {
      const a = s.taskActiveSessions[t._id];
      if (a) out += `${t._id}:${a._id}:${a.session_id}:${a.agent_status ?? ""}:${a.agent_type ?? ""}:${a.started_by ?? ""}:${a.last_message_at ?? 0}:${a.title ?? ""}|`;
    }
    return out;
  });
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the signature stands in for the churny map
  return useMemo(() => useInboxStore.getState().taskActiveSessions, [sig]);
}
