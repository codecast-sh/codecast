// A project's expectations (the-line-model.md LM5; line-map.md LX3): the
// view expectations.forProject computes, stored under the project's Convex id
// so a panel paints from cache on the next visit. The feeder returns
// readiness only; surfaces read the store (useProjectExpectations).
import { useMemo } from "react";
import type { Expectation, ExpectationOp, ExpectationsVersion } from "@codecast/shared/contracts/expectations";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore } from "../store/inboxStore";
import { entityIdArgs, useSyncCollection } from "./useSyncCollection";

const api = _api as any;

export type ExpectationProposalView = {
  short_id: string;
  status: "open" | "applied" | "dropped" | "empty" | "retracted";
  summary: string;
  changes: number;
  base_version: number;
  applied_version?: number;
  /** The card's short id, when a session put the proposal in a person's queue. */
  card?: string;
  card_id?: string;
  card_status?: string;
  refused?: string;
  created_at: number;
  /** An open proposal's changes in full. */
  ops?: ExpectationOp[];
};

export type ProjectExpectationsRow = {
  _id: string;
  project: { id: string; title: string };
  current_version: number;
  doc: (ExpectationsVersion & { items: Expectation[] }) | null;
  versions: Array<{ version: number; summary: string; how: "person" | "auto"; applied_at: number; applied_by?: string; active: number }>;
  proposals: ExpectationProposalView[];
  cursor: number | null;
  /** The viewer is the project's person, whose own edits apply as they make them. */
  you_answer?: boolean;
};

const selectRow = (row: any) => (row?.project?.id ? [{ _id: row.project.id, ...row }] : []);

/** Feeder: one project's expectations. */
export function useSyncProjectExpectations(projectId: string | null | undefined) {
  return useSyncCollection("projectExpectations", api.expectations.forProject, entityIdArgs("project_id", projectId ?? undefined), useMemo(() => ({ select: selectRow }), []));
}

/** Reader: the expectations row for a project's Convex id. */
export function useProjectExpectations(projectId: string | null | undefined): ProjectExpectationsRow | undefined {
  return useInboxStore((s) => (projectId ? ((s as any).projectExpectations?.[projectId] as ProjectExpectationsRow | undefined) : undefined));
}
