// A workflow run's nodes as one ordered list of rows, the shape every run
// surface renders (WorkflowRunNodes): the context panel on a task, plan or
// conversation, the run page, the routines side panel and the inline
// conversation card. Pure, so the ordering and the counts have one home.

import { stripMarkdown } from "./notificationText";

export type RunNodeStatus = "pending" | "running" | "completed" | "failed";

/** The conversation the server attached to a node (workflow_runs.withAgentSessions). */
export type RunNodeSession = {
  _id: string;
  session_id?: string;
  title?: string;
  project_path?: string;
  message_count?: number;
  is_active?: boolean;
  started_at?: number;
  updated_at?: number;
  agent_type?: string;
  parent_conversation_id?: string;
};

export type RunNodeRow = {
  id: string;
  label: string;
  type: string;
  status: RunNodeStatus;
  /** The node the run is at, while the run is alive. */
  current: boolean;
  session?: RunNodeSession;
  /** The daemon handle when the row carries no attached session. */
  session_id?: string;
  started_at?: number;
  completed_at?: number;
  outcome?: string;
  tokens?: number;
  activity?: string;
  result_preview?: string;
  phase?: string;
};

export type RunNodeGroup = { title?: string; detail?: string; rows: RunNodeRow[] };

const HIDDEN_TYPES = new Set(["start", "exit"]);

/**
 * Graph order when the run has a stored workflow, else the order the statuses
 * were written in. A node the run is at counts as running until a status
 * says otherwise, the way the runner reports it.
 */
export function runNodeRows(run: any, workflow?: any | null): RunNodeRow[] {
  const statuses: any[] = run?.node_statuses ?? [];
  const byId = new Map<string, any>(statuses.map((n) => [n.node_id, n]));
  const alive = run?.status === "running" || run?.status === "paused" || run?.status === "pending";
  const graph: any[] = (workflow?.nodes ?? []).filter((n: any) => !HIDDEN_TYPES.has(n.type));
  const seen = new Set<string>();
  const rows: RunNodeRow[] = [];
  const push = (id: string, label: string | undefined, type: string | undefined) => {
    if (seen.has(id)) return;
    seen.add(id);
    const ns = byId.get(id);
    const current = alive && run?.current_node_id === id;
    const status: RunNodeStatus = ns?.status ?? (current && run?.status === "running" ? "running" : "pending");
    rows.push({
      id,
      label: ns?.label ?? label ?? id,
      type: type ?? "agent",
      status,
      current,
      session: ns?.session ?? undefined,
      session_id: ns?.session_id ?? undefined,
      started_at: ns?.started_at,
      completed_at: ns?.completed_at,
      outcome: ns?.outcome,
      tokens: ns?.tokens,
      activity: ns?.activity,
      result_preview: ns?.result_preview,
      phase: ns?.phase,
    });
  };
  for (const n of graph) push(n.id, n.label, n.type);
  for (const ns of statuses) push(ns.node_id, ns.label, undefined);
  return rows;
}

/** Rows grouped by the phases a dynamic run declares; one unnamed group otherwise. */
export function runNodeGroups(run: any, workflow?: any | null): RunNodeGroup[] {
  const rows = runNodeRows(run, workflow);
  const declared: { title: string; detail?: string }[] = run?.phases ?? [];
  const titles = declared.length
    ? declared.map((p) => p.title)
    : Array.from(new Set(rows.map((r) => r.phase).filter((p): p is string => !!p)));
  if (titles.length === 0) return [{ rows }];
  const groups: RunNodeGroup[] = titles
    .map((title) => ({
      title,
      detail: declared.find((p) => p.title === title)?.detail,
      rows: rows.filter((r) => r.phase === title),
    }))
    .filter((g) => g.rows.length > 0);
  const unphased = rows.filter((r) => !r.phase || !titles.includes(r.phase));
  if (unphased.length) groups.push({ rows: unphased });
  return groups;
}

export type RunNodeCounts = { total: number; done: number; failed: number; running: number; sessions: number };

export function runNodeCounts(rows: RunNodeRow[]): RunNodeCounts {
  const counts: RunNodeCounts = { total: rows.length, done: 0, failed: 0, running: 0, sessions: 0 };
  for (const r of rows) {
    if (r.status === "completed") counts.done++;
    else if (r.status === "failed") counts.failed++;
    else if (r.status === "running") counts.running++;
    if (r.session || r.session_id) counts.sessions++;
  }
  return counts;
}

/** The row's one line under the title: what it is doing, or what it produced,
 *  as plain text (a result preview is the agent's markdown reply). */
export function runNodeLine(row: RunNodeRow): string | undefined {
  const raw = row.status === "running"
    ? row.activity || row.result_preview
    : row.result_preview || row.activity;
  const line = raw ? stripMarkdown(raw) : "";
  return line || undefined;
}

export function formatRunDuration(startMs: number, endMs?: number, now = Date.now()): string {
  const secs = Math.max(0, Math.floor(((endMs ?? now) - startMs) / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ${secs % 60}s`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

export function wfStatusMeta(status?: string): { icon: string; cls: string; dot: string } {
  switch (status) {
    case "completed": return { icon: "✓", cls: "text-sol-green", dot: "" };
    case "failed":    return { icon: "✗", cls: "text-sol-red", dot: "" };
    case "running":   return { icon: "", cls: "text-sol-yellow", dot: "bg-sol-yellow animate-pulse" };
    default:          return { icon: "", cls: "text-sol-text-dim", dot: "bg-sol-text-dim/40" };
  }
}

export function wfFmtTokens(n?: number): string {
  if (!n) return "";
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : `${n}`;
}
