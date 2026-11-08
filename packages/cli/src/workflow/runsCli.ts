// `cast workflow runs | show | cancel`: reading a run and stopping one.
//
// The list asks the server for slim rows (no station sessions): each session
// carries its station's report and handoff, and a page of them outgrew the
// call's time limit and printed megabytes of JSON. A backend from before
// `slim` rejects the field, so the list asks again without it and slims the
// rows here, and the output is the same either way.

import { apiPost, isOlderBackendRefusal, type PublishDeps } from "../castApi.js";
import { c, fmt } from "../colors.js";
import { formatAge } from "../decideCommand.js";

export interface RunNode {
  node_id: string;
  status: string;
  outcome?: string;
  session_id?: string;
  started_at?: number;
  completed_at?: number;
  label?: string;
  visits?: number;
  cost_usd?: number;
  session?: unknown;
}

export interface RunListRow {
  _id: string;
  status: string;
  fail_reason?: string;
  runner_device?: string;
  current_node_id?: string;
  current_node_label?: string;
  task_short_id?: string;
  plan_short_id?: string;
  workflow_name?: string;
  workflow_label?: string;
  gate_decision_short_id?: string;
  gate_decision_status?: string;
  gate_answer?: string;
  node_statuses?: RunNode[];
  created_at: number;
  updated_at: number;
  [key: string]: unknown;
}

/** A row without what only the web draws: station sessions and per-station graph hashes. */
export function slimRun<T extends Record<string, any>>(run: T): T {
  const { graph_nodes: _g, ...rest } = run as any;
  return {
    ...rest,
    ...(Array.isArray(run.node_statuses) ? { node_statuses: run.node_statuses.map(({ session: _s, ...node }: any) => node) } : {}),
  } as T;
}

const BY_TASK_ONLY = "this backend finds another person's run by its task or plan only";

/** The run rows a filter names, slim unless `sessions`. */
export async function fetchRuns(deps: PublishDeps, filter: Record<string, unknown>, opts: { sessions?: boolean } = {}): Promise<RunListRow[]> {
  const ask = async (body: Record<string, unknown>) => apiPost(deps, "/cli/workflow-runs/list", body, { read: true, exitOnError: false });
  let result: any;
  try {
    result = await ask(opts.sessions ? filter : { ...filter, slim: true });
  } catch (err) {
    if (opts.sessions || !isOlderBackendRefusal(err)) throw err;
    if (filter.run_id) throw new Error(`${BY_TASK_ONLY}: pass the ct-N (or pl-N) the run is bound to`);
    result = await ask(filter);
  }
  const runs: RunListRow[] = Array.isArray(result?.runs) ? result.runs : [];
  return opts.sessions ? runs : runs.map(slimRun);
}

/** The newest run a ref names: a task (ct-N), a plan (pl-N), or a run id. */
export async function runByRef(deps: PublishDeps, ref: string, opts: { sessions?: boolean } = {}): Promise<RunListRow | null> {
  const filter = /^ct-\d+$/i.test(ref) ? { task_id: ref } : /^pl-\d+$/i.test(ref) ? { plan_id: ref } : { run_id: ref };
  try {
    const [row] = await fetchRuns(deps, { ...filter, limit: 1 }, opts);
    return row ?? null;
  } catch (err) {
    if (!("run_id" in filter) || !(err instanceof Error) || !err.message.startsWith(BY_TASK_ONLY)) throw err;
    // A backend that lists by task or plan only still hands its owner a run by id.
    const got = await apiPost(deps, "/cli/workflow-runs/get", { run_id: ref }, { read: true, exitOnError: false }).catch(() => null);
    if (!got?.run) throw err;
    return opts.sessions ? got.run : slimRun(got.run);
  }
}

function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  return m < 90 ? `${m}m` : `${(m / 60).toFixed(1)}h`;
}

const STATUS_MARK: Record<string, string> = { completed: "✓", failed: "✗", running: "▸", pending: "·" };

/** `cast workflow show`: the run, then each station it reached in order, with its session, time and outcome. */
export function formatRunDetail(run: RunListRow, labels: Map<string, string> = new Map(), now: number = Date.now()): string {
  const flow = run.workflow_label ?? run.workflow_name ?? "workflow";
  const bound = run.task_short_id ?? run.plan_short_id;
  const lines = [`${c.bold}${flow}${c.reset}${bound ? ` ${bound}` : ""}  ${run.status}  ${fmt.muted(run._id)}`];
  const facts = [
    `started ${formatAge(now - run.created_at)}`,
    `updated ${formatAge(now - run.updated_at)}`,
    run.runner_device ? `machine ${run.runner_device.slice(0, 12)}` : null,
  ].filter(Boolean);
  lines.push(`  ${fmt.muted(facts.join(", "))}`);
  if (run.fail_reason) lines.push(`  ${c.red}failed:${c.reset} ${run.fail_reason}`);
  if (run.gate_decision_short_id) {
    lines.push(`  gate ${run.gate_decision_short_id} ${run.gate_decision_status ?? ""}${run.gate_answer ? `: ${run.gate_answer}` : ""}`.trimEnd());
  }
  const nodes = run.node_statuses ?? [];
  if (!nodes.length) {
    lines.push(fmt.muted("  no station has started"));
    return lines.join("\n");
  }
  const name = (n: RunNode) => {
    const label = n.label ?? labels.get(n.node_id);
    return label && label !== n.node_id ? `${n.node_id} (${label})` : n.node_id;
  };
  const width = Math.max(...nodes.map((n) => name(n).length));
  for (const n of nodes) {
    const took = n.started_at !== undefined ? duration((n.completed_at ?? now) - n.started_at) : null;
    const bits = [
      n.status,
      took ? (n.completed_at ? took : `${took} so far`) : null,
      n.outcome ? `outcome ${n.outcome}` : null,
      n.visits && n.visits > 1 ? `${n.visits} visits` : null,
      n.session_id ? `session ${n.session_id}` : null,
    ].filter(Boolean);
    const mark = STATUS_MARK[n.status] ?? " ";
    const here = n.node_id === run.current_node_id && run.status !== "completed" ? " <" : "";
    lines.push(`  ${mark} ${name(n).padEnd(width)}  ${bits.join(", ")}${here}`);
  }
  return lines.join("\n");
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

/** `cast workflow show <run>`. */
export async function showRun(deps: PublishDeps, ref: string, options: { sessions?: boolean; json?: boolean }): Promise<void> {
  const run = await runByRef(deps, ref, { sessions: options.sessions }).catch((e: Error) => fail(e.message));
  if (!run) fail(`${ref} has no run`);
  if (options.json) {
    console.log(JSON.stringify(run, null, 2));
    return;
  }
  // Station labels live on the graph the run executes; only its owner reads that, and the ids stand alone without it.
  const got = await apiPost(deps, "/cli/workflow-runs/get", { run_id: run._id }, { read: true, exitOnError: false }).catch(() => null);
  const labels = new Map<string, string>((got?.workflow?.nodes ?? []).map((n: { id: string; label?: string }) => [n.id, n.label ?? n.id]));
  console.log(formatRunDetail(run, labels));
  if (run.status === "failed") console.log(fmt.muted(`\n  try it again: cast workflow resume ${run.task_short_id ?? "<ct-N>"} --at <station>`));
  else if (run.status === "running" || run.status === "paused" || run.status === "pending") console.log(fmt.muted(`\n  stop it: cast workflow cancel ${ref}`));
}

/** `cast workflow cancel <run>`. */
export async function cancelRun(deps: PublishDeps, ref: string, options: { json?: boolean }): Promise<void> {
  const run = await runByRef(deps, ref).catch((e: Error) => fail(e.message));
  if (!run) fail(`${ref} has no run`);
  if (run.status === "completed" || run.status === "failed") fail(`${ref}'s run already ended (${run.status}); nothing to cancel`);
  const result = await apiPost(deps, "/cli/workflow-runs/cancel", { run_id: run._id }, { exitOnError: false }).catch((e: Error) =>
    fail(/no \/cli\/workflow-runs\/cancel route/.test(e.message) ? `${e.message} Stop it from the run's page on the web meanwhile.` : e.message),
  );
  // A runner on this machine stops now rather than at its next report.
  const { stopRunner } = await import("./reask.js");
  await stopRunner(run._id, ref).catch(() => {});
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`${c.green}ok${c.reset} cancelled ${ref}'s run ${fmt.muted(`(${run._id}, was ${run.status} at ${run.current_node_label ?? run.current_node_id ?? "its start"})`)}`);
}
