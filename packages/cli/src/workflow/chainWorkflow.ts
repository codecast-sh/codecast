// A chain is a run (the-line.md L7).
//
// `cast exec --chain` and `cast agent run` execute a chain (agent-definitions.md
// D5) locally: each step's captured output feeds the next step's template.
// Nothing about that execution changes here. What this module adds is the
// record: the chain compiles to a linear workflow graph shaped exactly like
// the DOT parser's output, the graph is upserted so the web can draw it, a
// `workflow_runs` row is created with `createFromCli`, and every step reports
// through `updateProgress`. A chain run then shows on /routines, on the task
// page and in the scope feed like any other run.
//
// `cast exec -j N` records one run too: a `component` fanout, one box node per
// input, a `tripleoctagon` fanin.
//
// Recording never blocks the work. When the backend cannot be reached the
// chain still runs and one line on stderr says the run was not recorded.

import type { AgentChainSpec, AgentDefinitionSpec } from "@codecast/shared/contracts";
import { apiPost, type PublishDeps } from "../castApi.js";
import type { WorkflowEdge, WorkflowGraph, WorkflowNode } from "./types.js";

/** `updateProgress` stores the head of each step's output on the node. */
export const RESULT_PREVIEW_CHARS = 800;

export function resultPreview(output: string): string | undefined {
  const text = output.trim();
  return text ? text.slice(0, RESULT_PREVIEW_CHARS) : undefined;
}

export function workflowSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

function startNode(): WorkflowNode {
  return { id: "start", label: "Start", shape: "Mdiamond", type: "start" };
}

function exitNode(): WorkflowNode {
  return { id: "exit", label: "Done", shape: "Msquare", type: "exit" };
}

function graphOf(name: string, goal: string | undefined, nodes: WorkflowNode[], edges: WorkflowEdge[]): WorkflowGraph {
  return { name, goal, nodes: new Map(nodes.map((n) => [n.id, n])), edges };
}

/**
 * L7: one `box` node per step (`step-<n>`), labelled with the definition
 * name, carrying the step's prompt template and `definition=` the step's
 * agent. Edges run start -> step-1 -> ... -> step-N -> exit.
 */
export function compileChainWorkflow(chain: AgentChainSpec, definitions: Record<string, AgentDefinitionSpec>): WorkflowGraph {
  const steps: WorkflowNode[] = chain.steps.map((step, i) => {
    const def = definitions[step.agent];
    return {
      id: `step-${i + 1}`,
      label: def?.name ?? step.agent,
      shape: "box",
      type: "agent",
      prompt: step.prompt,
      definition: step.agent,
      ...(def?.agent ? { agent: def.agent } : {}),
      ...(def?.model ? { model: def.model } : {}),
      ...(def?.effort ? { reasoning_effort: def.effort } : {}),
      ...(def?.isolated ? { isolated: true } : {}),
    };
  });
  const nodes = [startNode(), ...steps, exitNode()];
  const edges: WorkflowEdge[] = [];
  for (let i = 0; i + 1 < nodes.length; i++) edges.push({ from: nodes[i].id, to: nodes[i + 1].id });
  return graphOf(`chain-${chain.name}`, chain.description || undefined, nodes, edges);
}

/**
 * L7: `cast exec -j N` as one run. A `component` fanout, one box node per
 * input (`input-<n>`, prompt = the input, first line as the label), a
 * `tripleoctagon` fanin, then exit.
 */
export function compileParallelWorkflow(prompts: string[], definition?: AgentDefinitionSpec): WorkflowGraph {
  const inputs: WorkflowNode[] = prompts.map((prompt, i) => ({
    id: `input-${i + 1}`,
    label: prompt.split("\n")[0].slice(0, 80) || `input ${i + 1}`,
    shape: "box",
    type: "agent",
    prompt,
    ...(definition ? { definition: definition.name } : {}),
    ...(definition?.agent ? { agent: definition.agent } : {}),
  }));
  const fanout: WorkflowNode = { id: "fanout", label: `${prompts.length} inputs`, shape: "component", type: "parallel_fanout" };
  const fanin: WorkflowNode = { id: "fanin", label: "Collect", shape: "tripleoctagon", type: "parallel_fanin" };
  const nodes = [startNode(), fanout, ...inputs, fanin, exitNode()];
  const edges: WorkflowEdge[] = [{ from: "start", to: "fanout" }];
  for (const n of inputs) edges.push({ from: "fanout", to: n.id }, { from: n.id, to: "fanin" });
  edges.push({ from: "fanin", to: "exit" });
  const name = definition ? `exec-parallel-${definition.name}` : "exec-parallel";
  return graphOf(name, undefined, nodes, edges);
}

/** The DOT text stored as the workflow's `source`, so the web can show it. */
export function renderDotSource(graph: WorkflowGraph): string {
  const q = (s: string) => JSON.stringify(s);
  const lines = [`digraph ${JSON.stringify(graph.name)} {`];
  if (graph.goal) lines.push(`  graph [goal=${q(graph.goal)}]`);
  for (const n of graph.nodes.values()) {
    const attrs = [`label=${q(n.label)}`, `shape=${n.shape}`];
    if (n.definition) attrs.push(`definition=${q(n.definition)}`);
    if (n.prompt) attrs.push(`prompt=${q(n.prompt)}`);
    lines.push(`  ${q(n.id)} [${attrs.join(", ")}]`);
  }
  for (const e of graph.edges) lines.push(`  ${q(e.from)} -> ${q(e.to)}`);
  lines.push("}");
  return lines.join("\n");
}

/**
 * The `/cli/workflows/upsert` body: the same shape `cast workflow run` pushes
 * (index.ts, "Push workflow to Convex so the web UI can render it"), with the
 * L8 node attributes (`definition`, `reviewer`, `timeout`, `temperature`).
 */
export function workflowUpsertPayload(graph: WorkflowGraph, source?: string): Record<string, unknown> {
  const nodes = [...graph.nodes.values()].map((n) => ({
    id: n.id, label: n.label, shape: n.shape, type: n.type,
    ...(n.prompt ? { prompt: n.prompt } : {}),
    ...(n.script ? { script: n.script } : {}),
    ...(n.model ? { model: n.model } : {}),
    ...(n.backend ? { backend: n.backend } : {}),
    ...(n.agent ? { agent: n.agent } : {}),
    ...(n.isolated !== undefined ? { isolated: n.isolated } : {}),
    ...(n.reasoning_effort ? { reasoning_effort: n.reasoning_effort } : {}),
    ...(n.max_visits !== undefined ? { max_visits: n.max_visits } : {}),
    ...(n.max_retries !== undefined ? { max_retries: n.max_retries } : {}),
    ...(n.retry_target ? { retry_target: n.retry_target } : {}),
    ...(n.goal_gate !== undefined ? { goal_gate: n.goal_gate } : {}),
    ...(n.definition ? { definition: n.definition } : {}),
    ...(n.reviewer !== undefined ? { reviewer: n.reviewer } : {}),
    ...(n.timeout !== undefined ? { timeout: n.timeout } : {}),
    ...(n.temperature !== undefined ? { temperature: n.temperature } : {}),
  }));
  const edges = graph.edges.map((e) => ({
    from: e.from, to: e.to,
    ...(e.label ? { label: e.label } : {}),
    ...(e.condition ? { condition: e.condition } : {}),
  }));
  return {
    name: graph.name,
    slug: workflowSlug(graph.name),
    goal: graph.goal,
    source: source ?? renderDotSource(graph),
    nodes,
    edges,
    model_stylesheet: graph.model_stylesheet,
  };
}

export interface RecordedRunOptions {
  taskId?: string;
  planId?: string;
  projectPath: string;
  /** One stderr line when recording fails; undefined = silent. */
  note?: (line: string) => void;
}

export type NodeStatus = "running" | "completed" | "failed";
export type RunStatus = "completed" | "failed";

export interface RecordedRun {
  /** The run id once created; undefined when recording failed. */
  runId: string | undefined;
  /** Report one node. Failures are swallowed and noted once. */
  node(nodeId: string, status: NodeStatus, extra?: { outcome?: string; result_preview?: string; fail_reason?: string }): Promise<void>;
  /** The run's terminal status, posted the way the runner posts it. */
  finish(nodeId: string, status: RunStatus, failReason?: string): Promise<void>;
}

/**
 * The reporter for a run that cannot be recorded (no sign in): every call is
 * a no-op and one note says why. `cast exec -j` needs no auth to run, so it
 * keeps running and only the record is skipped.
 */
export function unrecordedRun(reason: string, note?: (line: string) => void): RecordedRun {
  note?.(`cast exec: run not recorded (${reason})`);
  return { runId: undefined, node: async () => {}, finish: async () => {} };
}

/**
 * Upsert the graph, create the run bound to the task or plan, and hand back a
 * reporter. Every call swallows transport failures so the chain still runs
 * when the backend is unreachable; the first failure prints one note.
 */
export async function startRecordedRun(deps: PublishDeps, graph: WorkflowGraph, opts: RecordedRunOptions): Promise<RecordedRun> {
  let noted = false;
  const noteOnce = (reason: string) => {
    if (noted) return;
    noted = true;
    opts.note?.(`cast exec: run not recorded (${reason})`);
  };
  const post = async (urlPath: string, body: Record<string, unknown>): Promise<any> => {
    try {
      return await apiPost(deps, urlPath, body, { exitOnError: false });
    } catch (err) {
      noteOnce(err instanceof Error ? err.message : String(err));
      return undefined;
    }
  };

  let runId: string | undefined;
  const pushed = await post("/cli/workflows/upsert", workflowUpsertPayload(graph));
  if (pushed) {
    const created = await post("/cli/workflow-runs/create", {
      workflow_name: graph.name,
      workflow_goal: graph.goal,
      workflow_id: pushed.id,
      task_id: opts.taskId,
      plan_id: opts.planId,
      project_path: opts.projectPath,
      // L7: spawner = the current session, so the run sits under it and its role.
      spawner_session: deps.detectCurrentSessionId() ?? undefined,
    });
    runId = created?.run_id;
    if (created && !runId) noteOnce("no run id returned");
  }

  const progress = async (payload: Record<string, unknown>) => {
    if (!runId) return;
    await post("/cli/workflow-runs/progress", { run_id: runId, ...payload });
  };

  // L7: the run is created pending; flip it to running at the start node the
  // way the runner does, so the scope feed shows it as live from the first step.
  const startId = [...graph.nodes.values()].find((n) => n.type === "start")?.id ?? "start";
  await progress({ current_node_id: startId, node_id: startId, node_status: "running", run_status: "running" });

  return {
    runId,
    node: (nodeId, status, extra = {}) =>
      progress({ current_node_id: nodeId, node_id: nodeId, node_status: status, ...extra }),
    finish: (nodeId, status, failReason) =>
      progress({
        current_node_id: nodeId,
        node_id: nodeId,
        node_status: status,
        run_status: status,
        ...(failReason ? { fail_reason: failReason } : {}),
      }),
  };
}
