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
import { foldFlow, segmentTopOf, SEGMENT_SEP, type FlowEdgeIn, type FlowNodeIn } from "@codecast/shared/contracts/flowPool";

/** `you`: an open card on the stage the viewer may answer; `person`: a person answers there, the viewer or not. */
export type StageWho = "session" | "agent" | "you" | "person" | "auto";
/**
 * `back`: it sent the work back to the session (a red CI, changes asked). `routed`: a step in it failed and the run went
 * on through a route out of it (a script that exits non-zero to choose a path); never a stop. `stopped`: the run ended
 * there. `skipped`: a finished run never entered it.
 */
export type StageState = "idle" | "active" | "back" | "waiting" | "done" | "routed" | "stopped" | "skipped";
/** What a stage is for, read from the graph: a fan-out, the station that lands the change (one holding the runner's
 *  `shipped` or `landed` step), Deploy, Live, or any other step. */
export type StageRole = "step" | "parallel" | "land" | "deploy" | "live";

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
};

export type StageStep = { id: string; label: string; status: string; visits: number | null; said: string | null; session: { id: string; title: string | null } | null; at: number | null };

/** One thing the run is waiting on: the station, its latest progress line, since it was entered, and its deadline. */
export type JourneyWait = { on: string; line: string | null; since: number | null; deadline: number | null };

/** The one action that can work for a stop: open the run (a deliberate stop that re-running would repeat), the subject
 *  session (it ran out of rounds), the target's deploy, or run it again (an unplanned failure, or one the machine caused). */
export type StopFix = "run" | "session" | "deploy" | "again";

export type JourneyNow =
  | { kind: "idle" }
  | { kind: "starting" }
  | { kind: "working"; stage: string; verb: string | null; role: StageRole; who: StageWho; waits: JourneyWait[]; session: { id: string; title: string | null } | null }
  /** `by`: who sent it back when that is not the stage (a person's card answered with Revise). */
  | { kind: "session"; stage: string; note: string; since: number | null; round: number | null; max: number | null; by: string | null }
  | { kind: "gate"; stage: string; mine: boolean; holder: "person" | "role"; decisionId: string | null; prompt: string | null; since: number | null }
  /** Landed, and its Deploy not going out yet: held on main's CI, waiting for a person to send it, or for targets that go by themselves. */
  | { kind: "landed"; sha: string; at: number | null; line: string | null; hold: DeployHold; waits: JourneyWait[] }
  | { kind: "unlanded"; why: string; waits: JourneyWait[] }
  | { kind: "deploying"; targets: string[]; line: string | null; waits: JourneyWait[] }
  | { kind: "live"; targets: string[]; line: string | null }
  /** A finished run of a flow with no Deploy of its own: it ends where it lands. */
  | { kind: "merged"; sha: string; at: number | null }
  /** A finished run of a flow that lands nothing. */
  | { kind: "passed" }
  /** `briefAt`: when the run last briefed the session it stopped on, so the brief can be found in that session's thread.
   *  `end`: the exit's own name when the run reached it off the main path ("Main stayed red"), which says more than its stage. */
  | { kind: "stopped" | "failed"; stage: string | null; why: string | null; fix: StopFix; session: string | null; briefAt: number | null; end: string | null };

export type Journey = { stages: JourneyStage[]; now: JourneyNow };

/** Where the session's landed change stands on each deploy target. */
export type TargetState = { name: string; state: "waiting" | "deploying" | "live" | "failed"; deploy?: string | null; at?: number | null };

type GraphNode = FlowNodeIn & { timeout?: number; machine?: boolean };
type Graph = {
  slug?: string;
  nodes: ReadonlyArray<GraphNode>;
  edges: ReadonlyArray<FlowEdgeIn>;
  /** Each station's settings, where the flow carries them apart from its nodes (a pushed flow's rows). */
  stationDetails?: Record<string, { timeout?: number }> | null;
};

type NodeStatus = {
  node_id: string;
  status: string;
  visits?: number;
  result_preview?: string | null;
  started_at?: number;
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
  waiting_on_session?: { node_id: string; since: number; note: string } | null;
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
export type JourneyViewer = { id: string | null; decision?: GateDecision | null };

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

/** The one landed fact: the sha a merge recorded on the run (`/cli/line/merge/record`). Nothing else means landed. */
export const landedSha = (run: { merge?: { sha?: string | null } | null } | null | undefined): string | null => run?.merge?.sha || null;

/** Whether a gate holds the run for an answer: paused on a card nobody has answered. */
export const gateOpen = (run: Pick<JourneyRun, "status" | "gate_decision_id" | "gate_prompt" | "gate_decision_status">) =>
  run.status === "paused" && !!(run.gate_decision_id || run.gate_prompt) && (run.gate_decision_status ?? "pending") === "pending";

/** What a segment's job is called on the way to live, where its pool name says something else: the Ship segment lands the change. */
const STAGE_WORDS: Record<string, string> = { ship: "Land" };

/** The runner's own landing steps (runner.ts): a run that passes one has landed its change. */
const LANDING_STEP = /(^|__)(shipped|landed)$/;

type Base = Omit<JourneyStage, "state" | "round" | "steps" | "branches"> & { members: string[]; kind: string; branches?: Base[] };

const isSubject = (n: FlowNodeIn | undefined) => n?.backend === "subject";
const inGroup = (stageId: string, nodeId: string) => nodeId === stageId || nodeId.startsWith(`${stageId}${SEGMENT_SEP}`);
const inStage = (s: Pick<Base, "members">, nodeId: string) => s.members.some((m) => inGroup(m, nodeId));

/** Who does a station: a person when any step in it asks one, an agent when any step is a session, else it runs by itself. */
function whoOf(graph: Graph, ids: string[]): StageWho {
  const steps = graph.nodes.filter((n) => ids.some((id) => inGroup(id, n.id)) && n.type !== "exit" && n.type !== "start" && !n.segment_exit);
  const own = steps.length ? steps : graph.nodes.filter((n) => ids.includes(n.id));
  if (own.some((n) => n.type === "human")) return "person";
  if (own.some(isSubject)) return "session";
  if (own.some((n) => n.type === "agent" || n.type === "prompt" || n.type === "codergen" || (!!n.backend && n.type !== "command" && !n.segment_entry))) return "agent";
  return "auto";
}

const WHO_RANK: StageWho[] = ["person", "agent", "session", "auto"];

/** Whether a station is the flow's Deploy stage (the deploy segment: it waits for the change to go live). */
const isDeployStage = (n: FlowNodeIn | undefined) => n?.segment_flow === "deploy" || n?.id === "deploy";

/** The flow's stages on its main path, in the order a passing run reaches them, then Deploy and Live. */
function planOf(graph: Graph, withTargets = false): Base[] {
  const folded = foldFlow(graph.nodes, graph.edges);
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const station = new Map(folded.stations.map((s) => [s.id, s]));
  const order = (folded.path ?? folded.stations.filter((s) => s.main).map((s) => s.id)).filter((id) => station.has(id) && !isSubject(byId.get(id)));
  const at = new Map(order.map((id, i) => [id, i]));
  const onPath = new Set(folded.path ?? order);
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
  const stageOf = (members: string[], label: string): Base => {
    const node = byId.get(members[0]);
    const deploy = members.length === 1 && isDeployStage(node);
    return {
      id: members[0],
      label,
      role: deploy ? "deploy" : "step",
      kind: station.get(members[0])?.kind ?? "agent",
      // The Deploy stage only waits: each target goes out by its own policy, and a press is the Deploys page's.
      who: deploy ? "auto" : whoOf(graph, members),
      loops: loopsOf(members),
      members,
    };
  };
  const labelOf = (id: string) => STAGE_WORDS[byId.get(id)?.segment_flow ?? station.get(id)?.flow ?? ""] ?? station.get(id)?.label ?? id;
  const stages: Base[] = [];
  const taken = new Set<string>();
  for (const id of order) {
    if (taken.has(id)) continue;
    taken.add(id);
    const s = station.get(id)!;
    if (s.kind === "join") continue;
    if (s.kind !== "parallel") { stages.push(stageOf([id], labelOf(id))); continue; }
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
    const members = [id, ...branches.flatMap((b) => b.members), ...(join ? [join] : [])];
    stages.push({ id, label: branches.map((b) => b.label).join(" + "), role: "parallel", kind: "parallel", who: WHO_RANK.find((w) => branches.some((b) => b.who === w)) ?? "auto", loops: loopsOf(members), members, branches });
  }
  // The stage holding the runner's landing step lands the change; with none, no stage claims it.
  const land = stages.findIndex((s) => s.role === "step" && graph.nodes.some((n) => LANDING_STEP.test(n.id) && inStage(s, n.id)));
  if (land >= 0) stages[land] = { ...stages[land], role: "land" };
  // Deploy and Live are the flow's own when it has a Deploy step; a flow without one ends where it lands, unless the
  // caller knows where its landed commit went out (deploy reach targets).
  const deploys = stages.some((s) => s.role === "deploy");
  if (!deploys && !withTargets) return stages;
  return [
    ...stages,
    ...(deploys ? [] : [{ id: "deploy", label: "Deploy", role: "deploy" as const, kind: "segment", who: "auto" as const, loops: [], members: [] }]),
    { id: "live", label: "Live", role: "live", kind: "live", who: "auto", loops: [], members: [] },
  ];
}

const strip = ({ members: _m, kind: _k, branches, ...s }: Base): Omit<JourneyStage, "state" | "round"> => ({ ...s, ...(branches ? { branches: branches.map((b) => ({ ...strip(b), state: "idle" as const, round: null })) } : {}) });

/** The flow's stages on its main path, in execution order, then its Deploy and Live. */
export function journeyStages(graph: Graph): Omit<JourneyStage, "state" | "round">[] {
  return planOf(graph).map(strip);
}

const LIVE_STATUSES = new Set(["pending", "running", "paused"]);

/** A stop reason a person can read: its leading "Stopped:" and any JSON or a trailing cut word taken off. */
export function readableWhy(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let s = raw.replace(/^Stopped:\s*/, "").replace(/\s*\{[^{}]*"[a-z_]+"\s*:[^{}]*\}\s*$/i, "").trim();
  if (s.length > 280) s = s.slice(0, 280).replace(/\s+\S*$/, "") + "…";
  return s || null;
}

/** A step's latest words a person can read: its live activity, else its output, never machine output (a JSON report). */
const lineOf = (n: NodeStatus | undefined) => {
  const said = n?.activity?.trim() || n?.result_preview?.trim() || null;
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

/** The journey of a flow, on a run when there is one, with where its landed change is on each deploy target. */
export function journeyOf(graph: Graph, run: JourneyRun | null | undefined, targets: ReadonlyArray<TargetState> = [], viewer: JourneyViewer | null = null): Journey {
  const plan = planOf(graph, targets.length > 0);
  const idle = (b: Base): JourneyStage => ({ ...strip(b), state: "idle", round: null, ...(b.branches ? { branches: b.branches.map(idle) } : {}) });
  if (!run) return { stages: plan.map(idle), now: { kind: "idle" } };
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const statuses = run.node_statuses ?? [];
  const statusOf = (id: string | null | undefined) => (id ? [...statuses].reverse().find((n) => n.node_id === id) : undefined);
  const newest = (list: NodeStatus[]) => list.reduce<NodeStatus | undefined>((best, n) => (!best || (n.started_at ?? 0) >= (best.started_at ?? 0) ? n : best), undefined);
  const live = LIVE_STATUSES.has(run.status);
  const passed = run.status === "completed";
  const failed = run.status === "failed";
  const sha = landedSha(run);
  const waitingOn = run.waiting_on_session ?? null;
  const at = run.current_node_id ?? null;
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
  // What the run did off the main path, in its own words: the label of the route a stage took into it ("edits CI"),
  // else the first off-path step's own label.
  const offPathLabel = (nodeId: string): string | null => {
    const first = chain(nodeId).filter((id) => byId.get(id)?.type !== "exit").pop();
    if (!first) return null;
    const route = graph.edges.find((e) => e.to === first && e.label && stageOf(e.from))?.label;
    return route ? route.charAt(0).toUpperCase() + route.slice(1) : byId.get(first)?.label ?? null;
  };
  // A step inside a person's card (a gate's own segment): what it sends back, the person sent back.
  const byPerson = (nodeId: string | undefined) => !!nodeId && graph.nodes.some((n) => n.type === "human" && (n.id === nodeId || segmentTopOf(n.id) === segmentTopOf(nodeId)));
  const backStage = live ? (backFrom(waitingOn?.node_id ?? null) ?? backFrom(at))?.id ?? null : null;
  const atBase = stageFor(at);
  const atStage = live ? atBase?.id ?? null : null;
  const stopStage = failed ? atBase?.id ?? null : null;
  // An open card is a gate wherever its node sits: on a stage when the walk back finds one, else in the bar alone.
  const open = live && gateOpen(run);
  const gateNode = open ? run.gate_node_id ?? at : null;
  const gateStage = open ? stageFor(gateNode)?.id ?? null : null;
  const gateMine = open && canAnswer(viewer?.decision, viewer?.id);
  // A card off the main path names the stage that holds it after the route into it ("Edits CI"), not the stage's own name.
  const gateOff = gateNode && !stageOf(gateNode) ? offPathLabel(gateNode) : null;
  // Where the run stands: stages after it hold only what earlier rounds left, which is not this round's state.
  const current = plan.findIndex((s) => s.id === (backStage ?? gateStage ?? atStage ?? stopStage));

  // The round's verdicts, once the step that routes on them has run after the fan-out's branches last started.
  const fan = plan.find((s) => s.branches);
  const fanStart = fan ? Math.max(0, ...statuses.filter((n) => fan.branches!.some((b) => inStage(b, n.node_id))).map((n) => n.started_at ?? 0)) : 0;
  const verdictStep = newest(statuses.filter((n) => verdictsOf(n.result_preview)));
  const verdicts = verdictStep && (verdictStep.started_at ?? 0) >= fanStart ? verdictsOf(verdictStep.result_preview) : null;

  const timeoutOf = (id: string) => byId.get(id)?.timeout ?? graph.stationDetails?.[id]?.timeout ?? null;
  const waitOf = (on: string, n: NodeStatus | undefined): JourneyWait => {
    const timeout = n ? timeoutOf(n.node_id) : null;
    const since = n?.started_at ?? null;
    return { on, line: lineOf(n), since, deadline: since && timeout ? since + timeout * 1000 : null };
  };

  // The flow's own Deploy stage waits for the change to go live and says so in its step's latest line.
  const deployStage = plan.find((s) => s.role === "deploy");
  const ownDeploy = !!deployStage?.members.length;
  const deployNode = ownDeploy ? [...statuses].reverse().find((n) => inStage(deployStage!, n.node_id) && !!lineOf(n)) : undefined;
  const line = lineOf(deployNode);
  const deploying = targets.filter((t) => t.state === "deploying");
  const liveOn = targets.filter((t) => t.state === "live");
  // A flow's own Deploy passes only once the change is live, but a run can also complete with nothing merged (the change
  // was already upstream): that is Done, never Live.
  const allLive = ownDeploy ? passed && (!!sha || !plan.some((s) => s.role === "land")) : !!sha && targets.length > 0 && liveOn.length === targets.length;
  const atDeploy = live && !!deployStage && atStage === deployStage.id;
  const hold: DeployHold = atDeploy ? deployHold(line) : { kind: deploying.length ? "out" : "wait", by: null };
  const deployWaits = () => [waitOf(deployStage!.label, statusOf(at) ?? deployNode)];

  const labelOf = (id: string) => byId.get(id)?.label ?? id;
  // A stage's own steps: a segment's entry and its ends are the stage itself and its outcome, which the track and the bar already say.
  const isEntry = (id: string) => graph.nodes.some((x) => x.id.startsWith(`${id}${SEGMENT_SEP}`));
  const isEnd = (id: string) => { const n = byId.get(id); return !!n && (n.type === "exit" || !!n.segment_exit); };
  const stepsOf = (b: Base): StageStep[] => statuses
    .filter((n) => (inStage(b, n.node_id) && !(b.members.includes(n.node_id) && isEntry(n.node_id)) && !isEnd(n.node_id)) || b.loops.some((l) => l.id === n.node_id))
    .map((n) => ({ id: n.node_id, label: labelOf(n.node_id), status: n.status, visits: n.visits ?? null, said: n.result_preview?.trim() || n.activity || null, session: n.session ? { id: String(n.session._id), title: n.session.title ?? null } : null, at: n.started_at ?? null }));
  // What a stage's steps did last (one entry per node: its latest visit); a segment's entry only routes into its steps.
  const latestOf = (b: Base) => newest(statuses.filter((n) => inStage(b, n.node_id) && !(b.members.includes(n.node_id) && isEntry(n.node_id))));

  const stateOf = (b: Base, index: number): StageState => {
    if (b.id === backStage) return "back";
    if (b.id === gateStage) return "waiting";
    if (b.id === stopStage) return "stopped";
    if (!passed && current >= 0 && index > current) return "idle";
    if (live && b.id === atStage && !b.branches) return run.status === "paused" ? "waiting" : "active";
    const last = latestOf(b);
    if (!last) return passed ? "skipped" : "idle";
    if (last.status === "running" || last.status === "pending") return live ? "active" : "idle";
    if (last.status === "failed") return "routed";
    // A landing stage that went on with no merged sha recorded did not land anything.
    if (b.role === "land" && !sha) return "routed";
    return "done";
  };
  // A branch says what its verdict says, once the round has one: red CI and changes asked sent the work back, a CI held
  // by main's red waits for main. Before the verdict a branch is running or idle, never a check from its exit alone.
  const branchState = (br: Base): StageState => {
    const last = latestOf(br);
    if (last?.status === "running" || last?.status === "pending") return live ? "active" : "idle";
    const said = br.who === "agent" ? verdicts?.review : verdicts?.ci;
    if (said === "green" || said === "ship") return "done";
    if (said === "red" || said === "timed_out" || said === "changes" || said === "stale") return "back";
    if (said === "blocked_by_main") return live ? "waiting" : "routed";
    if (said === "rejected") return failed ? "stopped" : "back";
    if (said === "missing") return "routed";
    return passed && last ? "done" : passed ? "skipped" : "idle";
  };
  const stageOn = (b: Base, index: number): JourneyStage => {
    const mine = statuses.filter((n) => inStage(b, n.node_id));
    const rounds = Math.max(0, ...mine.map((n) => n.visits ?? 1));
    // An open card says who may answer it: the viewer, or someone else.
    const who: StageWho = b.id === gateStage ? (gateMine ? "you" : "person") : b.who;
    const base = { ...strip(b), ...(b.id === gateStage && gateOff ? { label: gateOff } : {}), who, steps: stepsOf(b), round: rounds > 1 ? rounds : null };
    if (b.role === "live") return { ...base, state: allLive ? "done" : passed ? "skipped" : "idle" };
    if (b.role === "deploy") {
      const state: StageState = allLive ? "done"
        : atDeploy ? (sha && hold.kind === "out" ? "active" : "waiting")
        : stopStage === b.id ? "stopped"
        : !ownDeploy && passed && sha ? (hold.kind === "out" ? "active" : targets.some((t) => t.state === "failed") ? "stopped" : "waiting")
        : passed ? "skipped"
        : "idle";
      return { ...base, state };
    }
    if (!b.branches) return { ...base, state: stateOf(b, index) };
    const own = stateOf(b, index);
    const later = !passed && current >= 0 && index > current;
    const branches = b.branches.map((br) => ({ ...stageOn(br, index), state: later ? "idle" as const : branchState(br) }));
    // A stop inside a fan-out is the branch whose step failed last (or still ran); its siblings keep their own state.
    if (b.id === stopStage) {
      const culprit = b.branches.findIndex((br) => latestOf(br)?.status === "failed");
      if (culprit >= 0) branches[culprit] = { ...branches[culprit], state: "stopped" };
    }
    const has = (s: StageState) => branches.some((br) => br.state === s);
    const ran = !later && statuses.some((n) => inStage(b, n.node_id) && (n.started_at ?? 0) >= fanStart);
    const state: StageState = own === "waiting" || own === "stopped" || later ? own
      : has("stopped") ? "stopped"
      : own === "back" || has("back") ? "back"
      : branches.every((br) => br.state === "done") ? "done"
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
    if (stage.role === "land" || (kind === "script" && stages[i + 1]?.role === "land")) return "Merging";
    if (i === 0 && kind === "script" && stages[1]?.role === "parallel") return `Opening ${stage.label}`;
    return null;
  };
  let now: JourneyNow;
  if (run.status === "pending") now = { kind: "starting" };
  else if (live && backStage) {
    const loop = plan.find((s) => s.id === backStage)!.loops.find((l) => l.id === segmentTopOf(waitingOn?.node_id ?? at ?? ""));
    const node = statusOf(waitingOn?.node_id ?? at);
    now = { kind: "session", stage: stageLabel(backStage)!, note: readableWhy(waitingOn?.note) ?? "", since: waitingOn?.since ?? node?.started_at ?? null, round: node?.visits ?? null, max: loop?.max ?? null, by: byPerson(routedFrom(waitingOn?.node_id ?? at ?? "", new Set())?.node_id) ? "the person" : null };
  } else if (open) {
    // The card's own step names the bar when it sits off every stage (a card a script asked for); on a stage, the stage.
    const onStage = gateNode ? stageOf(gateNode) : null;
    now = { kind: "gate", stage: onStage ? stageLabel(onStage.id)! : labelOf(gateNode ?? ""), mine: gateMine, holder: holderOf(viewer?.decision), decisionId: run.gate_decision_id ?? null, prompt: run.gate_prompt?.split("\n")[0] ?? null, since: statusOf(gateNode)?.started_at ?? null };
  } else if (atDeploy) {
    // With no merge recorded yet (one merged by its own script, a run from an older CLI) the bar says the wait and
    // claims neither landed nor not landed: the wait itself records the merge once it finds it on main.
    now = !sha ? { kind: "working", stage: deployStage!.label, verb: null, role: "deploy", who: "auto", waits: deployWaits(), session: null }
      : hold.kind === "out" ? { kind: "deploying", targets: [], line, waits: deployWaits() }
      : { kind: "landed", sha, at: run.merge?.at ?? null, line, hold, waits: deployWaits() };
  } else if (live) {
    const stage = stages.find((s) => s.id === atStage);
    const node = statusOf(at);
    // A station off the main path (a retest, a wait for main) reads as itself, inside the stage the run came from.
    const offMain = at && !stageOf(at) && !backFrom(at) ? labelOf(at) : null;
    // A fan-out waits on each branch still running; any other stage on the step it stands at.
    const fanBase = stage?.branches ? plan[stages.indexOf(stage)] : null;
    const waits = fanBase && !offMain
      ? fanBase.branches!.filter((b) => latestOf(b)?.status === "running").map((b) => waitOf(b.label, latestOf(b)))
      : [waitOf(offMain ?? stage?.label ?? labelOf(at ?? ""), node)];
    now = { kind: "working", stage: offMain ?? stage?.label ?? (at ? labelOf(at) : "Running"), verb: verbOf(stage, offMain), role: stage?.role ?? "step", who: stage?.who ?? "auto", waits, session: node?.session ? { id: String(node.session._id), title: node.session.title ?? null } : null };
  } else if (failed) {
    const stage = stages.find((s) => s.id === stopStage);
    const walked = chain(at);
    const exit = at ? byId.get(at) : undefined;
    const atExit = exit?.type === "exit" && !exit.segment;
    // A deliberate stop (an exit that says why, or the runner's "Stopped:") repeats if run again; only an unplanned failure,
    // or one the machine caused, is worth another run.
    const deliberate = atExit ? !!exit?.stop && !exit?.machine : !!run.fail_reason?.startsWith("Stopped");
    const subject = [at, ...walked].find((id) => id && isSubject(byId.get(segmentTopOf(id))));
    const fix: StopFix = stage?.role === "deploy" ? "deploy"
      : subject ? "session"
      : deliberate ? "run"
      : "again";
    // Not landed is said only of a run that ended where its change should have been on main (Deploy found no merge).
    if (!sha && stage?.role === "deploy") now = { kind: "unlanded", why: readableWhy(run.fail_reason) ?? "The run ended with no merge recorded", waits: [] };
    else now = { kind: run.fail_reason?.startsWith("Stopped") || atExit ? "stopped" : "failed", stage: stageLabel(stopStage), why: readableWhy(run.fail_reason), fix, session: run.spawner_conversation_id ? String(run.spawner_conversation_id) : null, briefAt: subject ? statusOf(subject)?.started_at ?? null : null, end: atExit && walked.some((id) => id !== at && byId.get(id)?.type !== "exit") ? exit?.label ?? null : null };
  } else if (allLive) now = { kind: "live", targets: liveOn.map((t) => t.name), line };
  else if (!plan.some((s) => s.role === "land")) now = { kind: "passed" };
  // A finished run with no merge on it (a merge nobody recorded) says it finished, never that it did not land.
  else if (!sha) now = { kind: "passed" };
  // A flow with no Deploy of its own ends where it lands; with deploy reach, it goes on to its targets.
  else if (!deployStage) now = { kind: "merged", sha, at: run.merge?.at ?? null };
  else if (hold.kind === "out") now = { kind: "deploying", targets: deploying.map((t) => t.name), line, waits: [] };
  else now = { kind: "landed", sha, at: run.merge?.at ?? null, line, hold, waits: [] };
  return { stages, now };
}

/** Whether a run is still in flight: the session's Ship control shows it rather than offering another. */
export const runIsLive = (run: { status: string } | null | undefined) => !!run && LIVE_STATUSES.has(run.status);

/** The few words for who acts at a stage. */
export const WHO_WORDS: Record<StageWho, string> = { session: "This session", agent: "Agent", you: "You", person: "Person", auto: "Automatic" };

/** A wait in a few words: "CI · 9 of 14 jobs · 7m · due in 13m". `age` formats a span of milliseconds. */
export function waitWords(w: JourneyWait, now: number, age: (ms: number) => string): string {
  const parts = [w.on, w.line, w.since ? age(Math.max(0, now - w.since)) : null];
  if (w.deadline) parts.push(w.deadline > now ? `due in ${age(w.deadline - now)}` : `${age(now - w.deadline)} past its deadline`);
  return parts.filter(Boolean).join(" · ");
}

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

/** "CI and review": station names as one phrase, an acronym kept as written. */
const phrase = (labels: string[]) => labels.map((l) => (l !== l.toUpperCase() ? l.toLowerCase() : l)).join(" and ");

export type JourneyTone = "idle" | "working" | "agent" | "session" | "you" | "wait" | "ok" | "bad";

/** The words for a card nobody the viewer is may answer. */
export const gateWaitWords = (holder: "person" | "role") => (holder === "role" ? "Waiting on a role" : "Waiting on a person");

/** A stop in a few words: the exit's own name when the run reached it off the main path, else the stage it stopped at. */
export function stopWords(n: { stage: string | null; end: string | null }): string {
  if (n.end) return `Stopped: ${/^[A-Z]{2,}\b/.test(n.end) ? n.end : n.end.charAt(0).toLowerCase() + n.end.slice(1)}`;
  return n.stage ? `Stopped at ${n.stage}` : "Stopped";
}

/** Who sent the work back, in the bar's words. */
export const sentBackWords = (n: { stage: string; by: string | null }) => (n.by ? `Sent back by ${n.by}` : `${n.stage} sent it back`);

/** A landed change's Deploy in a pill's words: "Deploying" only while a deploy carries it. */
export function holdWords(hold: DeployHold): { words: string; tone: "working" | "wait" } {
  if (hold.kind === "out") return { words: "Deploying", tone: "working" };
  if (hold.kind === "red") return { words: "Held: main CI red", tone: "wait" };
  if (hold.kind === "ci") return { words: "Waiting on main CI", tone: "wait" };
  if (hold.kind === "press") return { words: `Waiting for ${hold.by ?? "a person"} to deploy`, tone: "wait" };
  return { words: "Waiting to deploy", tone: "wait" };
}

/** Where a session's change is, in the words and tone its Ship control and a run's row both show. */
export function journeyWords(j: Journey | null): { words: string; tone: JourneyTone } {
  if (!j) return { words: "Ship", tone: "idle" };
  const n = j.now;
  switch (n.kind) {
    case "working": {
      const tone = n.who === "agent" ? "agent" : "working";
      if (n.verb) return { words: n.verb, tone };
      if (n.role === "parallel") return { words: `In ${phrase(n.waits.length ? n.waits.map((w) => w.on) : n.stage.split(" + "))}`, tone };
      return { words: n.stage, tone };
    }
    case "starting": return { words: "Starting", tone: "working" };
    case "session": return { words: "Fixing", tone: "session" };
    case "gate": return n.mine ? { words: "Your call", tone: "you" } : { words: gateWaitWords(n.holder), tone: "wait" };
    case "landed": return holdWords(n.hold);
    case "deploying": return { words: "Deploying", tone: "working" };
    case "merged": return { words: "Landed", tone: "ok" };
    case "passed": return { words: "Done", tone: "ok" };
    case "unlanded": return { words: "Not landed", tone: "bad" };
    case "live": return { words: "Live", tone: "ok" };
    case "stopped": case "failed": return { words: stopWords(n), tone: "bad" };
    default: return { words: "Ship", tone: "idle" };
  }
}

/** Whether a person approves the change before it lands: a stage of a person's before the one that lands it. */
export function asksBeforeLand(stages: ReadonlyArray<Pick<JourneyStage, "role" | "who">>): boolean {
  const land = stages.findIndex((s) => s.role === "land" || s.role === "deploy");
  return stages.slice(0, land < 0 ? stages.length : land).some((s) => s.who === "person" || s.who === "you");
}
