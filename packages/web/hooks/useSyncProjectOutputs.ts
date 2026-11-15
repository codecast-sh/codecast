// A project's outputs (ct-94262), fed in two parts (shared/contracts/
// projectOutputs.ts): the members row (sessions, tasks, images) under the
// project's Convex id, and the items row (pull requests, pages, docs) under
// `<id>:items`. The items query is asked by the member ids, so a session's
// heartbeat re-runs only the members part. The view reads the two joined.
import { useMemo } from "react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import {
  joinProjectOutputs,
  outputItemArgs,
  type ProjectOutputItems,
  type ProjectOutputMembers,
  type ProjectOutputs,
} from "@codecast/shared/contracts/projectOutputs";
import { useInboxStore } from "../store/inboxStore";
import { useSyncCollection } from "./useSyncCollection";

const api = _api as any;

export type { OutputDoc, OutputImage, OutputPage, OutputPr, OutputSession, OutputTask, PrGroup } from "@codecast/shared/contracts/projectOutputs";
export type ProjectOutputsRow = ProjectOutputs & { _id: string };

const itemsKey = (projectId: string) => `${projectId}:items`;
const selectMembers = (row: any) => (row?.project?.id ? [{ _id: row.project.id, ...row }] : []);
const selectItems = (row: any) => (row?.project_id ? [{ _id: itemsKey(row.project_id), ...row }] : []);

/** A members row as this build writes it (a row cached by an older build has no sessions). */
function membersOf(s: any, projectId: string | null | undefined): ProjectOutputMembers | undefined {
  const row = projectId ? s.projectOutputs?.[projectId] : undefined;
  return row && Array.isArray(row.sessions) ? (row as ProjectOutputMembers) : undefined;
}

// The items arguments of a members row, computed once per row ref.
const argsKeys = new WeakMap<object, string>();
function itemArgsKey(m: ProjectOutputMembers): string {
  let key = argsKeys.get(m);
  if (key === undefined) argsKeys.set(m, (key = JSON.stringify(outputItemArgs(m))));
  return key;
}

/** Feeder: one project's outputs, by its Convex id. */
export function useSyncProjectOutputs(projectRef: string | null | undefined) {
  const members = useSyncCollection("projectOutputs", api.projectOutputs.members, projectRef ? { project_id: projectRef } : "skip", useMemo(() => ({ select: selectMembers }), []));
  // The members row is keyed by the project's Convex id, which the page passes.
  const projectId = projectRef ?? null;
  // Equal whenever membership is, so churn on the members row asks nothing new.
  const argsKey = useInboxStore((s) => {
    const m = membersOf(s, projectId);
    return m ? itemArgsKey(m) : "";
  });
  const itemArgs = useMemo(() => (argsKey && projectId ? { project_id: projectId, ...JSON.parse(argsKey) } : "skip"), [argsKey, projectId]);
  const items = useSyncCollection("projectOutputs", api.projectOutputs.items, itemArgs, useMemo(() => ({ select: selectItems }), []));
  return { ...members, ready: members.ready && (itemArgs === "skip" || items.ready), error: members.error ?? items.error, retry: () => { members.retry(); items.retry(); } };
}

/** Reader: the outputs for a project's Convex id, the two parts joined. */
export function useProjectOutputs(projectId: string | null | undefined): ProjectOutputsRow | undefined {
  const members = useInboxStore((s) => membersOf(s, projectId));
  const items = useInboxStore((s) => (projectId ? ((s as any).projectOutputs?.[itemsKey(projectId)] as ProjectOutputItems | undefined) : undefined));
  return useMemo(() => (members && projectId ? { _id: projectId, ...joinProjectOutputs(members, items) } : undefined), [members, items, projectId]);
}
