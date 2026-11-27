// A session's change on its way to live, as stages a person reads at a glance
// (docs/architecture/flows.md FL4, deploys.md): the flow's own stations in the
// order a passing run reaches them (a fan-out's branches folded into one stage
// that holds each), then Deploy and Live. Each stage says who acts there (this
// session, an agent, a person, or nobody: it runs by itself), its state in the
// run's current round, how many rounds it took, and whether it sent work back
// to the session. `now` says who acts at this moment, what every wait waits on,
// and what the person can do about it. Nothing is claimed the run did not
// record: "You" only for an open card the viewer may answer, landed only with a
// merged sha on the run. Pure, with relative imports only: the web's Ship panel
// and run card, the inbox card and the phone's run card all read a run here.
import { passScore, segmentTopOf, SEGMENT_SEP, type FlowEdgeIn, type FlowNodeIn } from "@codecast/shared/contracts/flowPool";
import { inGroup, inStage, isSubject, LANDING_STEP, planStages, type FlowStage, type StageRole } from "@codecast/shared/contracts/flowStagePlan";
import { insideOf, insideOnRun, type RouteBase, type StageInside } from "./segmentInside";
import { landedSha, parentOf, recordedIds } from "./runRecord";
import { stationResult } from "./stationResult";
import { personalRound, shortWhy } from "./personalRound";
import { personalStages } from "./personalJourney";
import { askStopWhy, readableWhy, stopWhy } from "./journeyWords";
import { resumeOf, type ResumeAt } from "./resumeAt";
import { roundsOnOwnResults } from "./ownRound";
import type { SessionAsk } from "./sessionAsk";

export { insideWords, type InsideRoute, type StageInside } from "./segmentInside";

/** `you`: an open card on the stage the viewer may answer; `person`: a person answers there, the viewer or not. */
export type StageWho = "session" | "agent" | "you" | "person" | "auto";
/**
 * `back`: it sent the work back to the session (a red CI, changes asked). `routed`: a step in it failed and the run went
 * on through a route out of it (a script that exits non-zero to choose a path); never a stop. `stopped`: the run ended
 * there. `skipped`: a finished run never entered it. `nothing`: it ran and found nothing to do there, its result's
 * outcome `skipped` (no checks documented, no deploy documented; stationResult.ts).
 */
export type StageState = "idle" | "active" | "back" | "waiting" | "done" | "routed" | "stopped" | "skipped" | "nothing" | "unknown";
export type { StageRole };

export type JourneyStage = {
  /** The station's id in the run's graph; `deploy` and `live` for the two stages after the flow. */
  id: string;
  label: string;
  role: StageRole;
  who: StageWho;
  state: StageState;
  /** Rounds through this stage on a run, when more than one. */
  round: number | null;
  /** The ways this stage sends work back to the session (its findings, its failures), by the fix station's label. */
  loops: Array<{ id: string; label: string; max: number | null }>;
  /** On a run, what each step in it did: its words, its state, its rounds and the session that did it. */
  steps?: StageStep[];
  /** A fan-out's branches, side by side, each with its own state. */
  branches?: JourneyStage[];
  /** A segment's own steps, when it has more than one or routes off them. */
  inside?: StageInside;
  /** What its last step's result said (`note`), and a step it left to the person (`left_for_you`), on a run. */
  note?: string | null;
  left?: string | null;
};

/** `skipped`: it finished and its result said it found nothing to do (stationResult.ts). `earlier`: an own-results
 *  round's step that ran in an earlier round, not this one (personalRound.ts). */
export type StageStep = { id: string; label: string; status: string; visits: number | null; said: string | null; session: { id: string; title: string | null } | null; at: number | null; skipped?: boolean; earlier?: boolean };

/** One thing the run is waiting on: the station, its latest progress line, since it was entered, and its deadline. */
export type JourneyWait = { on: string; line: string | null; since: number | null; deadline: number | null };

/** The one action that can work for a stop: open the run (a deliberate stop that re-running would repeat), the subject
 *  session (it ran out of rounds), the target's deploy, or run it again (an unplanned failure, or one the machine caused). */
export type StopFix = "run" | "session" | "deploy" | "again";

export type JourneyNow =
  | { kind: "idle" }
  | { kind: "starting" }
  | { kind: "working"; stage: string; verb: string | null; role: StageRole; who: StageWho; waits: JourneyWait[]; session: { id: string; title: string | null } | null }
  /** `by`: who sent it back when that is not the stage (a person's card answered with Revise). `blocked`: the session
   *  pinned blocked, so the run waits for a person, `note` then that pin, and `ask` the card it asked with when the
   *  store holds it (sessionAsk.ts). `conversation`: the session. */
  | { kind: "session"; stage: string; note: string; since: number | null; round: number | null; max: number | null; by: string | null; blocked: boolean; ask: SessionAsk | null; conversation: string | null;
      /** What sent the work back when it is no stage's finding (a conflict with main), said in place of "<stage> sent it back". */
      what?: string }
  | { kind: "gate"; stage: string; mine: boolean; holder: "person" | "role"; who: string | null; decisionId: string | null; prompt: string | null; since: number | null }
  /** Merged, and its Deploy not going out yet: held on main's CI, waiting for a person to send it, or for targets that go by themselves. */
  | { kind: "landed"; sha: string; at: number | null; line: string | null; hold: DeployHold; waits: JourneyWait[] }
  | { kind: "unlanded"; why: string; waits: JourneyWait[] }
  | { kind: "deploying"; targets: string[]; line: string | null; waits: JourneyWait[] }
  | { kind: "live"; targets: string[]; line: string | null }
  /** A finished run of a flow with no Deploy of its own: it ends where it lands. `end`: the end a run reached past its
   *  landing short of Live ("Landed", "Deployed, unverified"), said in place of Merged. */
  | { kind: "merged"; sha: string; at: number | null; end?: string; why?: string | null }
  /** A finished run of a flow that lands nothing. */
  | { kind: "passed" }
  /** `briefAt`: when the run last briefed the session it stopped on, so the brief can be found in that session's thread.
   *  `end`: the exit's own name when the run reached it off the main path ("Main stayed red"), which says more than its stage. */
  | { kind: "stopped" | "failed"; stage: string | null; why: string | null; fix: StopFix; session: string | null; briefAt: number | null; end: string | null;
      /** The change is on main already: running it again would land nothing, so the run (or its task) is the way on. */
      landed?: boolean;
      /** The change may be on main (Landing unknown): shipping again could land it twice, so the run is the way on. */
      mayHaveLanded?: boolean;
      /** The station the stop's reason says to resume the run at (Landing unknown, Land cut off: resumeAt.ts). */
      resume?: ResumeAt };

/** `personal`: a personal Ship's run (ownRound.ts), whose bar reads by its own rules. */
export type Journey = { stages: JourneyStage[]; now: JourneyNow; personal?: true };

/** Where the session's landed change stands on each deploy target. */
export type TargetState = { name: string; state: "waiting" | "deploying" | "live" | "failed"; deploy?: string | null; at?: number | null };

type GraphNode = FlowNodeIn & { timeout?: number; machine?: boolean };
type Graph = {
  slug?: string;
  nodes: ReadonlyArray<GraphNode>;
  edges: ReadonlyArray<FlowEdgeIn>;
  /** Each station's settings, where the flow carries them apart from its nodes (a pushed flow's rows). */
  stationDetails?: Record<string, { timeout?: number }> | null;
  /** A personal Ship (ownRound.ts). */
  own_results?: boolean;
  source?: string | null;
};

type NodeStatus = {
  node_id: string;
  status: string;
  visits?: number;
  result_preview?: string | null;
  started_at?: number;
  completed_at?: number;
  activity?: string | null;
  session?: { _id: string; title?: string | null } | null;
};

export type JourneyRun = {
  status: string;
  current_node_id?: string | null;
  fail_reason?: string | null;
  gate_prompt?: string | null;
  gate_decision_id?: string | null;
  gate_decision_status?: string | null;
  gate_node_id?: string | null;
  spawner_conversation_id?: string | null;
  created_at?: number;
  updated_at?: number;
  merge?: { sha: string; at?: number } | null;
  waiting_on_session?: { node_id: string; conversation_id?: string; since: number; note: string; blocked?: boolean } | null;
  node_statuses?: ReadonlyArray<NodeStatus> | null;
};

/** The parts of a decision row that say who may answer it (convex session_decisions). */
export type GateDecision = {
  user_id?: string | null;
  holder?: { kind: "user" | "role"; id: string } | null;
  passed_to?: { kind: "user" | "role"; id: string } | null;
  asked_user_ids?: ReadonlyArray<string> | null;
};

/** Who looks at the run, and the run's open card when the store holds it. */
/** `holder_name`: who answers the open card, by name, when the store knows them. `ask`: what the session the run waits
 *  on asks a person, when it pinned blocked. */
export type JourneyViewer = { id: string | null; decision?: GateDecision | null; holder_name?: string | null; ask?: SessionAsk | null };

/**
 * Whether the viewer may answer a decision: the person it was passed to, else its user holder and the people it was
 * asked of. A role's decision is the role's to answer. Unknown (no row, no viewer) is never yes.
 */
export function canAnswer(d: GateDecision | null | undefined, viewer: string | null | undefined): boolean {
  if (!d || !viewer) return false;
  const to = d.passed_to ?? d.holder ?? null;
  if (to?.kind === "role") return false;
  const people = d.passed_to ? [d.passed_to.id] : [...(to ? [to.id] : []), ...(d.asked_user_ids ?? (d.user_id ? [d.user_id] : []))];
  return people.some((p) => String(p) === viewer);
}

/** Whether a decision waits on a role or on people. */
export const holderOf = (d: GateDecision | null | undefined): "person" | "role" => ((d?.passed_to ?? d?.holder)?.kind === "role" ? "role" : "person");

/** Whether a gate holds the run for an answer: paused on a card nobody has answered. */
export const gateOpen = (run: Pick<JourneyRun, "status" | "gate_decision_id" | "gate_prompt" | "gate_decision_status">) =>
  run.status === "paused" && !!(run.gate_decision_id || run.gate_prompt) && (run.gate_decision_status ?? "pending") === "pending";

/** A step's report that carries the reviewer's ship into its round (the change flow's PR station, prStation.ts). */
const KEPT_SHIP = /"reviewed"\s*:\s*\{[^{}]*"verdict"\s*:\s*"ship"/;

/** A planned stage (flowStagePlan.ts) with who acts there, its ways back to the session and its inside. */
type Base = Omit<FlowStage, "branches"> & Pick<JourneyStage, "who" | "loops"> & { branches?: Base[]; inside?: { path: Base[]; routes: RouteBase[]; end: string | null } };

/** Whether a step is bookkeeping a stage holds around its own work (its head or its tail), not one of its branches. */
const holds = (s: Pick<Base, "head" | "tail">, nodeId: string | null | undefined) => !!nodeId && (!!s.tail?.includes(nodeId) || !!s.head?.includes(nodeId));

/** Who does a station: a person when a passing run is asked there, an agent when any step is a session, else it runs by itself. */
function whoOf(graph: Graph, ids: string[]): StageWho {
  const steps = graph.nodes.filter((n) => ids.some((id) => inGroup(id, n.id)) && n.type !== "exit" && n.type !== "start" && !n.segment_exit);
  const own = steps.length ? steps : graph.nodes.filter((n) => ids.includes(n.id));
  // A person only when one is asked on the way a passing run goes through it, never on a side route inside it.
  if (ids.some((id) => passingSteps(graph, id).some((n) => n.type === "human"))) return "person";
  if (own.some(isSubject)) return "session";
  if (own.some((n) => n.type === "agent" || n.type === "prompt" || n.type === "codergen" || (!!n.backend && n.type !== "command" && !n.segment_entry))) return "agent";
  return "auto";
}

const WHO_RANK: StageWho[] = ["person", "agent", "session", "auto"];

/**
 * The steps a passing run takes through a station: the station alone, or for a segment its entry and then, step by
 * step, the route that passes (as foldFlow ranks them), never into an exit or a stop. A card a segment reaches only on
 * a side route is not on it.
 */
function passingSteps(graph: Graph, id: string): FlowNodeIn[] {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const walked: FlowNodeIn[] = [];
  const seen = new Set<string>();
  for (let cur: string | undefined = id; cur && !seen.has(cur); ) {
    seen.add(cur);
    const n = byId.get(cur);
    if (n) walked.push(n);
    const from: string = cur;
    cur = graph.edges
      .filter((e) => e.from === from && e.to !== id && inGroup(id, e.to) && !seen.has(e.to) && byId.get(e.to)?.type !== "exit" && byId.get(e.to)?.segment_exit !== "stop")
      .sort((a, b) => passScore(b) - passScore(a))[0]?.to;
  }
  return walked;
}

/** The flow's stages on its main path, in the order a passing run reaches them, then Deploy and Live. `nested`: a
 *  segment's own steps, whose segments read as one step each. */
function planOf(graph: Graph, withTargets = false, nested = false): Base[] {
  const personal = roundsOnOwnResults(graph);
  const { stages, onPath } = planStages(graph, { personal, withTargets });
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  // A stage's ways back to the session: the subject stations its edges reach, directly or through side steps on no
  // stage (a brief written before the session hears it), never through a stage or an exit.
  const loopsOf = (members: string[]) => {
    const found: FlowNodeIn[] = [];
    const seen = new Set(members);
    for (let frontier = members; frontier.length; ) {
      const next: string[] = [];
      for (const e of graph.edges) {
        if (!frontier.includes(segmentTopOf(e.from))) continue;
        const to = segmentTopOf(e.to);
        const n = byId.get(to);
        if (isSubject(n)) { if (!found.includes(n!)) found.push(n!); continue; }
        if (seen.has(to) || onPath.has(to) || n?.type === "exit") continue;
        seen.add(to);
        next.push(to);
      }
      frontier = next;
    }
    return found.map((n) => ({ id: n.id, label: n.label, max: n.max_visits ?? null }));
  };
  // Who acts at a stage and its inside are read off its own stations, never the bookkeeping it holds around them.
  const decorate = ({ branches: planned, ...s }: FlowStage): Base => {
    const branches = planned?.map(decorate);
    const own = s.members.filter((m) => !s.head?.includes(m) && !s.tail?.includes(m));
    const inside = !nested && s.role !== "parallel" && own.length === 1 ? insideOf(graph, own[0], INSIDE_READERS) : undefined;
    // The Deploy stage only waits: each target goes out by its own policy, and a press is the Deploys page's. The
    // personal Ship's Deploy is an agent that deploys itself, by the project's docs.
    const who: StageWho = branches ? WHO_RANK.find((w) => branches.some((b) => b.who === w)) ?? "auto"
      : s.role === "live" || (s.role === "deploy" && !(personal && byId.get(own[0])?.type === "agent")) ? "auto"
      : whoOf(graph, own);
    return { ...s, ...(inside ? { inside } : {}), ...(branches ? { branches } : {}), who, loops: loopsOf(s.members) };
  };
  return stages.map(decorate);
}

const idleStage = (b: Base): JourneyStage => ({ ...strip(b), state: "idle", round: null });
/** What a segment's inside reads of the journey: its own stages, whose segments read as one step each, and who acts. */
const INSIDE_READERS = { plan: (g: Graph) => planOf(g, false, true), who: whoOf, passing: passingSteps };

const strip = ({ members: _m, kind: _k, tail: _t, head: _h, branches, inside, ...s }: Base): Omit<JourneyStage, "state" | "round"> => ({
  ...s,
  ...(branches ? { branches: branches.map(idleStage) } : {}),
  ...(inside ? { inside: { ...inside, path: inside.path.map(idleStage), routes: inside.routes.map((r) => ({ ...r, state: "idle" as const, steps: r.steps.map((st) => ({ ...st, state: "idle" as const })) })) } } : {}),
});

/** The flow's stages on its main path, in execution order, then its Deploy and Live. */
export function journeyStages(graph: Graph): Omit<JourneyStage, "state" | "round">[] {
  return planOf(graph).map(strip);
}

/** The stages that hold any of these stations, by label, once each and in path order. */
export function stagesHolding(graph: Graph, nodeIds: ReadonlyArray<string>): string[] {
  return planOf(graph).filter((s) => nodeIds.some((id) => inStage(s, id))).map((s) => s.label);
}

const LIVE_STATUSES = new Set(["pending", "running", "paused"]);

/** A step's latest words a person can read: its live activity, else its output (a result JSON's note), never machine output (a JSON report). */
const lineOf = (n: NodeStatus | undefined, own: boolean) => {
  const said = n?.activity?.trim() || (own ? stationResult(n?.result_preview)?.note : null) || n?.result_preview?.trim() || null;
  return said && !/^\s*[{[]/.test(said) ? said : null;
};

/** What CI and the reviewer found this round, as a verdicts step reports it. */
export type Verdicts = { ci: "green" | "red" | "blocked_by_main" | "timed_out" | null; review: "ship" | "changes" | "rejected" | "missing" | "stale" | null };

/**
 * The round's verdicts from a step's output, when the step is the one that routes on them (its report names `next`):
 * `ci` and `review` as words, or as the objects they were before (`ci.green` / `ci.blocked_by_main`, `review.verdict`).
 * Read by pattern, so an output cut short still says what it reached. Null for any other step.
 */
export function verdictsOf(said: string | null | undefined): Verdicts | null {
  if (!said || !/"next"\s*:/.test(said)) return null;
  const ciWord = said.match(/"ci"\s*:\s*"(green|red|blocked_by_main|timed_out)"/)?.[1] as Verdicts["ci"] | undefined;
  const ciObj = said.match(/"ci"\s*:\s*\{([^{}]*)\}/)?.[1];
  const ci: Verdicts["ci"] = ciWord ?? (ciObj
    ? /"blocked_by_main"\s*:\s*true/.test(ciObj) ? "blocked_by_main" : /"timed_out"\s*:\s*true/.test(ciObj) ? "timed_out" : /"green"\s*:\s*true/.test(ciObj) ? "green" : /"green"\s*:\s*false/.test(ciObj) ? "red" : null
    : null);
  const review = (said.match(/"review"\s*:\s*"(ship|changes|rejected|missing|stale)"/)?.[1] ?? said.match(/"review"\s*:\s*\{[^{}]*"verdict"\s*:\s*"(ship|changes|rejected)"/)?.[1] ?? null) as Verdicts["review"];
  return ci || review ? { ci, review } : null;
}

/**
 * Where a landed change's Deploy stands, read from its line (`cast flow await-deploy`): going out, held on main's CI
 * that is red (the line's own "(red …)"), waiting on main's CI that is still running or not there yet, waiting for a
 * person or a named role to send it (`by`), or waiting on targets that go out by themselves.
 */
export type DeployHold = { kind: "out" | "red" | "ci" | "press" | "wait"; by: string | null };
export function deployHold(line: string | null | undefined): DeployHold {
  const hold = (kind: DeployHold["kind"], by: string | null = null): DeployHold => ({ kind, by });
  if (!line) return hold("wait");
  if (/\bdp-\d+ sending\b|going out in dp-/.test(line)) return hold("out");
  if (/waiting on main CI at \w+ \(red\b/.test(line)) return hold("red");
  if (/waiting on main CI|once main CI is green|waiting for main CI/.test(line)) return hold("ci");
  const named = line.match(/waiting for (.+?) to send it/)?.[1];
  if (named) return hold("press", named);
  if (/waiting for (a press|a person)|on a press/.test(line)) return hold("press");
  return hold("wait");
}

/**
 * Whether a landing step that passed put the change on main when no sha was recorded (`ship__shipped` reports only its
 * exit). A landing step counts only where no merge or push station can follow it (Union's one-session fix flow has a
 * `shipped` that runs before its Land merges), and only until Deploy finds the change not on main: an `unmerged` step
 * of the Deploy stage entered after the latest landing (a flow's own `unmerged` that routes back to landing is not one).
 */
function landedByStep(graph: Graph, plan: ReadonlyArray<Base>, statuses: ReadonlyArray<NodeStatus>, at: string | null): boolean {
  const next = new Map<string, string[]>();
  for (const e of graph.edges) next.set(e.from, [...(next.get(e.from) ?? []), e.to]);
  const merges = (from: string) => {
    const seen = new Set([from]);
    const queue = [...(next.get(from) ?? [])];
    while (queue.length) {
      const id = queue.shift()!;
      if (seen.has(id)) continue;
      seen.add(id);
      if (/^(merge|push)$/.test(id.split(SEGMENT_SEP).pop()!)) return true;
      queue.push(...(next.get(id) ?? []));
    }
    return false;
  };
  const landing = statuses.filter((n) => n.status === "completed" && LANDING_STEP.test(n.node_id) && !merges(n.node_id)).sort((a, b) => (b.started_at ?? 0) - (a.started_at ?? 0))[0];
  if (!landing) return false;
  const deploy = plan.find((s) => s.role === "deploy");
  const unmerged = (id: string) => /(^|__)unmerged$/.test(id) && !!deploy && inStage(deploy, id);
  if (at && unmerged(at)) return false;
  return !statuses.some((n) => unmerged(n.node_id) && (n.started_at ?? 0) >= (landing.started_at ?? 0));
}

/** The journey of a flow, on a run when there is one, with where its landed change is on each deploy target. */
export function journeyOf(graph: Graph, run: JourneyRun | null | undefined, targets: ReadonlyArray<TargetState> = [], viewer: JourneyViewer | null = null): Journey {
  const plan = planOf(graph, targets.length > 0);
  const idle = (b: Base): JourneyStage => ({ ...strip(b), state: "idle", round: null, ...(b.branches ? { branches: b.branches.map(idle) } : {}) });
  if (!run) return { stages: plan.map(idle), now: { kind: "idle" } };
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const idOf = recordedIds(graph, run);
  const statuses = (run.node_statuses ?? []).map((n) => (idOf(n.node_id) === n.node_id ? n : { ...n, node_id: idOf(n.node_id) }));
  const statusOf = (id: string | null | undefined) => (id ? [...statuses].reverse().find((n) => n.node_id === id) : undefined);
  const newest = (list: NodeStatus[]) => list.reduce<NodeStatus | undefined>((best, n) => (!best || (n.started_at ?? 0) >= (best.started_at ?? 0) ? n : best), undefined);
  const live = LIVE_STATUSES.has(run.status);
  const passed = run.status === "completed";
  const failed = run.status === "failed";
  // An own-results round (the personal Ship) reads its run through one view of its current round (personalRound.ts),
  // which the diagram, a station's panel and the run report read too; it landed at its latest Land result's sha.
  const view = personalRound(graph, run);
  const sha = view?.landed ?? landedSha(run);
  const waitingOn = run.waiting_on_session ? { ...run.waiting_on_session, node_id: idOf(run.waiting_on_session.node_id) } : null;
  const at = run.current_node_id ? idOf(run.current_node_id) : null;
  // Once the run ended: while it runs, Deploy's own wait (await-deploy finding the commit on main) is the word on it.
  const landedStep = !sha && !live && landedByStep(graph, plan, statuses, at);
  const flowStages = plan.filter((s) => s.role !== "live" && s.members.length);
  const stageOf = (nodeId: string | null) => (nodeId ? flowStages.find((s) => inStage(s, nodeId)) ?? null : null);
  // A fix station belongs to the stage that sent the work back.
  const backFrom = (nodeId: string | null) => (nodeId ? plan.find((s) => s.loops.some((l) => l.id === segmentTopOf(nodeId))) ?? null : null);
  // The step a run reached a node from: the newest one with an edge into it.
  const routedFrom = (nodeId: string, seen: Set<string>): NodeStatus | undefined => newest(statuses.filter((s) => !seen.has(s.node_id) && byId.get(s.node_id)?.type !== "exit"
    && graph.edges.some((e) => e.to === nodeId && (e.from === s.node_id || segmentTopOf(e.from) === segmentTopOf(s.node_id)))));
  // The stage a node belongs to: its own, the one whose way back it is, else the one the run came from, walking back
  // through the steps off the main path (an exit, a wait for main, a card's segment) until a stage holds one.
  const stageFor = (nodeId: string | null): Base | null => {
    const seen = new Set<string>();
    for (let cur = nodeId; cur && !seen.has(cur); ) {
      seen.add(cur);
      const own = stageOf(cur) ?? backFrom(cur);
      if (own) return own;
      cur = routedFrom(cur, seen)?.node_id ?? null;
    }
    return null;
  };
  // The steps between a node and the stage it belongs to, nearest first: what the run walked through off the main path.
  const chain = (nodeId: string | null): string[] => {
    const out: string[] = [];
    for (let cur = nodeId; cur && !out.includes(cur) && !stageOf(cur); cur = routedFrom(cur, new Set(out))?.node_id ?? null) out.push(cur);
    return out;
  };
  // What the run did off the main path, in its own words: the label of the route a stage took into it ("It edits CI"),
  // else the first off-path step's own label.
  const offPathLabel = (nodeId: string): string | null => {
    const first = chain(nodeId).filter((id) => byId.get(id)?.type !== "exit").pop();
    if (!first) return null;
    const route = graph.edges.find((e) => e.to === first && e.label && stageOf(e.from))?.label;
    return route ? route.charAt(0).toUpperCase() + route.slice(1) : byId.get(first)?.label ?? null;
  };
  // Whether a person sent the work back to the session at `nodeId`: the last step the run took before it, past the ends it
  // went out through (a step whose every way on leaves the segment it sits in), is a person's. A segment's own Brief
  // inside the same segment as a card is not the card's.
  const endStep = (id: string) => { const out = graph.edges.filter((e) => e.from === id); return out.length > 0 && out.every((e) => parentOf(e.to) !== parentOf(id)); };
  const byPerson = (nodeId: string | null) => {
    const since = statusOf(nodeId)?.started_at ?? Infinity;
    const before = statuses.filter((n) => (n.started_at ?? 0) <= since && !isSubject(byId.get(n.node_id)) && !endStep(n.node_id));
    return byId.get(newest(before)?.node_id ?? "")?.type === "human";
  };
  const backStage = live ? (backFrom(waitingOn?.node_id ?? null) ?? backFrom(at))?.id ?? null : null;
  const atBase = stageFor(at);
  const atStage = live ? atBase?.id ?? null : null;
  // A stop in the landing stage's bookkeeping after the merge was recorded is past the landing: the change is on main,
  // so the stop is the next stage's, before anything went out. A personal Ship's round view says where it stopped.
  const pastLanding = !view && failed && !!sha && atBase?.role === "land" && !!at && !!atBase.tail?.includes(at);
  const stopStage = failed ? (pastLanding ? plan[plan.indexOf(atBase!) + 1]?.id ?? atBase!.id : atBase?.id ?? null) : null;
  // An open card is a gate wherever its node sits: on a stage when the walk back finds one, else in the bar alone.
  const open = live && gateOpen(run);
  const gateNode = open ? (run.gate_node_id ? idOf(run.gate_node_id) : at) : null;
  const gateStage = open ? stageFor(gateNode)?.id ?? null : null;
  const gateMine = open && canAnswer(viewer?.decision, viewer?.id);
  // A card off the main path names the stage that holds it after the route into it ("It edits CI"), not the stage's own name.
  const gateOff = gateNode && !stageOf(gateNode) ? offPathLabel(gateNode) : null;
  // Where the run stands: stages after it hold only what earlier rounds left, which is not this round's state.
  const current = plan.findIndex((s) => s.id === (backStage ?? gateStage ?? atStage ?? stopStage));

  // The round's verdicts, once the step that routes on them has run after the fan-out's branches last started.
  const fan = plan.find((s) => s.branches);
  const fanStart = fan ? Math.max(0, ...statuses.filter((n) => fan.branches!.some((b) => inStage(b, n.node_id))).map((n) => n.started_at ?? 0)) : 0;
  // A round that routes on its branches' own results (ownRound.ts, the personal Ship): a script branch is reported only
  // when it finishes, and keeps its first visit's start, so a branch's report belongs to this round only when it finished
  // after the fan-out was last entered; before that, the branch is still running (or, outside the fan-out, not yet run).
  const own = !!view;
  const roundStart = view ? view.start : fanStart;
  const ofRound = (n: NodeStatus | undefined) => !!n && !!view?.ofRound(n.node_id);
  const verdictStep = newest(statuses.filter((n) => verdictsOf(n.result_preview)));
  const verdicts = verdictStep && (verdictStep.started_at ?? 0) >= fanStart ? verdictsOf(verdictStep.result_preview) : null;

  const timeoutOf = (id: string) => byId.get(id)?.timeout ?? graph.stationDetails?.[id]?.timeout ?? null;
  const waitOf = (on: string, n: NodeStatus | undefined): JourneyWait => {
    const timeout = n ? timeoutOf(n.node_id) : null;
    const since = n?.started_at ?? null;
    return { on, line: lineOf(n, own), since, deadline: since && timeout ? since + timeout * 1000 : null };
  };

  // The flow's own Deploy stage waits for the change to go live and says so in its step's latest line.
  const deployStage = plan.find((s) => s.role === "deploy");
  const ownDeploy = !!deployStage?.members.length;
  const deployNode = ownDeploy ? [...statuses].reverse().find((n) => inStage(deployStage!, n.node_id) && !!lineOf(n, own)) : undefined;
  const line = lineOf(deployNode, own);
  const deploying = targets.filter((t) => t.state === "deploying");
  const liveOn = targets.filter((t) => t.state === "live");
  // A flow's own Deploy passes only once the change is live, but a run can also complete with nothing merged (the change
  // was already upstream): that is Done, never Live.
  const allLive = ownDeploy ? passed && (!!sha || !plan.some((s) => s.role === "land")) : !!sha && targets.length > 0 && liveOn.length === targets.length;
  // A step off every stage the run went to from Deploy's fix (the personal Ship's After the fix) is not Deploy deploying.
  const offPath = !!at && !stageOf(at) && !backFrom(at);
  // An own-results stage is at work only while a station of it runs (personalRound.ts), never because the run's current
  // node still names a station that has reported its end.
  const atWork = (b: Base) => b.members.some((m) => view?.station(m).state === "running");
  const atDeploy = live && !!deployStage && atStage === deployStage.id && !(own && offPath) && (!own || atWork(deployStage));
  // A Deploy that is an agent deploys the change itself while it runs: it is going out, never waiting for a press.
  const deploysItself = own && ownDeploy && byId.get(deployStage!.id)?.type === "agent";
  const hold: DeployHold = atDeploy ? deployHold(line) : { kind: deploying.length ? "out" : "wait", by: null };
  const deployWaits = () => [waitOf(deployStage!.label, statusOf(at) ?? deployNode)];

  const labelOf = (id: string) => byId.get(id)?.label ?? id;
  // A stage's own steps: a segment's entry and its ends are the stage itself and its outcome, which the track and the bar already say.
  const isEntry = (id: string) => graph.nodes.some((x) => x.id.startsWith(`${id}${SEGMENT_SEP}`));
  const isEnd = (id: string) => { const n = byId.get(id); return !!n && (n.type === "exit" || !!n.segment_exit); };
  const stepsOf = (b: Base): StageStep[] => {
    const steps: StageStep[] = statuses
      .filter((n) => (inStage(b, n.node_id) && !isEntry(n.node_id) && !isEnd(n.node_id)) || b.loops.some((l) => l.id === n.node_id))
      .map((n) => ({ id: n.node_id, label: labelOf(n.node_id), status: n.status, visits: n.visits ?? null, said: n.result_preview?.trim() || n.activity || null, session: n.session ? { id: String(n.session._id), title: n.session.title ?? null } : null, at: n.started_at ?? null }));
    return personal ? personal.steps(b, steps) : steps;
  };
  // What a stage's steps did last (one entry per node: its latest visit); a segment's entry only routes into its steps.
  const latestOf = (b: Base) => newest(statuses.filter((n) => inStage(b, n.node_id) && !(b.members.includes(n.node_id) && isEntry(n.node_id))));
  // An own-results round's stages, branches and steps are its stations as its round's view says (personalJourney.ts).
  const personal = view ? personalStages(view, { statuses, statusOf, newest, inStage, latestOf, live, passed, paused: run.status === "paused" }) : null;
  const ranAs = (b: Base, state: StageState): Pick<JourneyStage, "state" | "note" | "left"> => personal?.ranAs(b, state) ?? { state };
  // A run that ended past its landing short of Live says where it ended: at an end of its own ("Deployed, unverified",
  // "Landed"), or with a Deploy that found no deploy documented. Read from the end it reached, never from passing alone.
  const ended = passed && at ? byId.get(at) : undefined;
  const offEnd = own && ended?.type === "exit" && !ended.segment && !ended.stop && ended.label !== "Live" ? ended.label : null;
  const shortOfLive = ownDeploy && passed && (!!offEnd || !!personal?.ranEmpty(deployStage!));

  const stateOf = (b: Base, index: number): StageState => {
    if (b.id === backStage) return "back";
    if (b.id === gateStage) return "waiting";
    if (personal) return personal.stage(b, stopStage);
    if (b.id === stopStage) return "stopped";
    if (!passed && current >= 0 && index > current) return "idle";
    // A fan-out's own state comes from its branches, except while the run stands at a step it holds after them.
    if (live && b.id === atStage && (!b.branches || holds(b, at))) return run.status === "paused" ? "waiting" : "active";
    const last = latestOf(b);
    if (!last) return passed ? "skipped" : "idle";
    if (last.status === "running" || last.status === "pending") return live ? "active" : "idle";
    // A landing stage with the merge recorded, or whose landing step passed (landedByStep), landed, whatever its
    // bookkeeping did after.
    if (b.role === "land" && (sha || landedStep)) return "done";
    if (last.status === "failed") return "routed";
    // A landing stage that went on with no merged sha recorded did not land anything.
    if (b.role === "land") return "routed";
    return "done";
  };
  // A branch says what its verdict says, once the round has one: red CI and changes asked sent the work back, a CI held
  // by main's red waits for main. Before the verdict a branch is running or idle, never a check from its exit alone.
  const branchState = (br: Base): StageState => {
    if (personal) return personal.branch(br);
    const last = latestOf(br);
    if (last?.status === "running" || last?.status === "pending") return live ? "active" : "idle";
    const said = br.who === "agent" ? verdicts?.review : verdicts?.ci;
    if (said === "green" || said === "ship") return "done";
    if (said === "red" || said === "timed_out" || said === "changes" || said === "stale") return "back";
    if (said === "blocked_by_main") return live ? "waiting" : "routed";
    if (said === "rejected") return failed ? "stopped" : "back";
    if (said === "missing") return "routed";
    // A round on a head the reviewer already said ship on asks no reviewer (the change flow's pr.json `reviewed`):
    // until Verdicts speaks, its Review reads as that ship, not as a reviewer yet to start.
    if (br.who === "agent" && statuses.some((n) => KEPT_SHIP.test(n.result_preview ?? "") && (n.started_at ?? 0) > (last?.started_at ?? 0))) return "done";
    return passed && last ? "done" : passed ? "skipped" : "idle";
  };
  // A segment's inside on the run (segmentInside.ts insideOnRun). A stage after where the run stands holds nothing of this round.
  const insideOn = (b: Base, index: number): StageInside => insideOnRun(b.inside!, {
    statuses, here: gateNode ?? (live ? at : null), gate: !!gateNode, paused: run.status === "paused", live,
    later: !passed && current >= 0 && index > current, back: b.id === backStage, gateWho: gateMine ? "you" : "person",
  }, idleStage);
  const stageOn = (b: Base, index: number): JourneyStage => {
    const mine = statuses.filter((n) => inStage(b, n.node_id));
    const rounds = Math.max(0, ...mine.map((n) => n.visits ?? 1));
    // An open card says who may answer it: the viewer, or someone else.
    const who: StageWho = b.id === gateStage ? (gateMine ? "you" : "person") : b.who;
    const base = { ...strip(b), ...(b.id === gateStage && gateOff ? { label: gateOff } : {}), who, steps: stepsOf(b), round: rounds > 1 ? rounds : null, ...(b.inside ? { inside: insideOn(b, index) } : {}) };
    if (b.role === "live") return { ...base, state: allLive && !shortOfLive ? "done" : passed ? "skipped" : "idle" };
    if (b.role === "deploy") {
      // While the session fixes the deploy, the work is back with it, not deploying.
      const state: StageState = own ? stateOf(b, index)
        : allLive ? "done"
        : atDeploy ? (sha && (hold.kind === "out" || deploysItself) ? "active" : "waiting")
        : stopStage === b.id ? "stopped"
        : !ownDeploy && passed && sha ? (hold.kind === "out" ? "active" : targets.some((t) => t.state === "failed") ? "stopped" : "waiting")
        : passed ? "skipped"
        : "idle";
      return { ...base, ...(ownDeploy ? ranAs(b, state) : { state }) };
    }
    if (!b.branches) return { ...base, ...ranAs(b, stateOf(b, index)) };
    const ownState = stateOf(b, index);
    const later = !passed && current >= 0 && index > current;
    // A new round opening the stage (its head) holds nothing of this round's branches yet.
    const opening = live && !!b.head && holds({ head: b.head }, at);
    const branches = b.branches.map((br) => {
      const state = later || opening ? "idle" : branchState(br);
      // An own-results branch not reported this round carries nothing of the last one.
      return { ...stageOn(br, index), note: undefined, left: undefined, ...(own && !ofRound(latestOf(br)) ? { state } : ranAs(br, state)) };
    });
    // A stop inside a fan-out is the branch whose step failed last (or still ran); its siblings keep their own state.
    if (b.id === stopStage) {
      const culprit = b.branches.findIndex((br) => latestOf(br)?.status === "failed");
      if (culprit >= 0) branches[culprit] = { ...branches[culprit], state: "stopped" };
    }
    const has = (s: StageState) => branches.some((br) => br.state === s);
    const ran = !later && statuses.some((n) => inStage(b, n.node_id) && (n.started_at ?? 0) >= roundStart);
    // An own-results round's fan-out is as its round's view says, active while the steps that open it run.
    if (own) return { ...base, state: later ? "idle" : opening && ownState === "idle" ? "active" : ownState, branches };
    const state: StageState = ownState === "waiting" || ownState === "stopped" || later || (ownState === "active" && holds(b, at)) ? ownState
      : has("stopped") ? "stopped"
      : ownState === "back" || has("back") ? "back"
      : branches.every((br) => br.state === "nothing") ? "nothing"
      : branches.every((br) => br.state === "done" || br.state === "nothing") ? "done"
      : branches.every((br) => br.state === "skipped") ? "skipped"
      // Still this round's work while the run goes on; a run that ended mid-way leaves it neither passed nor stopped.
      : live && (has("active") || has("waiting") || ran) ? "active"
      : ran ? "routed"
      : "idle";
    return { ...base, state, branches };
  };
  const stages = plan.map(stageOn);

  const stageLabel = (id: string | null) => (id ? stages.find((s) => s.id === id)?.label ?? id : null);
  // A station that submits the change for checks running side by side opens it (the PR before CI and review); one that
  // runs into the landing stage merges. Read from where a station sits, never from its name.
  const verbOf = (stage: JourneyStage | undefined, offMain: string | null): string | null => {
    if (!stage) return null;
    if (offMain) return offMain;
    const i = stages.indexOf(stage);
    const kind = plan[i]?.kind;
    // A personal Ship pushes to main itself, with no merge step: it lands.
    if (stage.role === "land" || (kind === "script" && stages[i + 1]?.role === "land")) return own ? "Landing" : "Merging";
    if (i === 0 && kind === "script" && stages[1]?.role === "parallel") return `Opening ${stage.label}`;
    return null;
  };
  let now: JourneyNow;
  if (run.status === "pending") now = { kind: "starting" };
  else if (live && backStage) {
    const loop = plan.find((s) => s.id === backStage)!.loops.find((l) => l.id === segmentTopOf(waitingOn?.node_id ?? at ?? ""));
    const node = statusOf(waitingOn?.node_id ?? at);
    // A card the session asked with and that a person has since answered ends the wait on a person: the session goes on.
    const ask = waitingOn?.blocked ? viewer?.ask ?? null : null;
    const blocked = !!waitingOn?.blocked && ask?.open !== false;
    // A fix for what no stage found (the round's own step: a conflict with main) is said by the route that sent it.
    const fromHead = !!view?.fixing?.from && !!plan.find((s) => s.id === backStage)?.head?.includes(view.fixing.from);
    const route = fromHead ? graph.edges.find((e) => e.from === view!.fixing!.from && e.to === view!.fixing!.station)?.label : null;
    now = { kind: "session", stage: stageLabel(backStage)!, note: readableWhy(waitingOn?.note) ?? "", since: waitingOn?.since ?? node?.started_at ?? null, round: node?.visits || null, max: loop?.max ?? null, by: byPerson(waitingOn?.node_id ?? at) ? "the person" : null, blocked, ask: blocked ? ask : null, conversation: waitingOn?.conversation_id ?? null,
      ...(route ? { what: route.charAt(0).toUpperCase() + route.slice(1) } : {}) };
  } else if (open) {
    // The card's own step names the bar when it sits off every stage (a card a script asked for); on a stage, the stage.
    const onStage = gateNode ? stageOf(gateNode) : null;
    now = { kind: "gate", stage: onStage ? stageLabel(onStage.id)! : labelOf(gateNode ?? ""), mine: gateMine, holder: holderOf(viewer?.decision), who: viewer?.holder_name ?? null, decisionId: run.gate_decision_id ?? null, prompt: run.gate_prompt?.split("\n")[0] ?? null, since: statusOf(gateNode)?.started_at ?? null };
  } else if (atDeploy) {
    // With no merge recorded yet (one merged by its own script, a run from an older CLI) the bar says the wait and
    // claims neither landed nor not landed: the wait itself records the merge once it finds it on main.
    now = !sha ? { kind: "working", stage: deployStage!.label, verb: null, role: "deploy", who: "auto", waits: deployWaits(), session: null }
      : hold.kind === "out" || deploysItself ? { kind: "deploying", targets: [], line, waits: deployWaits() }
      : { kind: "landed", sha, at: run.merge?.at ?? null, line, hold, waits: deployWaits() };
  } else if (live) {
    const stage = stages.find((s) => s.id === atStage);
    const node = statusOf(at);
    // A station off the main path (a retest, a wait for main) reads as itself, inside the stage the run came from.
    // A step an own-results round runs after the session's fix (the way it came is from a fix) reads as checking that
    // fix, never as the stage it came from.
    const cameFrom = graph.edges.filter((e) => e.to === at).map((e) => segmentTopOf(e.from)).filter((id) => statusOf(id)).sort((a, b) => (statusOf(b)!.started_at ?? 0) - (statusOf(a)!.started_at ?? 0))[0];
    const fixCheck = own && offPath && isSubject(byId.get(cameFrom ?? ""));
    const offMain = fixCheck ? "Checking the fix" : offPath ? labelOf(at!) : null;
    // A fan-out waits on each branch still running; any other stage on the step it stands at.
    const fanBase = stage?.branches ? plan[stages.indexOf(stage)] : null;
    // A step the stage holds after its branches (its verdicts) is waited on as the branches it reads; one that opens a
    // round (its head) is bookkeeping of the stage, which the bar names alone.
    const atTail = !!fanBase?.tail && holds({ tail: fanBase.tail }, at);
    const atHead = !!fanBase?.head && holds({ head: fanBase.head }, at);
    const waits = fanBase && !offMain
      ? atHead ? [] : atTail ? fanBase.branches!.map((b) => waitOf(b.label, node))
      // An own-results round's script branch runs unreported: it is waited on from when the round entered the fan-out.
      : own ? fanBase.branches!.filter((b) => branchState(b) === "active").map((b) => waitOf(b.label, ofRound(latestOf(b)) ? latestOf(b) : statusOf(fanBase.id)))
      : fanBase.branches!.filter((b) => latestOf(b)?.status === "running").map((b) => waitOf(b.label, latestOf(b)))
      : [waitOf(offMain ?? stage?.label ?? labelOf(at ?? ""), node)];
    now = { kind: "working", stage: offMain ?? stage?.label ?? (at ? labelOf(at) : "Running"), verb: verbOf(stage, offMain), role: stage?.role ?? "step", who: stage?.who ?? "auto", waits, session: node?.session ? { id: String(node.session._id), title: node.session.title ?? null } : null };
  } else if (failed) {
    const stage = stages.find((s) => s.id === stopStage);
    const walked = chain(at);
    const exit = at ? byId.get(at) : undefined;
    const atExit = exit?.type === "exit" && !exit.segment;
    // A deliberate stop (an exit that says why, or the runner's "Stopped:") repeats if run again; only an unplanned failure,
    // or one the machine caused, is worth another run. An exit whose words the app could not read (a flow whose source only
    // extends another file, as Union's change.cast does: stored nodes carry no `stop`) is judged by the runner's "Stopped:",
    // which it writes only at an exit with `stop` (ct-102100).
    const deliberate = atExit && exit?.stop ? !exit.machine : !!run.fail_reason?.startsWith("Stopped");
    const subject = [at, ...walked].find((id) => id && isSubject(byId.get(segmentTopOf(id))));
    // A Deploy that deploys itself has no deploy targets to open: the run is where to look, or Ship again.
    // Once the change is on main, running it again would land nothing: the run is the way on, never Ship again.
    const landedAlready = own && !!view?.landed;
    const landUnknown = own && plan.some((b) => b.role === "land" && view!.station(b.id).state === "unknown");
    const resume = own ? resumeOf(run, graph.nodes) : null;
    const fix: StopFix = landedAlready && stage?.role !== "deploy" ? (subject ? "session" : "run")
      : stage?.role === "deploy" && deploysItself ? (deliberate || landedAlready ? "run" : "again")
      : stage?.role === "deploy" ? "deploy"
      : subject ? "session"
      : deliberate ? "run"
      : "again";
    // Not merged is said only of a run that ended where its change should have been on main (Deploy found no merge).
    if (!sha && !landedStep && stage?.role === "deploy") now = { kind: "unlanded", why: (own ? stopWhy(run.fail_reason) : readableWhy(run.fail_reason)) ?? "The run ended with no merge recorded", waits: [] };
    // An own-results round's stops are ends of their own, each said by its name with its reason (a result's note, a
    // rejection's findings), never as where on the track it stopped.
    else now = { kind: run.fail_reason?.startsWith("Stopped") || atExit ? "stopped" : "failed", stage: stageLabel(stopStage), why: own ? stopWhy(run.fail_reason) : askStopWhy(run.fail_reason) ?? readableWhy(run.fail_reason), fix, session: run.spawner_conversation_id ? String(run.spawner_conversation_id) : null, briefAt: subject ? statusOf(subject)?.started_at ?? null : null, end: atExit && ((own && !!exit?.stop) || walked.some((id) => id !== at && byId.get(id)?.type !== "exit")) ? exit?.label ?? null : null,
      ...(landedAlready || landedStep ? { landed: true } : {}), ...(landUnknown ? { mayHaveLanded: true } : {}), ...(resume ? { resume } : {}) };
  } else if (allLive && shortOfLive) now = sha ? { kind: "merged", sha, at: run.merge?.at ?? null, end: offEnd ?? "Landed", ...(view && deployStage ? { why: shortWhy(statusOf(deployStage.id)?.result_preview, sha) } : {}) } : { kind: "passed" };
  else if (allLive) now = { kind: "live", targets: liveOn.map((t) => t.name), line };
  else if (!plan.some((s) => s.role === "land")) now = { kind: "passed" };
  // A finished run with no merge on it (a merge nobody recorded) says it finished, never that it did not land.
  else if (!sha) now = { kind: "passed" };
  // A flow with no Deploy of its own ends where it lands; with deploy reach, it goes on to its targets.
  else if (!deployStage) now = { kind: "merged", sha, at: run.merge?.at ?? null };
  else if (hold.kind === "out") now = { kind: "deploying", targets: deploying.map((t) => t.name), line, waits: [] };
  else now = { kind: "landed", sha, at: run.merge?.at ?? null, line, hold, waits: [] };
  return { stages, now, ...(view ? { personal: true as const } : {}) };
}

/** Whether a run is still in flight: the session's Ship control shows it rather than offering another. */
export const runIsLive = (run: { status: string } | null | undefined) => !!run && LIVE_STATUSES.has(run.status);

/**
 * The targets a Deploy stage's line names (`cast flow await-deploy`): while it waits, one `<target>: <state>` per
 * target ("backend: live in dp-12; cli: dp-13 sending 4a6e413 (6m of 60m); web: waiting for its push deploy ..."),
 * and once done "Live: 4a6e413 on backend dp-12, cli dp-13."
 */
export function targetsFromLine(line: string | null | undefined): TargetState[] {
  if (!line) return [];
  const done = line.match(/^Live:\s*\S+\s+on\s+([^.;]+)/i)?.[1];
  if (done) return [...done.matchAll(/([a-z][a-z0-9-]{0,31})\s+(dp-\d+)/g)].map((m) => ({ name: m[1], state: "live", deploy: m[2] }));
  const out: TargetState[] = [];
  for (const m of line.matchAll(/(?:^|;\s*)([a-z][a-z0-9-]{0,31}):\s*([^;]*)/g)) {
    const live = m[2].match(/^live in (dp-\d+)/);
    const going = m[2].match(/^(dp-\d+) sending\b/);
    out.push(live ? { name: m[1], state: "live", deploy: live[1] } : going ? { name: m[1], state: "deploying", deploy: going[1] } : { name: m[1], state: "waiting" });
  }
  return out.length ? out : targetsFromOldLine(line);
}

/** The line await-deploy printed before per-target lines: "4a6e413 landed; live on web dp-12, waiting for backend (going out in dp-13)." */
function targetsFromOldLine(line: string): TargetState[] {
  if (/to land on main/.test(line)) return [];
  const out: TargetState[] = [];
  const liveOn = line.match(/\blive on ([^.;()]+?)(?:[,;.]\s*waiting|[.;]|$)/i)?.[1] ?? "";
  for (const m of liveOn.matchAll(/([a-z][a-z0-9-]{0,31})\s+(dp-\d+)/g)) out.push({ name: m[1], state: "live", deploy: m[2] });
  const waiting = line.match(/\bwaiting for ([a-z0-9, -]+?)(?:\s*\(going out in (dp-\d+)\))?\s*[.;]?\s*$/i);
  for (const name of waiting?.[1].split(/\s*,\s*|\s+and\s+/).map((x) => x.trim()).filter(Boolean) ?? []) {
    if (!out.some((t) => t.name === name)) out.push({ name, state: waiting![2] ? "deploying" : "waiting", ...(waiting![2] ? { deploy: waiting![2] } : {}) });
  }
  return out;
}
