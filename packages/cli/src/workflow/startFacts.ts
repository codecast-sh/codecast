// What a run knows of its checkout before any station runs (flows.md FL4), and the start a flow routes on them.
// `ship_mode` is the repository's own [ship] mode in .codecast/workspace.toml: "direct" ships straight to the default
// branch with no pull request, "pr" (the default) through one. The library change flow's start routes on it, and a
// start these facts decide is decided before the run: the run carries, and its card draws, only the path it takes.
import * as fs from "node:fs";
import * as path from "node:path";
import { evalCondition, parseCondition } from "./condition";
import { findLineProfile } from "../lineProfile";
import { MANIFEST_REL_PATH, parseManifest } from "../workspace/manifest";
import type { WorkflowEdge, WorkflowGraph } from "./types";

/** The facts a checkout gives every run in it. A manifest that cannot be read says nothing: the run takes the default path. */
export function startFacts(cwd: string): Record<string, string> {
  const root = findLineProfile(cwd).root;
  if (!root) return { ship_mode: "pr" };
  const file = path.join(root, MANIFEST_REL_PATH);
  try {
    return { ship_mode: (fs.existsSync(file) && parseManifest(file)?.ship?.mode) || "pr" };
  } catch {
    return { ship_mode: "pr" };
  }
}

/** Whether a condition reads only these facts: every value it names is a fact, or the literal a fact is compared with. */
function readsOnly(condition: string, facts: Record<string, string>): boolean {
  const fact = (o: { quoted: boolean; text: string }) => o.quoted || o.text in facts;
  const walk = (n: any): boolean => {
    if (n.kind === "or" || n.kind === "and") return walk(n.left) && walk(n.right);
    if (n.kind === "not") return walk(n.inner);
    if (n.kind === "truthy") return fact(n.operand);
    return fact(n.left) || fact(n.right);
  };
  try {
    return walk(parseCondition(condition));
  } catch {
    return false;
  }
}

/** The start edge a run takes, as the runner picks it (resolveNextNode): the first condition that holds, else an edge with none. */
function taken(edges: WorkflowEdge[], context: Record<string, string>): WorkflowEdge | undefined {
  const sorted = [...edges].sort((a, b) => (b.weight || 0) - (a.weight || 0));
  return sorted.find((e) => e.condition && evalCondition(e.condition, context)) ?? sorted.find((e) => !e.condition);
}

/**
 * The graph a run in this checkout carries: when the facts send the start another way than a run without them goes,
 * only that way and what it reaches; otherwise the graph as it is, so a flow these facts leave alone stays the
 * library's own (its hash, its card).
 */
export function decideStart(graph: WorkflowGraph, facts: Record<string, string>): WorkflowGraph {
  const start = [...graph.nodes.values()].find((n) => n.type === "start");
  const out = start ? graph.edges.filter((e) => e.from === start.id) : [];
  if (out.length < 2 || !out.every((e) => !e.condition || readsOnly(e.condition, facts))) return graph;
  const edge = taken(out, facts);
  if (!edge || edge === taken(out, {})) return graph;
  const edges = graph.edges.filter((e) => e.from !== start!.id || e === edge);
  const kept = new Set([start!.id]);
  for (let frontier = [start!.id]; frontier.length; ) {
    frontier = edges.filter((e) => frontier.includes(e.from) && !kept.has(e.to)).map((e) => e.to);
    frontier.forEach((id) => kept.add(id));
  }
  return {
    ...graph,
    nodes: new Map([...graph.nodes].filter(([id]) => kept.has(id))),
    edges: edges.filter((e) => kept.has(e.from) && kept.has(e.to)),
  };
}
