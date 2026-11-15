// A project's outputs (ct-94262): the one object projectOutputs.get computes,
// stored under the project's Convex id so the Outputs view paints from cache
// on the next visit. Feeder returns readiness only; the view reads the store.
import { useMemo } from "react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import type { ProjectOutputs } from "@codecast/convex/convex/projectOutputs";
import { useInboxStore } from "../store/inboxStore";
import { useSyncCollection } from "./useSyncCollection";

const api = _api as any;

export type { OutputDoc, OutputImage, OutputPage, OutputPr, OutputSession, OutputTask, PrGroup } from "@codecast/convex/convex/projectOutputs";
export type ProjectOutputsRow = ProjectOutputs & { _id: string };

const selectRow = (row: any) => (row?.project?.id ? [{ _id: row.project.id, ...row }] : []);

/** Feeder: one project's outputs, by Convex id or pj- short id. */
export function useSyncProjectOutputs(projectRef: string | null | undefined) {
  return useSyncCollection("projectOutputs", api.projectOutputs.get, projectRef ? { project_id: projectRef } : "skip", useMemo(() => ({ select: selectRow }), []));
}

/** Reader: the outputs row for a project's Convex id. */
export function useProjectOutputs(projectId: string | null | undefined): ProjectOutputsRow | undefined {
  return useInboxStore((s) => (projectId ? ((s as any).projectOutputs?.[projectId] as ProjectOutputsRow | undefined) : undefined));
}
