// The goal a cause names (LE5), resolved to words the same way on every
// surface: the task page's Line block and a change card both read it, so a
// goal is never shown as its key. A ground may name its project by row id,
// and the project may sit outside the active workspace: that one row is read
// by key to name it.
import { useMemo } from "react";
import { useInboxStore } from "../store/inboxStore";
import { useInitiatives } from "./useInitiatives";
import { useWorkspaceCollection } from "./useWorkspaceCollection";
import { goalChip, type GoalRow } from "../lib/lineFlow";

export function useGoalChip(ref: string | null | undefined) {
  const initiatives = useInitiatives();
  const wsProjects = useWorkspaceCollection<GoalRow & { _id: string }>("projects");
  const head = ref?.split(":")[0] ?? "";
  const named = useInboxStore((st) => (head ? ((st.projects as Record<string, GoalRow & { _id: string }>)[head] ?? null) : null));
  return useMemo(() => {
    const projects = named && !wsProjects.includes(named) ? [...wsProjects, named] : wsProjects;
    return goalChip(ref, initiatives as GoalRow[], projects);
  }, [ref, initiatives, wsProjects, named]);
}
