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
import { useWorkspaceArgs, workspaceStamp } from "./useWorkspaceArgs";
import { useActiveWorkspaceKey } from "./useWorkspaceCollection";

const api = _api as any;

export type RunsFeedArgs = { task_id?: string; plan_id?: string; status?: string; limit?: number };

/** Feeder: the workspace's runs, newest first, into `workflowRuns`. */
export function useSyncRuns(args: RunsFeedArgs = {}, enabled = true) {
  const ws = useWorkspaceArgs();
  const stamp = workspaceStamp(ws);
  const teamId = "team_id" in stamp ? stamp.team_id : undefined;
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
  gate_node_id?: string;
  primary_conversation_id?: string;
  primary_session_id?: string;
  fail_reason?: string;
  node_statuses?: Array<{ node_id: string; status: string; result_preview?: string; session?: any }>;
  created_at: number;
  updated_at: number;
};

const lineRunSig = (r: LineRun) =>
  `${r.status}|${r.current_node_id ?? ""}|${r.current_node_label ?? ""}|${r.updated_at ?? 0}|${r.gate_decision_id ?? ""}|${r.gate_decision_status ?? ""}|${r.task_id ?? ""}|${r.workflow_name ?? ""}|${r.primary_conversation_id ?? ""}`;
const newestFirst = (a: LineRun, b: LineRun) => (b.updated_at ?? b.created_at ?? 0) - (a.updated_at ?? a.created_at ?? 0);

/** A run belongs to the active workspace by its stored access key (L8). A
 *  row minted before the key existed has none and reads as personal, the
 *  same rule listRuns applies on the server. */
export function runInWorkspace(run: { workspace?: string }, key: string | null): boolean {
  if (!key) return false;
  if (run.workspace) return run.workspace === key;
  return key.startsWith("user:");
}

/** Reader: the active workspace's runs from the store, newest first. */
export function useWorkspaceRuns(): LineRun[] {
  const key = useActiveWorkspaceKey();
  const where = useMemo(() => (r: LineRun) => runInWorkspace(r, key), [key]);
  return useCollectionRows<LineRun>("workflowRuns", { where, sig: lineRunSig, sort: newestFirst });
}
