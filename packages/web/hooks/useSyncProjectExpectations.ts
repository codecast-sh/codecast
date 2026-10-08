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
  retracted_reason?: string;
  /** The card's short id, when a session put the proposal in a person's queue. */
  card?: string;
  card_id?: string;
  card_status?: string;
  refused?: string;
  created_at: number;
  resolved_at?: number;
  /** Who proposed an open proposal, and whether a session did (the routine, an agent). */
  proposed_by?: string;
  from_session?: boolean;
  /** An open proposal's changes in full. */
  ops?: ExpectationOp[];
};

/** One finding that cited a line: the signal a judge filed with the line's id as its subject, and the cause it opened. */
export type ExpectationFinding = {
  short_id: string;
  title: string;
  kind: string;
  source: string;
  created_at: number;
  evidence_url?: string;
  cause?: { id: string; short_id?: string; title: string; status: string };
};

/** How often findings cite one line: breaks in the last 7 and 30 days, the newest findings. */
export type ExpectationLineUsage = { d7: number; d30: number; last_at?: number; findings: ExpectationFinding[] };

export type ExpectationVersionView = {
  version: number;
  summary: string;
  how: "person" | "auto";
  applied_at: number;
  applied_by?: string;
  active: number;
  added?: number;
  changed?: number;
  retired?: number;
  /** The proposal it applied, who proposed it, and whether a session did. */
  proposal?: string;
  proposed_by?: string;
  from_session?: boolean;
};

export type ProjectExpectationsRow = {
  _id: string;
  project: { id: string; title: string };
  current_version: number;
  doc: (ExpectationsVersion & { items: Expectation[] }) | null;
  versions: ExpectationVersionView[];
  proposals: ExpectationProposalView[];
  cursor: number | null;
  /** The viewer is the project's person, whose own edits apply as they make them. */
  you_answer?: boolean;
  /** The project's person by name: who applies what waits. */
  person?: string;
  /** Breaks per line id over the last 30 days (signals whose subject is the id). */
  usage?: { since: number; lines: Record<string, ExpectationLineUsage> };
  /** Who said each source's words, keyed `<kind>:<ref>`. */
  sources?: Record<string, { who?: string }>;
  /** The routine that proposes changes from the team's context, when one is installed for the project. */
  routine?: { trigger_id: string; short_id?: string; status: string; run_at?: number; last_run_at?: number } | null;
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
