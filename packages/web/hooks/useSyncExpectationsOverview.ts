// Every project's expectations in a workspace, one summary row each
// (expectations.overview): the /expectations page. A snapshot of the active
// workspace; rows carry the workspace key the reader filters by.
import { useMemo } from "react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { useSyncCollection } from "./useSyncCollection";
import { useFeederWorkspace } from "./useWorkspaceArgs";
import { useWorkspaceCollection } from "./useWorkspaceCollection";

const api = _api as any;

export type ExpectationsOverviewRow = {
  _id: string;
  workspace: string;
  project: { id: string; short_id?: string; title: string; status?: string };
  version: number;
  applied_at: number | null;
  active: number;
  retired: number;
  parts: number;
  open_proposals: number;
  breaks7: number;
  breaks30: number;
  /** Active lines a finding cited in the last 30 days. */
  broken: number;
  most_broken: Array<{ id: string; text: string; part: string; d7: number; d30: number }>;
};

/** Feeder: the active workspace's overview. */
export function useSyncExpectationsOverview() {
  const { args } = useFeederWorkspace();
  const teamId = args === "skip" ? "skip" : args.team_id ?? "";
  const queryArgs = useMemo(() => (teamId === "skip" ? "skip" : teamId ? { team_id: teamId } : {}), [teamId]);
  return useSyncCollection("expectationsOverview", api.expectations.overview, queryArgs as any);
}

const rowSig = (r: ExpectationsOverviewRow) => `${r.version}|${r.active}|${r.open_proposals}|${r.breaks7}|${r.breaks30}|${r.project.title}|${r.most_broken.map((m) => m.id + m.d30).join(",")}`;

/** Reader: the active workspace's overview rows. */
export function useExpectationsOverview(): ExpectationsOverviewRow[] {
  return useWorkspaceCollection<ExpectationsOverviewRow>("expectationsOverview", rowSig);
}
