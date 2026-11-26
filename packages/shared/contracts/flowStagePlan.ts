// A flow's stages as a person reads them (docs/architecture/flows.md FL4): its stations on the main path in the order a
// passing run reaches them, a fan-out's branches folded into one stage that holds each, bookkeeping folded into the
// stage it finishes, then Deploy and Live. Only the stages and their words: who acts at each, its ways back to the
// session and its inside are the journey's (web lib/ship/journey.ts), which plans on this. The web's picker and run
// card and the CLI's `cast flow run` start line all say the path from here. Pure.
import { foldFlow, segmentTopOf, SEGMENT_SEP, type FlowEdgeIn, type FlowNodeIn } from "./flowPool";

/** What a stage is for, read from the graph: a fan-out, the station that lands the change (one holding the runner's
 *  `shipped` or `landed` step), Deploy, Live, or any other step. */
export type StageRole = "step" | "parallel" | "land" | "deploy" | "live";

/** `members`: the stations it holds. `tail`: bookkeeping it holds after its own work (its verdicts, the sha it merged).
 *  `head`: bookkeeping before the flow's first stage that opens it (a round that freezes the change, a read of the docs). */
export type FlowStage = { id: string; label: string; role: StageRole; kind: string; members: string[]; tail?: string[]; head?: string[]; branches?: FlowStage[] };

type Graph = { nodes: ReadonlyArray<FlowNodeIn>; edges: ReadonlyArray<FlowEdgeIn> };
/** `personal`: a personal Ship (web lib/ship/ownRound.ts), whose bookkeeping before its first stage opens that stage.
 *  `withTargets`: the caller knows where the landed commit went out, so a flow with no Deploy of its own still ends on Deploy and Live. */
export type StagePlanOpts = { personal?: boolean; withTargets?: boolean };

/** The runner's own landing steps (runner.ts): a run that passes one has landed its change. */
export const LANDING_STEP = /(^|__)(shipped|landed)$/;

export const isSubject = (n: FlowNodeIn | undefined) => n?.backend === "subject";
export const inGroup = (stageId: string, nodeId: string) => nodeId === stageId || nodeId.startsWith(`${stageId}${SEGMENT_SEP}`);
export const inStage = (s: { members: ReadonlyArray<string> }, nodeId: string) => s.members.some((m) => inGroup(m, nodeId));

/** Whether a station is the flow's Deploy stage (the deploy segment: it waits for the change to go live). */
const isDeployStage = (n: FlowNodeIn | undefined) => n?.segment_flow === "deploy" || n?.id === "deploy";

/** A route a run takes when a step failed: never the way a passing run goes on. */
const failureRoute = (e: FlowEdgeIn) => /\boutcome\s*(=\s*failure|!=\s*success)\b/.test(e.condition ?? "");

/** The flow's stages, and the stations on its main path (`onPath`: what a stage's way back to the session never passes through). */
export function planStages(graph: Graph, opts: StagePlanOpts = {}): { stages: FlowStage[]; onPath: Set<string> } {
  const folded = foldFlow(graph.nodes, graph.edges);
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const station = new Map(folded.stations.map((s) => [s.id, s]));
  const walk = (folded.path ?? folded.stations.filter((s) => s.main).map((s) => s.id)).filter((id) => station.has(id) && !isSubject(byId.get(id)));
  // The walk ends before a station only a failure reaches (a later deploy after a failed one): a passing run never goes there.
  const failedInto = (id: string, i: number) => {
    const into = graph.edges.filter((e) => segmentTopOf(e.to) === id && walk.slice(0, i).includes(segmentTopOf(e.from)));
    return into.length > 0 && into.every(failureRoute);
  };
  const end = walk.findIndex((id, i) => i > 0 && failedInto(id, i));
  const order = end < 0 ? walk : walk.slice(0, end);
  const at = new Map(order.map((id, i) => [id, i]));
  const stageOf = (members: string[], label: string): FlowStage => ({
    id: members[0],
    label,
    role: members.length === 1 && isDeployStage(byId.get(members[0])) ? "deploy" : "step",
    kind: station.get(members[0])?.kind ?? "agent",
    members,
  });
  const labelOf = (id: string) => station.get(id)?.label ?? id;
  const stages: FlowStage[] = [];
  const taken = new Set<string>();
  // A personal Ship's bookkeeping before its first stage (a round that freezes the change, a read of the docs) opens the
  // stage after it.
  let head: string[] = [];
  const push = (stage: FlowStage) => {
    if (head.length) { stage.members.push(...head); stage.head = head; head = []; }
    stages.push(stage);
  };
  for (const id of order) {
    if (taken.has(id)) continue;
    taken.add(id);
    const s = station.get(id)!;
    if (s.kind === "join") continue;
    const prev = stages[stages.length - 1];
    // Bookkeeping (`fold=true`) is the stage before it finishing its work, not a stage of its own.
    if (byId.get(id)?.fold && (prev || opts.personal)) {
      if (!prev) { head.push(id); continue; }
      prev.members.push(id);
      prev.tail = [...(prev.tail ?? []), id];
      continue;
    }
    if (s.kind !== "parallel") { push(stageOf([id], labelOf(id))); continue; }
    // A fan-out and its branches are one stage, through the join where they meet: what the join sends back is theirs.
    // A branch runs every station the main walk took after its first, up to the join.
    let join: string | undefined;
    const branches = s.next.map((n) => n.toId).filter((t) => station.get(t)?.main && !isSubject(byId.get(t))).map((first) => {
      const members: string[] = [];
      for (let cur: string | undefined = first; cur && !taken.has(cur); ) {
        if (station.get(cur)?.kind === "join") { join ??= cur; break; }
        members.push(cur);
        taken.add(cur);
        const from: string = cur;
        cur = station.get(from)?.next.map((n) => n.toId).find((t) => station.get(t)?.main && (at.get(t) ?? -1) > (at.get(from) ?? -1) && (station.get(t)?.kind === "join" || !taken.has(t)));
      }
      return stageOf(members, members.map(labelOf).join(" → "));
    }).filter((b) => b.members.length);
    if (join) taken.add(join);
    push({ id, label: branches.map((b) => b.label).join(" + "), role: "parallel", kind: "parallel", members: [id, ...branches.flatMap((b) => b.members), ...(join ? [join] : [])], branches });
  }
  // The stage holding the runner's landing step lands the change; with none, no stage claims it.
  const land = stages.findIndex((s) => s.role === "step" && graph.nodes.some((n) => LANDING_STEP.test(n.id) && inStage(s, n.id)));
  if (land >= 0) stages[land] = { ...stages[land], role: "land" };
  const onPath = new Set(folded.path ?? order);
  // Deploy and Live are the flow's own when it has a Deploy step; a flow without one ends where it lands, unless the
  // caller knows where its landed commit went out (deploy reach targets).
  const deploys = stages.some((s) => s.role === "deploy");
  if (!deploys && !opts.withTargets) return { stages, onPath };
  return {
    stages: [
      ...stages,
      ...(deploys ? [] : [{ id: "deploy", label: "Deploy", role: "deploy" as const, kind: "segment", members: [] }]),
      { id: "live", label: "Live", role: "live", kind: "live", members: [] },
    ],
    onPath,
  };
}

/** The flow's stages by name, in path order: what a picker shows beside a flow and the CLI says when a run starts. */
export const stagePathWords = (graph: Graph, opts: StagePlanOpts = {}): string =>
  planStages(graph, opts).stages.map((s) => s.label).join(" → ");
