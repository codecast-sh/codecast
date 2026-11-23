// A parsed flow in the shape the app's foldFlow and flowDiagram read (contracts/flowPool FlowNodeIn/FlowEdgeIn): labels,
// kinds, segment ids and conditions, never a prompt's or a script's text. The pipeline publish and the ```flow edit
// fence (pipeline.md PL5, PL6) both send a graph this way.
import type { FlowEdgeIn, FlowNodeIn } from "@codecast/shared/contracts/flowPool";
import type { WorkflowGraph, WorkflowNode } from "./types.js";

const FLOW_NODE_KEYS = ["id", "label", "type", "shape", "backend", "agent", "segment", "segment_label", "segment_flow", "segment_entry", "segment_exit", "slot", "segment_generated", "stop", "max_visits"] as const satisfies ReadonlyArray<keyof FlowNodeIn & keyof WorkflowNode>;

export function flowNodeOf(n: WorkflowNode): FlowNodeIn {
  const out: Record<string, unknown> = {};
  for (const k of FLOW_NODE_KEYS) if (n[k] !== undefined) out[k] = n[k];
  return out as FlowNodeIn;
}

export const edgesOf = (g: WorkflowGraph): FlowEdgeIn[] => g.edges.map((e) => ({ from: e.from, to: e.to, ...(e.label ? { label: e.label } : {}), ...(e.condition ? { condition: e.condition } : {}) }));

/** What drawing a flow reads of a node: the rest (its shape, agent client, a segment's label on each step) stays home. */
const DRAWN_KEYS = new Set<string>(["id", "label", "type", "backend", "segment", "segment_flow", "segment_entry", "segment_exit", "slot", "segment_generated", "stop", "max_visits"]);

/** The graph as a drawing needs it, for a fence that travels in a transcript. */
export const drawnGraphIn = (g: WorkflowGraph): { nodes: FlowNodeIn[]; edges: FlowEdgeIn[] } => ({
  nodes: [...g.nodes.values()].map((n) => Object.fromEntries(Object.entries(flowNodeOf(n)).filter(([k]) => DRAWN_KEYS.has(k))) as FlowNodeIn),
  edges: edgesOf(g),
});
