// Pure rules the scope page's Line tab paints from (docs/architecture/
// the-line.md L3, L5, L10): the team's statuses are the stations, a task
// sits in the column of its status, a pending blocking decision bound to the
// task at that station holds it there, and the task's run names the node a
// hand is working. Kept out of the component so it tests without React.
import type { WorkState } from "@codecast/shared/contracts";
import type { TeamTaskStatus } from "@codecast/shared/tasks";
import { boardOrderedStatuses, taskStatusKey } from "../../../lib/taskStatuses";

export type LineTaskLike = {
  _id: string;
  status?: string | null;
  status_id?: string | null;
  workflow_run_id?: string;
  updated_at?: number;
  files_changed?: string[];
};

export type LineDecisionLike = {
  _id: string;
  short_id?: string;
  status: string;
  blocking?: boolean;
  task_id?: string;
  station?: string;
};

export type LineRunLike = {
  _id: string;
  task_id?: string;
  status: string;
  current_node_id?: string;
  current_node_label?: string;
  updated_at?: number;
  created_at?: number;
};

export type LineColumn<T extends LineTaskLike> = { status: TeamTaskStatus; tasks: T[] };

/** One column per station in pipeline order (backlog to dropped, the team's
 *  own order inside a category); a task lands in the column of the status it
 *  resolves to, newest change first. Every station is present, empty or not,
 *  so the board reads the same shape for every scope. */
export function lineColumns<T extends LineTaskLike>(tasks: T[], statuses: TeamTaskStatus[]): LineColumn<T>[] {
  const ordered = boardOrderedStatuses(statuses);
  const byKey = new Map<string, T[]>(ordered.map((s) => [s.id, []]));
  for (const t of tasks) {
    const key = taskStatusKey(t, ordered);
    const bucket = byKey.get(key);
    if (bucket) bucket.push(t);
    else byKey.get(ordered[0]?.id ?? "")?.push(t);
  }
  return ordered.map((status) => ({
    status,
    tasks: (byKey.get(status.id) ?? []).slice().sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0)),
  }));
}

/** L5: the pending blocking decision bound to the task at its current
 *  station, or null. The station is the task's status as the ask recorded
 *  it; a team status id matches too, so a custom status holds as well. */
export function heldAt<D extends LineDecisionLike>(task: LineTaskLike, decisions: D[]): D | null {
  const stations = new Set([task.status, task.status_id].filter((x): x is string => !!x));
  for (const d of decisions) {
    if (d.status !== "pending" || !d.blocking || d.task_id !== task._id) continue;
    if (d.station && stations.has(d.station)) return d;
  }
  return null;
}

/** The task's run: the one its row names, else its newest run by task id. */
export function runForTask<R extends LineRunLike>(task: LineTaskLike, runs: R[]): R | null {
  if (task.workflow_run_id) {
    const named = runs.find((r) => r._id === task.workflow_run_id);
    if (named) return named;
  }
  let best: R | null = null;
  for (const r of runs) {
    if (r.task_id !== task._id) continue;
    const at = r.updated_at ?? r.created_at ?? 0;
    if (!best || at > (best.updated_at ?? best.created_at ?? 0)) best = r;
  }
  return best;
}

/** The live node a run is on, as the card prints it: its label, else its id;
 *  nothing for a run that has finished. */
export function liveNodeOf(run: LineRunLike | null): string | null {
  if (!run) return null;
  if (run.status === "completed" || run.status === "failed") return null;
  return run.current_node_label || run.current_node_id || null;
}

/** A session's verdict (store classifySession) folded back to the one work
 *  state the org surfaces colour by. */
export function workStateOfVerdict(v: { idle: boolean; waiting: boolean; rest: WorkState } | null | undefined): WorkState | null {
  if (!v) return null;
  if (!v.idle) return "working";
  return v.waiting ? v.rest : "idle";
}

/** Evidence the card can count without a query: pages attached to the task
 *  in the artifacts store and the files its handoff named. */
export function evidenceCount(task: LineTaskLike, artifacts: Array<{ task_id?: string }>): { pages: number; files: number } {
  let pages = 0;
  for (const a of artifacts) if (a.task_id === task._id) pages++;
  return { pages, files: task.files_changed?.length ?? 0 };
}

// ---------------------------------------------------------------- the line picker (L2)

/** The workflow templates the CLI ships (packages/cli/src/workflow/templates.ts).
 *  The web has no copy of the sources; it needs only the names a role's line
 *  may resolve to when the host has pushed no workflow of that slug. */
export const SHIPPED_LINE_TEMPLATES: ReadonlyArray<{ slug: string; name: string }> = [
  { slug: "line", name: "line" },
  { slug: "feature", name: "feature" },
  { slug: "plan-autopilot", name: "plan-autopilot" },
];

export type LineOption = { slug: string; label: string; shipped: boolean };

/** The picker's rows: the shipped templates, then the caller's own workflows
 *  by slug (an own workflow with a shipped slug wins, since the sweep runs the
 *  pushed row first, L9). A current slug nothing lists stays selectable so
 *  the picker never shows a value it cannot name. */
export function lineOptions(workflows: Array<{ slug: string; name?: string }>, current: string): LineOption[] {
  const own = new Map<string, string>();
  for (const w of workflows) if (w.slug && !own.has(w.slug)) own.set(w.slug, w.name || w.slug);
  const out: LineOption[] = [];
  for (const t of SHIPPED_LINE_TEMPLATES) {
    const mine = own.get(t.slug);
    out.push({ slug: t.slug, label: mine ? `${mine} (yours)` : `${t.name} (shipped)`, shipped: !mine });
    own.delete(t.slug);
  }
  for (const [slug, name] of own) out.push({ slug, label: name === slug ? slug : `${name} (${slug})`, shipped: false });
  if (current && !out.some((o) => o.slug === current)) out.push({ slug: current, label: `${current} (not pushed)`, shipped: false });
  return out;
}
