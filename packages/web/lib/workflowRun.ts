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
  /** The session's pin (`cast state`): its first line is what the station says it did. */
  state?: string;
  state_status?: string;
  /** The pin's json block, whole: what the station reported for its edges. */
  result?: string;
  /** The session was killed; with no message, it never started. */
  killed?: boolean;
  /** Its last `cast task handoff` on the run's task: how a builder ended. */
  handoff?: { status: string; note?: string; at?: number };
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

type SyncedRun = { _id: string; node_statuses?: Array<{ node_id: string; session_id?: string; session?: unknown }> };

/**
 * Every run feed attaches each node's session under a read budget
 * (workflow_runs.withAgentSessions), so a wide feed (the line floor) hands back
 * older runs with bare nodes while the cause's own feed attached them. A bare
 * node keeps the session the store already holds for the same node and hand,
 * so the feeds overlay without stripping what a station reported. Returns the
 * same array when nothing was carried.
 */
export function carryNodeSessions<T extends SyncedRun>(rows: T[], prev: Record<string, SyncedRun | undefined> | undefined): T[] {
  if (!prev || !Array.isArray(rows)) return rows;
  let changed = false;
  const out = rows.map((r) => {
    const old = r && prev[r._id]?.node_statuses;
    if (!old?.length || !Array.isArray(r.node_statuses)) return r;
    let nodes: NonNullable<SyncedRun["node_statuses"]> | null = null;
    r.node_statuses.forEach((n, i) => {
      if (n.session || !n.session_id) return;
      const was = old.find((o) => o.node_id === n.node_id && o.session_id === n.session_id && o.session);
      if (!was) return;
      nodes ??= [...r.node_statuses!];
      nodes[i] = { ...n, session: was.session };
    });
    if (!nodes) return r;
    changed = true;
    return { ...r, node_statuses: nodes };
  });
  return changed ? out : rows;
}

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

const VERDICT_WORDS: Record<string, string> = { PASS: "Passed", PASSED: "Passed", APPROVE: "Approved", APPROVED: "Approved", NEEDS_CHANGES: "Needs changes", REJECT: "Rejected", REJECTED: "Rejected", FAIL: "Failed", FAILED: "Failed" };

/** One string field of a JSON object's head, read even when the head was cut
 *  off mid-object (a step's preview is the first few hundred characters). */
function headField(text: string, key: string): { value: string; cut: boolean } | undefined {
  const m = text.match(new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)(")?`));
  if (!m) return undefined;
  const body = m[1].replace(/\\u?[0-9a-fA-F]{0,3}$/, "");
  let value: string;
  try { value = JSON.parse(`"${body}"`); } catch { value = body.replace(/\\(.)/g, "$1"); }
  return { value, cut: !m[2] };
}

/** A step's output in words, never as the object it printed. A station
 *  script's routing JSON reads as its `why`; an agent's structured result as
 *  its `summary`, a reviewer's as its verdict (with how many issues, when the
 *  whole object is at hand). JSON with none of those reads as nothing, so the
 *  step's own words stand. Any other output reads as it is. */
export function scriptLine(line: string | undefined): string | undefined {
  const text = line?.trim();
  if (!text?.startsWith("{")) return line;
  let obj: Record<string, unknown> | null = null;
  try { obj = JSON.parse(text.slice(0, text.lastIndexOf("}") + 1)); } catch {}
  const field = (key: string) => {
    if (!obj) return headField(text, key);
    const v = obj[key];
    return typeof v === "string" ? { value: v, cut: false } : undefined;
  };
  const prose = [field("why"), field("summary")].find((f) => f?.value.trim());
  const verdict = field("verdict")?.value.trim().toUpperCase();
  const issues = Array.isArray(obj?.issues) ? (obj!.issues as unknown[]).length : null;
  const head = verdict ? (VERDICT_WORDS[verdict] ?? verdict.charAt(0) + verdict.slice(1).toLowerCase().replace(/_/g, " ")) + (issues ? `: ${issues} ${issues === 1 ? "issue" : "issues"}` : "") : "";
  const words = prose ? prose.value.replace(/\s+/g, " ").trim() + (prose.cut ? "…" : "") : "";
  return [head, words].filter(Boolean).join(". ") || undefined;
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
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : `${n}`;
}
