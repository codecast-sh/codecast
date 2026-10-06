// Workflow runs across workflows (docs/architecture/the-line.md L8, L10):
// the one list feed for the scope line board and the routines Runs tab.
// workflow_runs.listRuns answers for the active workspace (team_id when the
// viewer is in a team, personal otherwise) and overlays the shared
// `workflowRuns` collection, so a run the workflow page fed earlier and a run
// this feed brings share one row.
import { useMemo } from "react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { useSyncCollection } from "./useSyncCollection";
import { useCollectionRows } from "./useCollectionRows";
import { useFeederWorkspace } from "./useWorkspaceArgs";
import { useActiveWorkspaceKey } from "./useWorkspaceCollection";

const api = _api as any;

export type RunsFeedArgs = { task_id?: string; plan_id?: string; status?: string; limit?: number };

/** Feeder: a workspace's runs, newest first, into `workflowRuns`: the active
 *  workspace's unless `workspace` names another (a stored access key). */
export function useSyncRuns(args: RunsFeedArgs = {}, enabled = true, workspace?: string | null) {
  const { args: ws } = useFeederWorkspace(workspace);
  const teamId = ws === "skip" ? undefined : ws.team_id;
  const queryArgs = useMemo(
    () => (ws === "skip" || !enabled ? "skip" : { ...(teamId ? { team_id: teamId } : {}), ...args }),
    // args is a plain object literal at most call sites; key it by value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ws === "skip", enabled, teamId, args.task_id, args.plan_id, args.status, args.limit],
  );
  return useSyncCollection("workflowRuns", api.workflow_runs.listRuns, queryArgs as any);
}

/** A run row as listRuns shapes it (the raw row plus its joins). */
export type LineRun = {
  _id: string;
  status: "pending" | "running" | "paused" | "completed" | "failed";
  workspace?: string;
  task_id?: string;
  plan_id?: string;
  task_short_id?: string;
  task_title?: string;
  plan_short_id?: string;
  workflow_id?: string;
  workflow_name?: string;
  workflow_slug?: string;
  current_node_id?: string;
  current_node_label?: string;
  gate_decision_id?: string;
  gate_decision_short_id?: string;
  gate_decision_status?: string;
  /** The last gate's answer, in the option's words (workflow_runs.enrichRun). */
  gate_answer?: string;
  /** The cost the run's card records, in dollars. */
  card_cost_usd?: number;
  gate_node_id?: string;
  gate_choices?: Array<{ key: string; label: string; target: string }>;
  gate_response?: string;
  /** LE14: the content hash of the graph the run executed. */
  graph_hash?: string;
  merge?: { sha: string; branch: string; into: string; at: number; pr_url?: string };
  primary_conversation_id?: string;
  primary_session_id?: string;
  fail_reason?: string;
  node_statuses?: Array<{ node_id: string; status: string; outcome?: string; label?: string; session_id?: string; started_at?: number; completed_at?: number; result_preview?: string; session?: any }>;
  created_at: number;
  updated_at: number;
};

const lineRunSig = (r: LineRun) =>
  `${r.status}|${r.current_node_id ?? ""}|${r.current_node_label ?? ""}|${r.updated_at ?? 0}|${r.gate_decision_id ?? ""}|${r.gate_decision_status ?? ""}|${r.task_id ?? ""}|${r.workflow_name ?? ""}|${r.primary_conversation_id ?? ""}|${r.gate_answer ?? ""}|${r.graph_hash ?? ""}|${r.card_cost_usd ?? ""}`;
const newestFirst = (a: LineRun, b: LineRun) => (b.updated_at ?? b.created_at ?? 0) - (a.updated_at ?? a.created_at ?? 0);

/** A run belongs to the active workspace by its stored access key (L8). A
 *  row minted before the key existed has none and reads as personal, the
 *  same rule listRuns applies on the server. */
export function runInWorkspace(run: { workspace?: string }, key: string | null): boolean {
  if (!key) return false;
  if (run.workspace) return run.workspace === key;
  return key.startsWith("user:");
}

/** Reader: a workspace's runs from the store, newest first: the active
 *  workspace's unless `workspace` names another. */
export function useWorkspaceRuns(workspace?: string | null): LineRun[] {
  const active = useActiveWorkspaceKey();
  const key = workspace || active;
  const where = useMemo(() => (r: LineRun) => runInWorkspace(r, key), [key]);
  return useCollectionRows<LineRun>("workflowRuns", { where, sig: lineRunSig, sort: newestFirst });
}
