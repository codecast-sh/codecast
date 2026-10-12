// Trial projects (convex lineTrial.ts) for the /trial page: the workspace's
// trial cards and projects, snapshots of the active workspace, and each
// trial's spend, one row per project.
import { useMemo } from "react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import type { ChangeCard } from "@codecast/shared/contracts/changeCard";
import { useSyncCollection } from "./useSyncCollection";
import { useFeederWorkspace } from "./useWorkspaceArgs";
import { useWorkspaceCollection } from "./useWorkspaceCollection";
import { useTrackedStore } from "../store/inboxStore";

const api = _api as any;

export type TrialCardRow = {
  _id: string;
  workspace: string;
  short_id: string;
  project_id: string;
  project_title: string;
  task_id: string;
  task_short_id: string;
  task_title: string;
  task_status: string;
  run_id: string;
  run_status: string;
  node_id: string;
  kind: "card" | "gate";
  question: string;
  context_md?: string;
  doc_md?: string;
  options: Array<{ key: string; label: string; description?: string }>;
  card?: ChangeCard;
  status: "waiting" | "answered" | "closed";
  answer?: { key: string; label: string; note?: string; at: number; by: string; stand_in?: boolean };
  created_at: number;
  updated_at: number;
};

/** A trial problem's latest run (convex lineTrial.runs), keyed by the problem. */
export type TrialRunRow = {
  _id: string;
  workspace: string;
  project_id: string;
  task_short_id: string;
  task_title: string;
  task_status: string;
  run_id: string;
  status: "pending" | "running" | "paused" | "completed" | "failed";
  node_id: string | null;
  fail_reason: string | null;
  fresh_branch: boolean;
  created_at: number;
  updated_at: number;
};

export type TrialProjectRow = { _id: string; workspace: string; title: string; short_id?: string; since: number };

export type TrialSpendRow = {
  _id: string;
  since: number;
  budget: { cap_usd: number; month: string; spent_usd: number; held_usd: number; by_purpose: { judge: number; grouping: number; call: number }; refused: number; earlier_months_usd: number };
  runs: number;
  sessions: number;
  session_usd: number;
  unpriced_tokens: number;
  total_usd: number;
  at: number;
};

function useTeamArgs() {
  const { args } = useFeederWorkspace();
  const teamId = args === "skip" ? "skip" : args.team_id ?? "";
  // The workspace is named outright: lineTrial's reads take the CLI's scope
  // args, where a bare team_id falls back to the personal workspace.
  return useMemo(() => (teamId === "skip" ? "skip" : teamId ? { workspace: "team" as const, team_id: teamId } : { workspace: "personal" as const }), [teamId]);
}

/** Feeder: the active workspace's trial cards and trial projects. */
export function useSyncTrial() {
  const args = useTeamArgs();
  const cards = useSyncCollection("trialCards", api.lineTrial.cards, args as any);
  useSyncCollection("trialProjects", api.lineTrial.projects, args as any);
  useSyncCollection("trialRuns", api.lineTrial.runs, args as any);
  return cards;
}

/** The query answers one project's row; the collection takes a list. */
const SPEND_OPTS = { select: (row: TrialSpendRow | null) => (row ? [row] : []) };

/** Feeder: one trial project's spend. */
export function useSyncTrialSpend(projectId: string | null) {
  const args = useTeamArgs();
  const queryArgs = useMemo(() => (args === "skip" || !projectId ? "skip" : { ...args, project: projectId }), [args, projectId]);
  return useSyncCollection("trialSpend", api.lineTrial.spend, queryArgs as any, SPEND_OPTS);
}

const cardSig = (r: TrialCardRow) => `${r.status}|${r.answer?.key ?? ""}|${r.run_status}|${r.task_status}|${r.task_title}|${r.updated_at}`;

/** Reader: the active workspace's trial cards, newest first. */
export function useTrialCards(): TrialCardRow[] {
  const rows = useWorkspaceCollection<TrialCardRow>("trialCards", cardSig);
  return useMemo(() => [...rows].sort((a, b) => b.created_at - a.created_at), [rows]);
}

/** Reader: the active workspace's trial runs, the latest per problem, newest first. */
export function useTrialRuns(): TrialRunRow[] {
  const rows = useWorkspaceCollection<TrialRunRow>("trialRuns", (r) => `${r.status}|${r.run_id}|${r.node_id}|${r.fail_reason}|${r.task_title}|${r.updated_at}`);
  return useMemo(() => [...rows].sort((a, b) => b.updated_at - a.updated_at), [rows]);
}

/** Reader: the active workspace's trial projects. */
export function useTrialProjects(): TrialProjectRow[] {
  return useWorkspaceCollection<TrialProjectRow>("trialProjects", (r) => `${r.title}|${r.since}`);
}

/** Reader: one trial project's spend. */
export function useTrialSpend(projectId: string | null): TrialSpendRow | null {
  const s = useTrackedStore([(st) => (projectId ? (st as any).trialSpend?.[projectId]?.at : null)]);
  return projectId ? ((s as any).trialSpend?.[projectId] ?? null) : null;
}
