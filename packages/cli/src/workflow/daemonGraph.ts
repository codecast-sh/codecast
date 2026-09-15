import { parseWorkflowSource } from "./parser.js";
import { resolveWorkflowSource } from "./templates.js";
import type { WorkflowGraph } from "./types.js";

// The graph `cast workflow run-daemon` executes for a run (the-line.md L9).
//
// A run backed by a pushed workflows row arrives with its nodes and runs as
// they are. A run the sweep started under a slug the host never pushed (the
// shipped "line", the default for every role) arrives with no nodes and only
// `run.workflow_name`; that name is resolved the way `cast workflow run
// <name>` resolves it: a file under the run's project path, else a shipped
// template. Null when neither the row nor the name yields a graph.
export function graphForDaemonRun(
  run: { workflow_name?: string | null; goal_override?: string | null; project_path?: string | null },
  wf: { name?: string; goal?: string; model_stylesheet?: string; nodes?: any[]; edges?: any[] } | null | undefined,
  cwd: string = run.project_path || process.cwd(),
): WorkflowGraph | null {
  if (wf?.nodes?.length) {
    const nodes = new Map<string, any>();
    for (const n of wf.nodes) nodes.set(n.id, n);
    return {
      name: wf.name ?? "workflow",
      goal: run.goal_override || wf.goal,
      model_stylesheet: wf.model_stylesheet,
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
