import fs from "node:fs";
import path from "node:path";
import { parseWorkflowFile, parseWorkflowSource } from "./parser.js";
import { resolveWorkflowSource } from "./templates.js";
import type { WorkflowGraph } from "./types.js";
import { repoLineForRun } from "../repoLine.js";

// The graph `cast workflow run-daemon` executes for a run (the-line.md L9).
//
// A run backed by a pushed workflows row arrives with its nodes and runs as
// they are. A run the sweep started under a slug the host never pushed (the
// shipped "line", the default for every role) arrives with no nodes and only
// `run.workflow_name`; that name is resolved the way `cast workflow run
// <name>` resolves it: a file under the run's project path, else a shipped
// template. Null when neither the row nor the name yields a graph.
//
// The graph attribute stack (the-line.md L4: one decision stack per run)
// comes from the row when it carries one, else from the stored DOT source,
// so a daemon run creates the same stack a local run does.
//
// A run the server queued against a graph pushed from a file on this machine
// (a trial's rerun or dispatch: `fresh_branch`) reads that file again, so
// station edits made since the last push take effect, as they would for
// `cast workflow run <file>`. So does a resume of any run pushed from a file
// here (`resume`): a run that waited at a gate continues on the stations as
// they are now, when the file still has the station it stands at.
export function graphForDaemonRun(...args: Parameters<typeof daemonRunGraph>): WorkflowGraph | null {
  return daemonRunGraph(...args).graph;
}

type DaemonRun = { workflow_name?: string | null; goal_override?: string | null; project_path?: string | null; task_short_id?: string | null; fresh_branch?: boolean | null; current_node_id?: string | null };
type DaemonRow = { name?: string; slug?: string; goal?: string; model_stylesheet?: string; nodes?: any[]; edges?: any[]; stack?: string; source?: string; origin?: { device_id: string; root: string; file: string } | null } | null | undefined;

/** The graph a daemon run executes, with the graph file on this machine it was read from: null when the stations came from anywhere else. */
export function daemonRunGraph(
  run: DaemonRun,
  wf: DaemonRow,
  cwd: string = run.project_path || process.cwd(),
  deviceId?: string,
  resume = false,
): { graph: WorkflowGraph | null; file: string | null } {
  const origin = (run.fresh_branch || resume) && deviceId && wf?.origin?.device_id === deviceId ? path.join(wf.origin.root, wf.origin.file) : null;
  if (origin && fs.existsSync(origin)) {
    const graph = parseWorkflowFile(origin);
    if (run.goal_override) graph.goal = run.goal_override;
    if (run.fresh_branch || !run.current_node_id || graph.nodes.has(run.current_node_id)) return { graph, file: origin };
  }
  return { graph: graphElsewhere(run, wf, cwd), file: null };
}

function graphElsewhere(run: DaemonRun, wf: DaemonRow, cwd: string): WorkflowGraph | null {
  // A task-bound run of a line in a checkout with its own line runs that,
  // ahead of the role's pushed line and the shipped one (line-map.md LX5).
  const repo = repoLineForRun(run, wf, cwd);
  if (repo) {
    const graph = parseWorkflowSource(repo.source, repo.dir);
    if (run.goal_override) graph.goal = run.goal_override;
    return graph;
  }
  if (wf?.nodes?.length) {
    const nodes = new Map<string, any>();
    for (const n of wf.nodes) nodes.set(n.id, n);
    const stack = wf.stack ?? stackFromSource(wf.source);
    return {
      name: wf.name ?? "workflow",
      goal: run.goal_override || wf.goal,
      model_stylesheet: wf.model_stylesheet,
      ...(stack ? { stack } : {}),
      nodes,
      edges: wf.edges ?? [],
    };
  }
  if (!run.workflow_name) return null;
  const resolved = resolveWorkflowSource(run.workflow_name, cwd);
  if (!resolved) return null;
  const graph = parseWorkflowSource(resolved.source, resolved.dir);
  if (run.goal_override) graph.goal = run.goal_override;
  return graph;
}

/**
 * Publish the graph file a daemon run reads (daemonRunGraph's `file`), the
 * way `cast workflow run <file>` publishes before it starts, so the line's
 * published version is the stations its runs execute: a waiting decision is
 * then judged against the line as it runs now (line-versions.md LV1), and a
 * restarted runner leaves its decision current. A run that stands at a
 * station the file no longer has reads its stations elsewhere and publishes
 * nothing. The file's own goal goes out, never one run's. An unchanged graph
 * saves no version (workflows.recordGraphVersion).
 */
export async function publishDaemonGraph(file: string, wf: DaemonRow, deviceId: string, post: (route: string, body: Record<string, unknown>) => Promise<unknown>): Promise<void> {
  const graph = parseWorkflowFile(file);
  const { graphOrigin } = await import("../lineGraphEdit.js");
  const origin = graphOrigin(file, graph, deviceId);
  if (!origin) return;
  const { graphToPushPayload } = await import("./runner.js");
  const { nodes, edges, stack, serves } = graphToPushPayload(graph);
  await post("/cli/workflows/upsert", {
    name: wf?.name ?? graph.name,
    slug: wf?.slug ?? graph.name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
    goal: graph.goal,
    source: fs.readFileSync(file, "utf-8"),
    nodes, edges, stack,
    ...(serves ? { serves } : {}),
    model_stylesheet: graph.model_stylesheet,
    origin,
  });
}

function stackFromSource(source: string | undefined): string | undefined {
  if (!source) return undefined;
  try {
    return parseWorkflowSource(source).stack;
  } catch {
    return undefined;
  }
}
