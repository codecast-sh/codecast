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
  /** How many times the run entered the station; its times are the last visit's. */
  visits?: number;
  /** A segment's way out the run took and went on from (a card answered Revise): the route, not a failure. Its
   *  status reads completed; the runner writes such an exit failed so the composing flow can route on it. */
  route?: true;
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
 * The order the run reached its nodes in, then the nodes it has not reached in
 * graph order when the run has a stored workflow (else the order the statuses
 * were written in). A node the run is at counts as running until a status
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
      ...(ns?.visits ? { visits: ns.visits } : {}),
    });
  };
  for (const n of graph) push(n.id, n.label, n.type);
  // A status of a node the graph lists out of the steps (its start, its ends) reads by the graph's name and kind: the
  // end the run reached is a step (the change flow's Deploy failed, the personal Ship's Landed), its start is not, and
  // neither is the plain `exit` a finished run reaches (the change flow's names it Live, as its last step already says).
  const known = new Map<string, any>((workflow?.nodes ?? []).map((n: any) => [n.id, n]));
  for (const ns of statuses) {
    const n = known.get(ns.node_id);
    if (n?.type !== "start" && !(n?.type === "exit" && ns.node_id === "exit")) push(ns.node_id, ns.label ?? n?.label ?? nodeWords(ns.node_id), n?.type);
  }
  return inRunOrder(asRoutes(oneSegmentRow(rows), statuses, known), statuses);
}

/** A step whose only output names the segment exit it took (`{"exit": "revise"}`). */
const ROUTE_ONLY = /^\s*\{\s*"exit"\s*:/;

/**
 * A segment's stop exit the run went on from is the way it went (a card answered Revise sends the change back to its
 * session), never a failure: the runner writes it failed only so the flow that composes the segment routes on it
 * (cli workflow/parser.ts, `segment_exit: "stop"`). Read as one when the graph marks it or its only output names the
 * exit, and only when a step started after it, so a stop the run ended on stays red.
 */
function asRoutes(rows: RunNodeRow[], statuses: ReadonlyArray<{ node_id: string; started_at?: number }>, graph: ReadonlyMap<string, any>): RunNodeRow[] {
  return rows.map((r) => {
    if (r.status !== "failed") return r;
    const n = graph.get(r.id);
    const exit = n?.segment_exit === "stop" || (r.id.includes("__") && ROUTE_ONLY.test(r.result_preview ?? ""));
    const since = r.completed_at ?? r.started_at;
    const wentOn = since != null && statuses.some((x) => x.node_id !== r.id && (x.started_at ?? 0) >= since);
    return exit && wentOn ? { ...r, status: "completed" as const, route: true as const } : r;
  });
}

/** A segment's own row (`decide`) beside an inner step of the same name (`decide__decide`) says one thing twice: the
 *  inner step, which holds the time and the answer, stands for both. */
function oneSegmentRow(rows: RunNodeRow[]): RunNodeRow[] {
  const twice = new Set(rows.filter((r) => rows.some((x) => x.id.startsWith(`${r.id}__`) && x.label === r.label && rowReached(x) === rowReached(r))).map((r) => r.id));
  return twice.size ? rows.filter((r) => !twice.has(r.id)) : rows;
}

/** A node id as words, for a status no graph names: `deploy__failed` reads "Deploy failed". Never shown as the id. */
export const nodeWords = (id: string) => { const w = id.replace(/_+/g, " ").trim(); return w ? `${w[0].toUpperCase()}${w.slice(1)}` : id; };

/** A row the run reached: it has a status of its own, or the run is at it. */
export const rowReached = (r: RunNodeRow) => r.status !== "pending" || r.current || r.started_at != null;

/**
 * The stations the run reached in the order it first reached them, then the ones it has not reached, in the graph's
 * order. The server adds a station's status when the run first enters it and rewrites it in place on every later visit
 * (convex workflow_runs.ts updateProgress), so the statuses' order is first entry; each one's start is only its last visit, and
 * a fix round would read before the pull request it fixed. A row with no status (the station the run is at) comes
 * last. The graph lists side routes (a retest, a branch that moved) beside the main path, so its order would
 * interleave stations that never ran with ones that did.
 */
function inRunOrder(rows: RunNodeRow[], statuses: ReadonlyArray<{ node_id: string }>): RunNodeRow[] {
  const first = new Map<string, number>();
  statuses.forEach((s, i) => { if (!first.has(s.node_id)) first.set(s.node_id, i); });
  const reached = rows.filter(rowReached).map((r, i) => ({ r, i, at: first.get(r.id) ?? Infinity }));
  reached.sort((a, b) => a.at - b.at || a.i - b.i);
  return [...reached.map((x) => x.r), ...rows.filter((r) => !rowReached(r))];
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

/** Each character's nesting depth in a JSON text, read even when it was cut off: 1 inside the outer object, 2 inside
 *  an object or list it holds. */
export function jsonDepths(t: string): Uint16Array {
  const d = new Uint16Array(t.length);
  let depth = 0, str = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    d[i] = depth;
    if (str) { if (c === "\\") { i++; if (i < t.length) d[i] = depth; } else if (c === '"') str = false; }
    else if (c === '"') str = true;
    else if (c === "{" || c === "[") d[i] = ++depth;
    else if (c === "}" || c === "]") depth--;
  }
  return d;
}

/** The first string field named `key` (a regex source) in a JSON object's
 *  head, read even when the head was cut off mid-object (a step's preview is
 *  the first few hundred characters). `top` reads only the object's own
 *  fields: a nested object's "why" is not the result's why. */
function headField(text: string, key: string, top = false, depths?: () => Uint16Array): { value: string; cut: boolean } | undefined {
  const at = top ? depths?.() ?? jsonDepths(text) : null;
  const m = [...text.matchAll(new RegExp(`"(?:${key})"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)(")?`, "g"))].find((x) => !at || at[x.index!] === 1);
  if (!m) return undefined;
  const body = m[1].replace(/\\u?[0-9a-fA-F]{0,3}$/, "");
  let value: string;
  try { value = JSON.parse(`"${body}"`); } catch { value = body.replace(/\\(.)/g, "$1"); }
  return { value, cut: !m[2] };
}

/** The keys schemas use for a step's result in words. */
const PROSE_KEYS = ["why", "summary", "notes"];
/** A reviewer's list of findings, and the key a finding says itself in. */
const FINDING_LISTS = ["findings", "issues"];
const FINDING_KEYS = "issue|problem|description|message";

/** A step's output in words, never as the object it printed. A station
 *  script's routing JSON reads as its `why`; an agent's structured result as
 *  its `summary` or `notes`; a reviewer's as its verdict (with how many
 *  findings, when the whole object is at hand) and what the first finding
 *  says. Failing those, a whole object's first top-level sentence; JSON with
 *  no prose reads as nothing, so the step's own words stand. Any other
 *  output reads as it is. */
export function scriptLine(line: string | undefined): string | undefined {
  const text = line?.trim();
  if (!text?.startsWith("{")) return line;
  let obj: Record<string, unknown> | null = null;
  try { obj = JSON.parse(text.slice(0, text.lastIndexOf("}") + 1)); } catch {}
  // A whole object is read by its own top-level keys, so a finding's words
  // never stand in for the result's summary; a cut head by the first match.
  // One depth map per output, read lazily: each key looked up in a cut head reads the same one.
  let depths: Uint16Array | undefined;
  const depthsOf = () => (depths ??= jsonDepths(text));
  const field = (key: string) => {
    if (!obj) return headField(text, key, true, depthsOf);
    const v = obj[key];
    return typeof v === "string" ? { value: v, cut: false } : undefined;
  };
  const listKey = obj ? FINDING_LISTS.find((k) => Array.isArray(obj![k])) : undefined;
  const list = listKey ? obj![listKey] as unknown[] : undefined;
  const firstFinding = list
    ? (list[0] && typeof list[0] === "object" ? headField(JSON.stringify(list[0]), FINDING_KEYS) : undefined)
    : obj ? undefined : headField(text, FINDING_KEYS);
  const anySentence = () => {
    const v = obj && Object.values(obj).find((x) => typeof x === "string" && /\s/.test(x.trim()));
    return typeof v === "string" ? { value: v, cut: false } : undefined;
  };
  const verdict = field("verdict")?.value.trim().toUpperCase();
  const prose = [...PROSE_KEYS.map(field), firstFinding].find((f) => f?.value.trim()) ?? (verdict ? undefined : anySentence());
  const count = list?.length ? `: ${list.length} ${list.length === 1 ? listKey!.replace(/s$/, "") : listKey}` : "";
  const head = verdict ? (VERDICT_WORDS[verdict] ?? verdict.charAt(0) + verdict.slice(1).toLowerCase().replace(/_/g, " ")) + count : "";
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
