// A graph file as the `/cli/workflows/upsert` body (the-line.md L8 node
// fidelity): the serializer `cast workflow run` pushes with, so a daemon run
// of the graph matches a local run, and where the graph lives, so the app can
// edit and try its steps on this machine (line-workspace.md LW4). `cast
// workflow push` and `cast flow save` (flowVersionsCommand.ts) send it.
import * as fs from "node:fs";
import { parseWorkflowFile } from "./parser.js";
import type { WorkflowGraph } from "./types.js";

export async function filePushBody(filePath: string, device: string): Promise<{ graph: WorkflowGraph; slug: string; origin: { file: string } | null; body: Record<string, unknown> }> {
  const graph = parseWorkflowFile(filePath);
  const slug = graph.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const { graphToPushPayload } = await import("./runner.js");
  const { nodes, edges, stack, serves } = graphToPushPayload(graph);
  const origin = (await import("../lineGraphEdit.js")).graphOrigin(filePath, graph, device);
  return {
    graph, slug, origin,
    body: {
      name: graph.name, label: graph.label ?? "",
      slug,
      goal: graph.goal,
      source: fs.readFileSync(filePath, "utf-8"),
      nodes, edges, stack,
      ...(serves ? { serves } : {}),
      model_stylesheet: graph.model_stylesheet,
      ...(origin ? { origin } : {}),
    },
  };
}
