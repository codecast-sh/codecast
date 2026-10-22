// A flow as a diagram a person reads at a glance (docs/architecture/flows.md
// FL6): the path a change takes when every station passes, left to right; a
// segment as a frame holding its own steps; the routes off that path (a stop,
// a loop back) in words under the step they leave; and a run's state on each
// step. Pure: FlowDiagram draws it, and the Flows view, the `flow` fence and a
// `cast flow run` card all read a flow through it.
import { foldFlow, segmentTopOf, SEGMENT_SEP, type FlowEdgeIn, type FlowNodeIn, type FlowStationKind } from "@codecast/shared/contracts/flowPool";
import { edgeWords } from "./lineModel";

export type StepState = "idle" | "done" | "current" | "stopped";
export type SideRoute = { words: string | null; to: string; tone: "stop" | "back" | "out"; /** The target's id in the run's graph. */ toId: string };

export type DiagramStep = {
  /** The node's id in the run's graph (a segment's steps carry its prefix), so a run's visits find it. */
  id: string;
  label: string;
  kind: FlowStationKind;
  /** A segment's own steps, on its passing path. */
  inner: DiagramStep[];
  side: SideRoute[];
};

export type FlowDiagramModel = { steps: DiagramStep[]; end: string | null; endId: string | null };

type Graph = { nodes: ReadonlyArray<FlowNodeIn>; edges: ReadonlyArray<FlowEdgeIn> };

const cache = new WeakMap<object, FlowDiagramModel>();

/** The diagram of a flow's expanded graph (its segments' steps carry `<segment>__` ids). */
export function flowDiagram(flow: Graph): FlowDiagramModel {
  const hit = cache.get(flow);
  if (hit) return hit;
  const model = diagramOf(flow.nodes, flow.edges, "");
  cache.set(flow, model);
  return model;
}

function diagramOf(nodes: ReadonlyArray<FlowNodeIn>, edges: ReadonlyArray<FlowEdgeIn>, prefix: string): FlowDiagramModel {
  const folded = foldFlow(nodes, edges);
  const main = folded.stations.filter((s) => s.main);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const mainIndex = new Map(main.map((s, i) => [s.id, i]));
  const steps: DiagramStep[] = main.map((s, i) => {
    const group = (id: string) => segmentTopOf(id) === s.id;
    const nextMain = main[i + 1]?.id;
    const side: SideRoute[] = [];
    for (const e of edges) {
      if (!group(e.from) || group(e.to)) continue;
      const to = segmentTopOf(e.to);
      if (to === nextMain) continue;
      const target = byId.get(to);
      const words = edgeWords(e) ?? "otherwise";
      if (target?.type === "exit" || target?.segment_exit) {
        // The end the last step reaches by passing is the flow's end, not a side route.
        if (i === main.length - 1 && !isStop(target)) continue;
        side.push({ words, to: target.label, tone: isStop(target) ? "stop" : "out", toId: prefix + to });
      } else if (mainIndex.has(to) && mainIndex.get(to)! <= i) side.push({ words, to: target?.label ?? to, tone: "back", toId: prefix + to });
      else side.push({ words, to: target?.label ?? to, tone: "out", toId: prefix + to });
    }
    return {
      id: prefix + s.id,
      label: s.label,
      kind: s.kind,
      inner: s.kind === "segment" ? innerSteps(nodes, edges, s.id, prefix) : [],
      side: dedupe(side),
    };
  });
  const last = main[main.length - 1];
  const endEdge = last ? edges.find((e) => segmentTopOf(e.from) === last.id && byId.get(segmentTopOf(e.to))?.type === "exit" && !isStop(byId.get(segmentTopOf(e.to))!)) : undefined;
  const endId = endEdge ? segmentTopOf(endEdge.to) : null;
  return { steps, end: endId ? byId.get(endId)?.label ?? null : null, endId: endId ? prefix + endId : null };
}

const isStop = (n: FlowNodeIn) => n.segment_exit === "stop" || (n.type === "exit" && !!n.stop);

/** A segment's own steps: its nodes with the segment's name taken off, its entry as their start, its exits as ends. */
function innerSteps(nodes: ReadonlyArray<FlowNodeIn>, edges: ReadonlyArray<FlowEdgeIn>, seg: string, prefix: string): DiagramStep[] {
  const p = `${seg}${SEGMENT_SEP}`;
  const strip = (id: string) => (id === seg ? "start" : id.slice(p.length));
  const inner: FlowNodeIn[] = [{ id: "start", label: "start", type: "start" }];
  for (const n of nodes) {
    if (!n.id.startsWith(p)) continue;
    inner.push({ ...n, id: strip(n.id), type: n.segment_exit && n.segment === seg ? "exit" : n.type, ...(n.segment_exit === "stop" ? { segment_exit: "stop" } : {}) });
  }
  const innerEdges = edges.filter((e) => (e.from === seg || e.from.startsWith(p)) && e.to.startsWith(p)).map((e) => ({ ...e, from: strip(e.from), to: strip(e.to) }));
  return diagramOf(inner, innerEdges, p).steps.map((s) => ({ ...s, id: prefix + s.id }));
}

function dedupe(routes: SideRoute[]): SideRoute[] {
  const seen = new Set<string>();
  return routes.filter((r) => {
    const k = `${r.tone}|${r.to}|${r.words}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

type RunNodes = { status: string; current_node_id?: string | null; node_statuses?: ReadonlyArray<{ node_id: string; status: string }> | null };

/** Each step's state on a run: done when the run passed through it, current where it stands, stopped where it failed. */
export function stepStates(model: FlowDiagramModel, run: RunNodes | null | undefined): Map<string, StepState> {
  const out = new Map<string, StepState>();
  if (!run) return out;
  const statuses = run.node_statuses ?? [];
  const live = run.status === "running" || run.status === "paused" || run.status === "pending";
  const inGroup = (stepId: string, nodeId: string) => nodeId === stepId || nodeId.startsWith(`${stepId}${SEGMENT_SEP}`);
  const walk = (steps: DiagramStep[]) => {
    for (const s of steps) {
      const mine = statuses.filter((n) => inGroup(s.id, n.node_id));
      const here = !!run.current_node_id && inGroup(s.id, run.current_node_id);
      const state: StepState = here && live ? "current"
        : mine.some((n) => n.status === "failed") || (here && run.status === "failed") ? "stopped"
        : mine.length || here ? "done" : "idle";
      out.set(s.id, state);
      walk(s.inner);
    }
  };
  walk(model.steps);
  return out;
}

/** Whether a run went to this node (a route it took, the end it reached). */
export function runReached(run: RunNodes | null | undefined, nodeId: string | null): boolean {
  if (!run || !nodeId) return false;
  return run.current_node_id === nodeId || !!run.node_statuses?.some((n) => n.node_id === nodeId);
}
