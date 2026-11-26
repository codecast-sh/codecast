// A flow as a diagram a person reads at a glance (docs/architecture/flows.md
// FL6): the path a change takes when every station passes, left to right; a
// segment as a frame holding its own steps; the routes off that path (a stop,
// a loop back) in words under the step they leave; and a run's state on each
// step. Pure: FlowDiagram draws it, and the Flows view, the `flow` fence and a
// `cast flow run` card all read a flow through it.
import { foldFlow, segmentTopOf, SEGMENT_SEP, type FlowEdgeIn, type FlowNodeIn, type FlowStation, type FlowStationKind } from "@codecast/shared/contracts/flowPool";
import { edgeWords } from "./lineModel";
import { stationResult, type StationResult } from "../ship/stationResult";
import { roundsOnOwnResults } from "../ship/ownRound";
import { personalRound, type RoundState, type RoundView } from "../ship/personalRound";

/** `nothing`: the run passed through it and its result said it found nothing to do there (stationResult.ts). */
/** `back`: on a run that goes on, the step's findings went back to the session (an own-results round, ownRound.ts). */
/** `unknown`: it may or may not have done its work (Land at Landing unknown). */
export type StepState = "idle" | "done" | "current" | "stopped" | "nothing" | "back" | "unknown";
export type SideRoute = {
  /** What happened, in a few words: an end's own name, else the condition or option that takes this route. */
  outcome: string;
  /** The station it leads to; null when it ends the flow there. */
  leadsTo: string | null;
  tone: "stop" | "back" | "out";
  /** The target's id in the run's graph. */
  toId: string;
};

export type DiagramStep = {
  /** The node's id in the run's graph (a segment's steps carry its prefix), so a run's visits find it. */
  id: string;
  label: string;
  kind: FlowStationKind;
  /** A segment's own steps, on its passing path. */
  inner: DiagramStep[];
  side: SideRoute[];
  /** A slot: what it must do, and whether it is empty, runs its default steps, or holds steps written in place. */
  slot?: FlowStation["slot"];
};

/**
 * What a pipeline says on one step beside its name (pipeline.md PL7): whether the project added or changed it
 * (null: inherited from the backbone), what it changed, the paths it runs for, that it has no command and passes,
 * that its command differs by target, that it waits for a deploy and sends none, and how many changes stand on it now. A plain flow draws no marks.
 */
export type StepMark = { own: "added" | "changed" | null; changed?: string[]; when?: string; passes?: true; varies?: true; waits?: true; here?: number; hereNames?: string[];
  /** Of `here`, how many stand on the steps inside this frame: an open frame shows them on those steps and counts only the rest. */
  hereInside?: number;
  /** An edit proposed and not live yet, in words ("proposed · <session>"): the step is drawn as a ghost. */
  proposed?: string;
  /** A proposed edit takes this step off the path. */
  skipped?: true };

/** `hub`: in a flow run around one step (every stage hands the work back to it, as a one-session flow does), that step:
 *  its stages follow it in the order it names them, and their ways back lead to it. `own`: the flow's round routes on
 *  its branches' own results (ownRound.ts), and a run of it reads through its round's view (personalRound.ts). */
export type FlowDiagramModel = { steps: DiagramStep[]; end: string | null; endId: string | null; hub?: { id: string; label: string }; own?: { graph: Graph } };

type Graph = { nodes: ReadonlyArray<FlowNodeIn>; edges: ReadonlyArray<FlowEdgeIn>; own_results?: boolean; source?: string | null };

const cache = new WeakMap<object, FlowDiagramModel>();

/** The diagram of a flow's expanded graph (its segments' steps carry `<segment>__` ids). */
export function flowDiagram(flow: Graph): FlowDiagramModel {
  const hit = cache.get(flow);
  if (hit) return hit;
  const model = diagramOf(flow.nodes, flow.edges, "", roundsOnOwnResults(flow));
  cache.set(flow, model);
  return model;
}

function diagramOf(nodes: ReadonlyArray<FlowNodeIn>, edges: ReadonlyArray<FlowEdgeIn>, prefix: string, personal = false): FlowDiagramModel {
  const folded = foldFlow(nodes, edges);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const stationById = new Map(folded.stations.map((s) => [s.id, s]));
  // A fan-out's branches draw inside it, and its join is where its routes leave from: neither is a step of its own.
  const branchOf = new Map<string, string>();
  const joinOf = new Map<string, string>();
  for (const s of folded.stations) {
    if (s.kind !== "parallel") continue;
    for (const n of s.next) {
      branchOf.set(n.toId, s.id);
      const join = stationById.get(n.toId)?.next.find((x) => stationById.get(x.toId)?.kind === "join");
      if (join) joinOf.set(s.id, join.toId);
    }
  }
  const walked = folded.stations.filter((s) => s.main && s.kind !== "join" && !branchOf.has(s.id));
  // A last step that is bookkeeping (fold) run only on one way to the end the step before it also reaches straight (the
  // personal Ship's Left for you, run only when a step was left) is a way off that step, not the path.
  const [beforeLast, last] = walked.slice(-2);
  const optional = personal && !!last && !!beforeLast && !!byId.get(last.id)?.fold
    && edges.some((e) => e.from === beforeLast.id && byId.get(e.to)?.type === "exit" && !isStop(byId.get(e.to)!) && edges.some((x) => x.from === last.id && x.to === e.to));
  const passing = optional ? walked.slice(0, -1) : walked;
  const hub = prefix ? null : hubOf(passing, edges, byId, stationById, joinOf, personal);
  const main = hub ? hub.path : passing;
  const mainIndex = new Map(main.map((s, i) => [s.id, i]));
  for (const [fan, join] of joinOf) mainIndex.set(join, mainIndex.get(fan) ?? -1);
  // The end the last step reaches by passing is the flow's end, drawn after it.
  const lastStep = main[main.length - 1];
  const leaveFrom = lastStep ? joinOf.get(lastStep.id) ?? lastStep.id : null;
  const endEdge = leaveFrom ? edges.find((e) => segmentTopOf(e.from) === leaveFrom && byId.get(segmentTopOf(e.to))?.type === "exit" && !isStop(byId.get(segmentTopOf(e.to))!)) : undefined;
  const endId = endEdge ? segmentTopOf(endEdge.to) : null;
  const own = personal ? { graph: { nodes, edges, own_results: true } } : null;

  /** Routes leaving `from` (a station, a segment's steps, a fan-out's join) other than to `next`. */
  const routesOut = (from: (id: string) => boolean, next: string | undefined, at: number, last: boolean): SideRoute[] => {
    const side: SideRoute[] = [];
    for (const e of edges) {
      if (!from(e.from) || from(e.to)) continue;
      const to = segmentTopOf(e.to);
      if (to === next || stationById.get(to)?.kind === "join") continue;
      const target = byId.get(to);
      const words = edgeWords(e) ?? "otherwise";
      // An end is said by its own name (the outcome); a route to a station by what takes it, and where it leads.
      if (target?.type === "exit" || target?.segment_exit) {
        // The end the last step reaches by passing is the flow's end, not a side route. An own-results round's other
        // ends short of it (Deployed, unverified; Landed) are ends of their own, named where a run reaches them.
        if (last && !isStop(target) && !(own && to !== endId)) continue;
        side.push({ outcome: target.label, leadsTo: null, tone: isStop(target) ? "stop" : "out", toId: prefix + to });
      } else if (endsThere(to, edges, byId)) {
        // A step whose only way on is an end (Closed, Dropped) is that end, said by its name.
        side.push({ outcome: target?.label ?? to, leadsTo: null, tone: /stop|fail/i.test(`${to} ${target?.label ?? ""}`) ? "stop" : "out", toId: prefix + to });
      } else if (mainIndex.has(to) && mainIndex.get(to)! <= at) side.push({ outcome: words, leadsTo: target?.label ?? to, tone: "back", toId: prefix + to });
      else side.push({ outcome: words, leadsTo: target?.label ?? to, tone: "out", toId: prefix + to });
    }
    return dedupe(side);
  };

  // A segment's stop the flow sends back to the session the change came from (its subject station) is no stop:
  // the work goes back, the session fixes it, and the stage runs again. The route to the subject station itself
  // is said once, on that exit, never as a separate way on. A plain station (a script, a fan-in) has no exit to say
  // it on, so its route to the subject station is the way back itself, said by the edge's words.
  const subjectIds = new Set(nodes.filter((n) => n.backend === "subject").map((n) => n.id));
  const backExits = new Set(edges.filter((e) => subjectIds.has(e.to) && !!byId.get(e.from)?.segment_exit && takesOwnExit(e)).map((e) => prefix + e.from));
  const toSession = (r: SideRoute, fromSegment: boolean): SideRoute | null =>
    subjectIds.has(r.toId.slice(prefix.length)) ? (fromSegment ? null : { ...r, tone: "back", leadsTo: SESSION_WORDS })
    : backExits.has(r.toId) ? { ...r, tone: "back", leadsTo: SESSION_WORDS } : r;
  const reroute = (step: DiagramStep): DiagramStep => {
    const inner = step.inner.map(reroute);
    // A segment's frame repeats what one of its steps already says when the parent's end has the same name.
    const said = new Set(inner.flatMap((i) => i.side.map((r) => `${r.tone}|${r.outcome}`)));
    const side = step.side.map((r) => toSession(r, step.kind === "segment")).filter((r): r is SideRoute => !!r && !said.has(`${r.tone}|${r.outcome}`));
    return { ...step, side, inner };
  };

  const steps: DiagramStep[] = main.map((s, i) => {
    const next = main[i + 1]?.id;
    const last = i === main.length - 1;
    if (s.kind === "parallel") {
      const join = joinOf.get(s.id);
      return {
        id: prefix + s.id,
        label: s.label,
        kind: s.kind,
        inner: s.next.map((n) => {
          const b = stationById.get(n.toId)!;
          return { id: prefix + b.id, label: b.label, kind: b.kind, inner: [], side: routesOut((id) => id === b.id, join, i, false) };
        }),
        side: join ? routesOut((id) => id === join, next, i, last) : [],
      };
    }
    return {
      id: prefix + s.id,
      label: s.label,
      kind: s.kind,
      inner: s.kind === "segment" ? innerSteps(nodes, edges, s.id, prefix) : [],
      // A hub's stages are drawn after it, so its routes to them are the path, not routes off it.
      side: routesOut((id) => segmentTopOf(id) === s.id, next, i, last).filter((r) => !(hub && s.id === hub.id && hub.stages.has(r.toId.slice(prefix.length)))),
      ...(s.slot ? { slot: s.slot } : {}),
    };
  });
  const drawn = subjectIds.size ? steps.map(reroute) : steps;
  // An own-results round's steps the diagram does not draw are at the drawn step the run came to them from (own).
  return { steps: drawn, end: endId ? byId.get(endId)?.label ?? null : null, endId: endId ? prefix + endId : null, ...(hub ? { hub: { id: prefix + hub.id, label: stationById.get(hub.id)?.label ?? hub.id } } : {}), ...(own ? { own } : {}) };
}

/** Whether a node's every way on is an end: it ends the run there (a "Closed" step that only exits). */
function endsThere(id: string, edges: ReadonlyArray<FlowEdgeIn>, byId: Map<string, FlowNodeIn>): boolean {
  const outs = edges.filter((e) => segmentTopOf(e.from) === id);
  return outs.length > 0 && outs.every((e) => byId.get(segmentTopOf(e.to))?.type === "exit");
}

/** The fewest stages a step must hand work to, each handing it back, for the flow to be drawn around it. */
const HUB_MIN_STAGES = 3;

/**
 * A flow run around one step: a step on the passing path that sends work, by its outcome, to stages that each hand it
 * back (Build → Push → Merge → Build). Its passing path is the path up to that step, then its stages in the order it
 * names them, each with the steps it runs before handing back. Null for a flow with no such step.
 */
function hubOf(passing: FlowStation[], edges: ReadonlyArray<FlowEdgeIn>, byId: Map<string, FlowNodeIn>, stationById: Map<string, FlowStation>, joinOf: Map<string, string>, personal: boolean) {
  const isEnd = (id: string) => byId.get(id)?.type === "exit" || endsThere(id, edges, byId);
  const outsOf = (id: string) => edges.filter((e) => segmentTopOf(e.from) === (joinOf.get(id) ?? id)).map((e) => ({ e, to: segmentTopOf(e.to) }));
  /** Whether work from `from` comes back to `hub` within a few steps, by any way but an end. */
  const returns = (from: string, hub: string) => {
    const seen = new Set([from]);
    let wave = [from];
    for (let d = 0; d < 6 && wave.length; d++) {
      const next: string[] = [];
      for (const id of wave) for (const { to } of outsOf(id)) {
        if (to === hub) return true;
        if (!seen.has(to) && !isEnd(to)) { seen.add(to); next.push(to); }
      }
      wave = next;
    }
    return false;
  };
  for (let i = 0; i < passing.length; i++) {
    const h = passing[i];
    // Its stages: where it sends work on an outcome, in the order it names them, each coming back to it.
    const named = outsOf(h.id).filter(({ e, to }) => /outcome\s*=/.test(e.condition ?? "") && !isEnd(to) && to !== h.id);
    const returning = [...new Set(named.map((x) => x.to))].filter((to) => stationById.has(to) && returns(to, h.id));
    // In a personal Ship, the session's own fix stations (backend=subject) hand work back to whatever sent it: beside a
    // flow's own stations they are no stage of a hub (the personal Ship's Round sends work to its Check and to a conflict's fix, and the change
    // goes on to Land and Deploy). A step whose every stage is the session's is still drawn around it.
    const own = personal ? returning.filter((to) => byId.get(to)?.backend !== "subject") : [];
    const stages = own.length ? own : returning;
    if (stages.length < HUB_MIN_STAGES) continue;
    // Its way out: the first step it names after its last stage that only ends the run (Watch, then the flow's end).
    const order = [...new Set(outsOf(h.id).filter(({ e }) => /outcome\s*=/.test(e.condition ?? "")).map((x) => x.to))];
    const after = Math.max(...stages.map((st) => order.indexOf(st)));
    const out = order.slice(after + 1).find((to) => stationById.has(to) && endsThere(to, edges, byId)) ?? null;
    const path: FlowStation[] = passing.slice(0, i + 1);
    const taken = new Set([...path.map((x) => x.id), ...stages]);
    for (const st of stages) {
      path.push(stationById.get(st)!);
      // The steps a stage runs before it hands back (Push, then Merge): its one way on that comes back too.
      let at = st;
      for (let k = 0; k < 4; k++) {
        const on = [...new Set(outsOf(at).map((x) => x.to))].filter((to) => to !== h.id && !isEnd(to) && !taken.has(to) && stationById.has(to) && returns(to, h.id));
        if (on.length !== 1) break;
        taken.add(on[0]);
        path.push(stationById.get(on[0])!);
        at = on[0];
      }
    }
    if (out) path.push(stationById.get(out)!);
    return { id: h.id, path, stages: new Set(out ? [...stages, out] : stages) };
  }
  return null;
}

const isStop = (n: FlowNodeIn) => n.segment_exit === "stop" || (n.type === "exit" && !!n.stop);

/** Where a stage's findings go when the flow sends them back: the session the change came from. */
export const SESSION_WORDS = "this session";

/** Whether an edge out of a segment's exit is taken on that exit: its condition names no exit, or names this one
 *  (`review__changes.json.exit = changes`). The parser writes the same route from every stop of the segment. */
function takesOwnExit(e: FlowEdgeIn): boolean {
  const m = e.condition?.match(/\.exit\s*(!?=)\s*([\w-]+)/);
  if (!m) return true;
  const isNamed = e.from.endsWith(`${SEGMENT_SEP}${m[2]}`) || e.from === m[2];
  return m[1] === "!=" ? !isNamed : isNamed;
}

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
    const k = `${r.tone}|${r.leadsTo}|${r.outcome}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

type RunNodes = { status: string; current_node_id?: string | null; node_statuses?: ReadonlyArray<{ node_id: string; status: string; started_at?: number; result_preview?: string | null }> | null };

const inStep = (stepId: string, nodeId: string) => nodeId === stepId || nodeId.startsWith(`${stepId}${SEGMENT_SEP}`);

/** What a step reported when it last finished on a run: its own result, or for a segment its newest step's. */
export function stepResult(run: RunNodes | null | undefined, stepId: string): StationResult | null {
  const mine = (run?.node_statuses ?? []).filter((n) => inStep(stepId, n.node_id));
  const last = mine.reduce<(typeof mine)[number] | undefined>((best, n) => (!best || (n.started_at ?? 0) >= (best.started_at ?? 0) ? n : best), undefined);
  return last?.status === "completed" ? stationResult(last.result_preview) : null;
}

/** Each step's state on a run: done when the run passed through it, current where it stands, stopped where it failed.
 *  A run of an own-results round reads as its round's view says (ownStepStates). */
export function stepStates(model: FlowDiagramModel, run: RunNodes | null | undefined): Map<string, StepState> {
  const out = new Map<string, StepState>();
  if (!run) return out;
  if (model.own) return ownStepStates(model, personalRound(model.own.graph, run)!, run);
  const statuses = run.node_statuses ?? [];
  const live = run.status === "running" || run.status === "paused" || run.status === "pending";
  const inGroup = inStep;
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

/**
 * Each step's state on a run of an own-results round (ownRound.ts), as its round's view says (personalRound.ts), the
 * view the journey, a station's panel and the run report read. One step is current: the station at work. A drawn
 * bookkeeping step that runs (Landed, Verdicts) is its station at work, which reads current; a fan-out's running
 * branches are, not the fan-out (folded, it shows them); a step the diagram does not draw (After the fix, Read the fix)
 * is current on the drawn step the run came to it from. A failure reads back once the run went back to the session,
 * else it stopped there.
 */
function ownStepStates(model: FlowDiagramModel, round: RoundView, run: RunNodes): Map<string, StepState> {
  const out = new Map<string, StepState>();
  const live = run.status === "running" || run.status === "paused" || run.status === "pending";
  const statuses = run.node_statuses ?? [];
  const parentOf = new Map<string, string>();
  const order: string[] = [];
  const index = (ss: DiagramStep[], parent: string | null) => { for (const x of ss) { order.push(x.id); if (parent) parentOf.set(x.id, parent); index(x.inner, x.id); } };
  index(model.steps, null);
  const drawn = new Set(order);
  const STATE: Record<RoundState, StepState> = { idle: "idle", running: live ? "current" : "idle", done: "done", nothing: "nothing", back: live ? "back" : "stopped", stopped: "stopped", failed: "stopped", unknown: "unknown" };
  for (const id of order) out.set(id, STATE[round.station(id).state]);
  // Bookkeeping at work is its station at work.
  for (const id of order) if (round.tailOf[id] && out.get(id) === "current") out.set(id, "idle");
  // A fan-out whose branches run is shown by them.
  for (const id of order) if ([...parentOf].some(([child, p]) => p === id && out.get(child) === "current")) out.set(id, "idle");
  // A step the diagram does not draw, running: walk back through the newest of its ways in to a drawn step.
  const cur = live ? run.current_node_id ?? "" : "";
  const entry = (id: string) => statuses.filter((n) => n.node_id === id).reduce<(typeof statuses)[number] | undefined>((b, n) => (!b || (n.started_at ?? 0) >= (b.started_at ?? 0) ? n : b), undefined);
  if (cur && !drawn.has(cur) && !round.tailOf[cur] && !round.fixing && entry(cur)?.status === "running" && ![...out.values()].includes("current")) {
    const ways = model.own!.graph.edges;
    let at: string | undefined = cur;
    const seen = new Set<string>();
    while (at && !drawn.has(at) && !seen.has(at)) {
      seen.add(at);
      const from: string[] = [...new Set(ways.filter((e) => e.to === at).map((e) => e.from))];
      at = from.filter((f) => entry(f)).sort((a, b) => (entry(b)!.started_at ?? 0) - (entry(a)!.started_at ?? 0))[0];
    }
    // A step that failed on its way there (Land, when the change was already on main) stays as it ended.
    const step = at && drawn.has(at) ? parentOf.get(at) ?? at : null;
    if (step && out.get(step) !== "stopped") out.set(step, "current");
  }
  return out;
}

/** Whether a run went to this node (a route it took, the end it reached). */
export function runReached(run: RunNodes | null | undefined, nodeId: string | null): boolean {
  if (!run || !nodeId) return false;
  return run.current_node_id === nodeId || !!run.node_statuses?.some((n) => n.node_id === nodeId);
}

/** What each person's step in a flow asks, from its own options: "Ship, revise or drop it". */
export function flowAsks(flow: Graph): string[] {
  return flow.nodes.filter((n) => n.type === "human").map((n) => {
    const options = flow.edges.filter((e) => e.from === n.id && e.label && /^\[\w+\]/.test(e.label)).map((e) => e.label!.replace(/^\[\w+\]\s*/, "").split("::")[0].trim().toLowerCase());
    if (!options.length) return n.label;
    const list = options.length > 1 ? `${options.slice(0, -1).join(", ")} or ${options[options.length - 1]}` : options[0];
    return `${list.replace(/^\w/, (c) => c.toUpperCase())} it`;
  });
}

/** What a route does, in words after its outcome: it stops the run, the flow ends there, or where it goes. */
export function routeTail(r: SideRoute): string {
  if (!r.leadsTo) return r.tone === "stop" ? "stops the run" : "ends here";
  return r.tone === "back" ? `back to ${r.leadsTo}` : `on to ${r.leadsTo}`;
}
