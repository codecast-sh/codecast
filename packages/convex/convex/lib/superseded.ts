// The server's half of the superseded rule (docs/architecture/line-versions.md
// LV1-LV2): gather the facts a run, a problem or a decision already records
// and hand them to the shared predicates, so every query that lists or counts
// line work hides the same things the clients do.
import type { Doc, Id } from "../_generated/dataModel";
import {
  gateOutdated,
  problemFactsOf,
  supersededCard,
  supersededProblem,
  supersededRun,
  type StationHash,
  type Superseded,
} from "@codecast/shared/contracts/superseded";

type Ctx = { db: any };

/** A problem's standing from its task row; a merged problem names its survivor by short id. */
export async function problemSuperseded(ctx: Ctx, task: Doc<"tasks"> | null): Promise<Superseded> {
  if (!task) return null;
  const into: Doc<"tasks"> | null = task.cause?.merged_into ? await ctx.db.get(task.cause.merged_into) : null;
  return supersededProblem(problemFactsOf(task, into?.short_id ?? (task.cause?.merged_into ? String(task.cause.merged_into) : null)));
}

/** Where a run stands in its graph: the gate it waits at, else the station it is at. */
const standsAt = (run: Pick<Doc<"workflow_runs">, "gate_node_id" | "current_node_id">) => run.gate_node_id ?? run.current_node_id ?? null;

/** Whether the run stands at a station its line's graph (the workflows row, as last pushed) no longer has. False when the graph is unknown. */
export function stationGone(run: Pick<Doc<"workflow_runs">, "gate_node_id" | "current_node_id">, workflow: Pick<Doc<"workflows">, "nodes"> | null | undefined): boolean {
  const at = standsAt(run);
  const nodes = workflow?.nodes ?? [];
  return !!at && nodes.length > 0 && !nodes.some((n: { id: string }) => n.id === at);
}

/**
 * The version of the line that replaced the gate a waiting run stands at, or
 * null while it is current (line-versions.md LV1). The line's published graph
 * is the run's workflows row: its stations' hashes as last pushed (its newest
 * saved version, or the newest run's recorded hashes when that run is newer)
 * and which stations are a person's gates. The
 * run's own hashes are what it recorded (`graph_nodes`), else the version
 * published when it started. Returns "" when replaced but no version is named.
 */
export async function gateLineChange(ctx: Ctx, run: Doc<"workflow_runs">, workflow: Doc<"workflows"> | null, memo: LineMemo = newLineMemo()): Promise<string | null> {
  if (run.status !== "paused" || !run.gate_node_id || !workflow) return null;
  const { versions, nodes, gates } = await lineNow(ctx, workflow, memo);
  const startedOn = [...versions].reverse().find((v) => v.at <= run.created_at);
  const ran: StationHash[] | null = run.graph_nodes ?? startedOn?.nodes ?? null;
  if (!gateOutdated({ gate: run.gate_node_id, ran, current: { nodes, gates } })) return null;
  return versions.length ? `v${versions.length}` : "";
}

/** What one call has read already: each line's graph as published now, and each workflows row. A list of decisions
 *  asked by runs of the same few lines checks every one against the same graph; read per decision, a person's queue of
 *  a hundred line decisions read every saved version and twenty runs of the line a hundred times (96 MB a call). */
export type LineMemo = { lines: Map<string, Promise<LineNow>>; workflows: Map<string, Promise<Doc<"workflows"> | null>> };
type LineNow = { versions: Doc<"workflow_versions">[]; nodes: StationHash[]; gates: Record<string, { asker?: string }> };
export const newLineMemo = (): LineMemo => ({ lines: new Map(), workflows: new Map() });

function workflowOf(ctx: Ctx, id: Id<"workflows">, memo: LineMemo): Promise<Doc<"workflows"> | null> {
  const key = String(id);
  if (!memo.workflows.has(key)) memo.workflows.set(key, ctx.db.get(id));
  return memo.workflows.get(key)!;
}

/** The line's published graph: its stations' hashes as last pushed (its newest saved version, or the newest run's
 *  recorded hashes when that run is newer) and which stations are a person's gates, with its saved versions. */
function lineNow(ctx: Ctx, workflow: Doc<"workflows">, memo: LineMemo): Promise<LineNow> {
  const key = String(workflow._id);
  if (!memo.lines.has(key)) {
    memo.lines.set(key, (async () => {
      const versions: Doc<"workflow_versions">[] = await ctx.db.query("workflow_versions").withIndex("by_workflow_at", (q: any) => q.eq("workflow_id", workflow._id)).collect();
      const newest = versions[versions.length - 1];
      // A graph pushed with no file (the shipped line) has no saved versions: every run pushes it before it starts and
      // records its hashes, so the newest run that recorded them ran the line as it is now.
      const recent: Doc<"workflow_runs">[] = await ctx.db.query("workflow_runs").withIndex("by_workflow_id", (q: any) => q.eq("workflow_id", workflow._id)).order("desc").take(20);
      const newestRun = recent.find((r) => r.graph_nodes?.length);
      const nodes: StationHash[] = newestRun && (!newest || newestRun.created_at > newest.at) ? newestRun.graph_nodes! : workflow.origin?.nodes ?? newest?.nodes ?? [];
      const gates: Record<string, { asker?: string }> = {};
      for (const n of workflow.nodes) if (n.type === "human") gates[n.id] = n.asker ? { asker: n.asker } : {};
      return { versions, nodes, gates };
    })());
  }
  return memo.lines.get(key)!;
}

/**
 * A run's standing: a later run on its problem, a station its line dropped, or
 * its problem closed or superseded. Only a live run can be superseded.
 */
export async function runSuperseded(ctx: Ctx, run: Doc<"workflow_runs">, task?: Doc<"tasks"> | null, memo: LineMemo = newLineMemo()): Promise<Superseded> {
  if (run.status !== "pending" && run.status !== "running" && run.status !== "paused") return null;
  const problem = task !== undefined ? task : run.task_id ? await ctx.db.get(run.task_id) : null;
  let newer: string | null = null;
  if (run.task_id) {
    // The problem's newest run, not every run it ever had: a run is superseded only by a later one.
    const latest: Doc<"workflow_runs"> | null = await ctx.db.query("workflow_runs").withIndex("by_task", (q: any) => q.eq("task_id", run.task_id)).order("desc").first();
    newer = latest && latest._id !== run._id && latest.created_at > run.created_at ? String(latest._id) : null;
  }
  const workflow: Doc<"workflows"> | null = run.workflow_id ? await workflowOf(ctx, run.workflow_id, memo) : null;
  return supersededRun({
    status: run.status,
    newer_run: newer,
    station_gone: stationGone(run, workflow),
    line_changed: await gateLineChange(ctx, run, workflow, memo),
    problem_status: problem?.status ?? null,
    problem: await problemSuperseded(ctx, problem),
  });
}

/**
 * A pending decision a run's gate asks: superseded with its run or its
 * problem, or once the run has left that gate. A decision bound to no run is
 * current here (its own rules decide it).
 */
export async function decisionSuperseded(ctx: Ctx, d: Pick<Doc<"session_decisions">, "status" | "workflow_run_id" | "gate_node_id" | "task_id">, memo: LineMemo = newLineMemo()): Promise<Superseded> {
  if (d.status !== "pending" || !d.workflow_run_id) return null;
  const run: Doc<"workflow_runs"> | null = await ctx.db.get(d.workflow_run_id as Id<"workflow_runs">);
  if (!run) return null;
  const task: Doc<"tasks"> | null = (d.task_id ?? run.task_id) ? await ctx.db.get((d.task_id ?? run.task_id) as Id<"tasks">) : null;
  return supersededCard({
    waiting: true,
    run: await runSuperseded(ctx, run, task, memo),
    run_at_gate: run.status === "paused" && (!d.gate_node_id || run.gate_node_id === d.gate_node_id),
    problem: await problemSuperseded(ctx, task),
    live_findings: task?.cause?.signal_count ?? 0,
  });
}

/** The rows that still stand: every read that lists or counts decisions filters through this, never `get` (a superseded decision's own page opens). */
export async function currentDecisions<T extends Pick<Doc<"session_decisions">, "status" | "workflow_run_id" | "gate_node_id" | "task_id">>(ctx: Ctx, rows: T[]): Promise<T[]> {
  const out: T[] = [];
  const memo = newLineMemo();
  for (const r of rows) if (!(await decisionSuperseded(ctx, r, memo))) out.push(r);
  return out;
}
