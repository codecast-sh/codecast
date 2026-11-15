// The sources teammates armed on one project (projectSources.teammateSources),
// fed into projectTeammateSources. The Sources panel lists them beside the
// viewer's own, which live in agentTasks. Feeder returns readiness only.
import { useMemo } from "react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { useSyncCollection } from "./useSyncCollection";

const api = _api as any;

/** Feeder: one project's teammate sources. A row of this project the answer no longer holds is dropped. */
export function useSyncProjectTeammateSources(projectId: string | null | undefined) {
  const opts = useMemo(() => ({ dropAbsent: (row: any) => row?.project_id === projectId }), [projectId]);
  return useSyncCollection("projectTeammateSources", api.projectSources.teammateSources, projectId ? { project_id: projectId } : "skip", opts);
}
