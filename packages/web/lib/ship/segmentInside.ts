// A segment stage's inside (docs/architecture/flows.md FL4): its own steps read as a flow of their own, the stages a
// passing run takes through them, and every route off those stages, each to where it goes back to. The journey
// (journey.ts) plans the stages and says who acts at a step; it hands those readers in, so this file holds only the
// walk. Pure, with relative imports only, as journey.ts is.
import { edgeWhen, passScore, segmentTopOf, SEGMENT_SEP, type FlowEdgeIn, type FlowNodeIn } from "@codecast/shared/contracts/flowPool";
import type { JourneyStage, StageState, StageWho } from "./journey";

/** A segment stage's inside, read from its graph: the stages a passing run takes through it (a fan-out holding its
 *  branches), each route off them, and the end the passing path reaches. */
export type StageInside = { path: JourneyStage[]; routes: InsideRoute[]; end: string | null };

/**
 * A way a segment turns off its passing path: the path step it leaves (`from`), its edge's label, the steps it runs, and
 * where it ends: back on the path at a step, back to the session, or stopped. `asks`: a person answers on it, `when` what
 * makes a run ask (asks_if).
 */
export type InsideRoute = {
  from: string;
  label: string | null;
  steps: Array<{ id: string; label: string; who: StageWho; state: StageState }>;
  to: { kind: "step"; id: string; label: string } | { kind: "session" } | { kind: "stop" };
  asks: { when: string | null } | null;
  state: StageState;
};

/** A route before a run: no states yet. */
export type RouteBase = Omit<InsideRoute, "steps" | "state"> & { steps: Array<{ id: string; label: string; who: StageWho }> };

type Graph = { nodes: ReadonlyArray<FlowNodeIn>; edges: ReadonlyArray<FlowEdgeIn> };
/** What the walk needs of a stage the journey planned. */
type Planned = { id: string; label: string; members: string[]; tail?: string[]; branches?: Planned[] };
/** The journey's own readers: its stages of a graph (a segment's own, whose segments read as one step each), who acts
 *  at a step, and the steps a passing run takes through one. */
export type InsideReaders<B extends Planned> = {
  plan: (g: Graph) => B[];
  who: (g: Graph, ids: string[]) => StageWho;
  passing: (g: Graph, id: string) => FlowNodeIn[];
};

/** An edge whose condition compares two words the parser already wrote in (a segment's param): never taken when false. */
const deadEdge = (e: FlowEdgeIn) =>
  !/\bor\b/.test(e.condition ?? "") && [...(e.condition ?? "").matchAll(/"([^"]*)"\s*(!=|=)\s*"([^"]*)"/g)].some((m) => (m[1] === m[3]) === (m[2] === "!="));

/** How a side route goes on from a step: by its condition alone (every route out is labelled), the passing edge first,
 *  then the step's default (no condition) before one that waits on a particular exit. */
const routeRank = (e: FlowEdgeIn) => passScore({ condition: e.condition, label: /^\[\w+\]/.test(e.label ?? "") ? e.label : undefined }) * 2 + (e.condition ? 0 : 1);

/** What makes a run ask at a person's step: its own `asks_if`, else that of the segment holding it, out to the flow's. */
export function asksIfOf(graph: Graph, id: string): string | null {
  const parts = id.split(SEGMENT_SEP);
  for (let i = parts.length; i > 0; i--) {
    const said = graph.nodes.find((n) => n.id === parts.slice(0, i).join(SEGMENT_SEP))?.asks_if;
    if (said) return said;
  }
  return null;
}

/** A segment's entry, as the start of its steps read as a flow of their own. */
const ENTRY = "^";

/**
 * A segment's inside, read from the graph: its steps as a flow of their own (its entry the start, a step with no way on
 * inside it an end), the stages a passing run takes through them, and every route off those stages that goes through a
 * step before it comes back to one, goes back to the session (an end the composing flow sends to a `backend=subject`
 * station) or stops. Undefined for a station that is no segment, or one whose inside is itself (one step, no route).
 */
export function insideOf<B extends Planned>(graph: Graph, id: string, read: InsideReaders<B>): { path: B[]; routes: RouteBase[]; end: string | null } | undefined {
  const pre = `${id}${SEGMENT_SEP}`;
  const own = graph.nodes.filter((n) => n.id.startsWith(pre));
  if (!own.length) return undefined;
  const sub = (x: string) => (x === id ? ENTRY : x.slice(pre.length));
  const full = (x: string) => `${pre}${x}`;
  const edges = graph.edges.filter((e) => (e.from === id || e.from.startsWith(pre)) && e.to.startsWith(pre) && !deadEdge(e)).map((e) => ({ ...e, from: sub(e.from), to: sub(e.to) }));
  const nodes: FlowNodeIn[] = [{ id: ENTRY, label: "start", type: "start" }, ...own.map((n) => {
    const s = sub(n.id);
    // Its steps stand as a flow's own: the segment they belonged to is the flow now.
    return { ...n, id: s, segment: undefined, segment_flow: undefined, segment_entry: own.some((x) => x.id.startsWith(`${n.id}${SEGMENT_SEP}`)), ...(n.type === "exit" || !edges.some((e) => e.from === s) ? { type: "exit" } : {}) };
  })];
  const g: Graph = { nodes, edges };
  const path = read.plan(g);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const ended = (x: string) => byId.get(x)?.type === "exit";
  const stageAt = new Map<string, number>();
  path.forEach((s, i) => s.members.forEach((m) => stageAt.set(m, i)));
  const outOf = (x: string) => edges.filter((e) => segmentTopOf(e.from) === x && segmentTopOf(e.to) !== x).sort((a, b) => routeRank(b) - routeRank(a));
  const routes: RouteBase[] = [];
  for (const e of edges) {
    const from = stageAt.get(segmentTopOf(e.from));
    const first = segmentTopOf(e.to);
    const back = stageAt.get(first);
    // Only a turn off the path: never along it, never straight into an end.
    if (from === undefined || ended(first) || (back !== undefined && back >= from)) continue;
    const steps: string[] = [];
    let to: InsideRoute["to"] = { kind: "stop" };
    for (let cur: string | undefined = first; cur && !steps.includes(cur); cur = outOf(cur).map((x) => segmentTopOf(x.to))[0]) {
      const on = stageAt.get(cur);
      if (on !== undefined) { to = { kind: "step", id: full(path[on].id), label: path[on].label }; break; }
      if (ended(cur)) {
        const end = full(cur);
        if (graph.edges.some((x) => x.from === end && graph.nodes.find((n) => n.id === x.to)?.backend === "subject")) to = { kind: "session" };
        break;
      }
      steps.push(cur);
    }
    const label = e.label ? edgeWhen(e) : null;
    const fromId = full(path[from].id);
    if (routes.some((r) => r.from === fromId && r.label === label && r.steps[0]?.id === (steps[0] ? full(steps[0]) : undefined))) continue;
    const person = steps.find((s) => read.who(g, [s]) === "person");
    const gate = person ? read.passing(g, person).find((n) => n.type === "human") : undefined;
    routes.push({
      from: fromId,
      label,
      steps: steps.map((s) => ({ id: full(s), label: byId.get(s)?.label ?? s, who: read.who(g, [s]) })),
      to,
      asks: person ? { when: gate ? asksIfOf(graph, full(gate.id)) : null } : null,
    });
  }
  if (path.length < 2 && !routes.length) return undefined;
  // The end the passing path reaches from its last stage.
  const last = path[path.length - 1];
  const endId = edges.filter((e) => last?.members.includes(e.from) && ended(e.to)).sort((a, b) => passScore(b) - passScore(a))[0]?.to;
  const lift = (b: Planned): Planned => ({ ...b, id: full(b.id), members: b.members.map(full), ...(b.tail ? { tail: b.tail.map(full) } : {}), ...(b.branches ? { branches: b.branches.map(lift) } : {}) });
  return { path: path.map((b) => lift(b) as B), routes, end: endId ? byId.get(endId)?.label ?? null : null };
}

/** Where a run stands, as a segment's inside reads it: its steps' visits (one per node, its latest), the step it stands
 *  at (`here`: the card's when a gate holds it, else the current step while live), whether that is a gate, whether the
 *  stage sent the work back, whether the stage is after where the run stands, and who answers the gate. */
export type InsideRun = {
  statuses: ReadonlyArray<{ node_id: string; status: string; started_at?: number }>;
  here: string | null; gate: boolean; paused: boolean; live: boolean; later: boolean; back: boolean; gateWho: StageWho;
};

const inGroup = (id: string, nodeId: string) => nodeId === id || nodeId.startsWith(`${id}${SEGMENT_SEP}`);
const newest = <T extends { started_at?: number }>(list: T[]) => list.reduce<T | undefined>((best, n) => (!best || (n.started_at ?? 0) >= (best.started_at ?? 0) ? n : best), undefined);

/**
 * A segment's inside on a run, this round only (from the newest entry into its first step): each step as its visit this
 * round left it (the card a gate holds waits, the step the run stands at is current), nothing after where the run
 * stands, a route waiting or current with its step, and the route that last went back to the session, while the stage
 * has sent the work back, back.
 */
export function insideOnRun<B extends Planned>(inside: { path: B[]; routes: RouteBase[]; end: string | null }, run: InsideRun, idle: (b: B) => JourneyStage): StageInside {
  const since = newest(run.statuses.filter((n) => inside.path[0]?.members.some((m) => inGroup(m, n.node_id))))?.started_at ?? 0;
  const round = run.statuses.filter((n) => (n.started_at ?? 0) >= since);
  const on = (ids: string[]) => !!run.here && ids.some((id) => inGroup(id, run.here!));
  const cut = inside.path.findIndex((p) => on(p.members) || inside.routes.some((r) => r.from === p.id && on(r.steps.map((s) => s.id))));
  const stepState = (ids: string[], i: number): StageState => {
    if (run.later || (cut >= 0 && i > cut)) return "idle";
    if (on(ids)) return run.gate || run.paused ? "waiting" : "active";
    const last = newest(round.filter((n) => ids.some((id) => inGroup(id, n.node_id))));
    if (!last) return "idle";
    if (last.status === "running" || last.status === "pending") return run.live ? "active" : "idle";
    return last.status === "failed" ? "routed" : "done";
  };
  const pathOn = (i: number) => (p: B): JourneyStage => ({ ...idle(p), state: stepState(p.members, i), ...(p.branches ? { branches: (p.branches as B[]).map(pathOn(i)) } : {}) });
  const fromAt = (r: RouteBase) => inside.path.findIndex((p) => p.id === r.from);
  const visited = (r: RouteBase) => Math.max(0, ...round.filter((n) => r.steps.some((s) => inGroup(s.id, n.node_id))).map((n) => n.started_at ?? 0));
  const back = run.back ? inside.routes.filter((r) => r.to.kind === "session" && visited(r) > 0).sort((x, y) => visited(y) - visited(x))[0] : undefined;
  return {
    ...inside,
    path: inside.path.map((p, i) => pathOn(i)(p)),
    routes: inside.routes.map((r) => {
      const steps = r.steps.map((s) => ({ ...s, state: stepState([s.id], fromAt(r)), who: run.gate && on([s.id]) ? run.gateWho : s.who }));
      const has = (s: StageState) => steps.some((x) => x.state === s);
      const state: StageState = has("waiting") ? "waiting" : has("active") ? "active" : r === back ? "back" : steps.length && steps.every((x) => x.state !== "idle") ? "done" : "idle";
      return { ...r, steps, state };
    }),
  };
}

/** A segment's passing path in a few words: "PR · CI + Review · Merge". */
export const insideWords = (inside: Pick<StageInside, "path">) => inside.path.map((s) => (s.branches ? s.branches.map((b) => b.label).join(" + ") : s.label)).join(" · ");
