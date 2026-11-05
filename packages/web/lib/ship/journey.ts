// A session's change on its way to live, as stages a person reads at a glance
// (docs/architecture/flows.md FL4, deploys.md): the flow's own stations on its
// passing path (Check, Review, Decide, Land), then Deploy and Live. Each stage
// says who acts there (this session, an agent, you, or nobody: it runs by
// itself), its state on a run, how many rounds it took, and whether it sent
// work back to the session. `now` says who acts at this moment and what the
// person can do about it. Pure, with relative imports only: the web's Ship
// panel and run card and the phone's run card all read a run through it.
import { foldFlow, segmentTopOf, SEGMENT_SEP, type FlowEdgeIn, type FlowNodeIn } from "@codecast/shared/contracts/flowPool";

export type StageWho = "session" | "agent" | "you" | "auto";
export type StageState = "idle" | "active" | "back" | "waiting" | "done" | "stopped";

export type JourneyStage = {
  /** The station's id in the run's graph; `deploy` and `live` for the two stages after the flow. */
  id: string;
  label: string;
  who: StageWho;
  state: StageState;
  /** Rounds through this stage on a run, when more than one. */
  round: number | null;
  /** The ways this stage sends work back to the session (its findings, its failures), by the fix station's label. */
  loops: Array<{ id: string; label: string; max: number | null }>;
  /** On a run, what each step in it did: its words, its state, its rounds and the session that did it. */
  steps?: StageStep[];
};

export type StageStep = { id: string; label: string; status: string; visits: number | null; said: string | null; session: { id: string; title: string | null } | null; at: number | null };

export type JourneyNow =
  | { kind: "idle" }
  | { kind: "starting" }
  | { kind: "working"; stage: string; who: StageWho; activity: string | null; since: number | null; session: { id: string; title: string | null } | null }
  | { kind: "session"; stage: string; note: string; since: number | null; round: number | null; max: number | null }
  | { kind: "you"; stage: string; decisionId: string | null; prompt: string | null }
  | { kind: "landed"; sha: string | null; at: number | null; line: string | null }
  | { kind: "deploying"; targets: string[]; line: string | null }
  | { kind: "live"; targets: string[]; line: string | null }
  | { kind: "stopped"; stage: string | null; why: string | null }
  | { kind: "failed"; stage: string | null; why: string | null };

export type Journey = { stages: JourneyStage[]; now: JourneyNow };

/** Where the session's landed change stands on each deploy target. */
export type TargetState = { name: string; state: "waiting" | "deploying" | "live" | "failed"; deploy?: string | null; at?: number | null };

type Graph = { slug?: string; nodes: ReadonlyArray<FlowNodeIn>; edges: ReadonlyArray<FlowEdgeIn> };

export type JourneyRun = {
  status: string;
  current_node_id?: string | null;
  fail_reason?: string | null;
  gate_prompt?: string | null;
  gate_decision_id?: string | null;
  created_at?: number;
  updated_at?: number;
  merge?: { sha: string; at: number } | null;
  waiting_on_session?: { node_id: string; since: number; note: string } | null;
  node_statuses?: ReadonlyArray<{
    node_id: string;
    status: string;
    visits?: number;
    result_preview?: string | null;
    started_at?: number;
    activity?: string | null;
    session?: { _id: string; title?: string | null } | null;
  }> | null;
};

/** What a segment's job is called on the way to live, where its pool name says something else: the Ship segment lands the change. */
const STAGE_WORDS: Record<string, string> = { ship: "Land" };

const isSubject = (n: FlowNodeIn | undefined) => n?.backend === "subject";
const inGroup = (stageId: string, nodeId: string) => nodeId === stageId || nodeId.startsWith(`${stageId}${SEGMENT_SEP}`);

/** Who does a station: the person when any step in it asks one, an agent when any step is a session, else it runs by itself. */
function whoOf(graph: Graph, id: string): StageWho {
  const steps = graph.nodes.filter((n) => inGroup(id, n.id) && n.type !== "exit" && n.type !== "start" && !n.segment_exit);
  const own = steps.length ? steps : graph.nodes.filter((n) => n.id === id);
  if (own.some((n) => n.type === "human")) return "you";
  if (own.some(isSubject)) return "session";
  if (own.some((n) => n.type === "agent" || n.type === "prompt" || n.type === "codergen" || (!!n.backend && n.type !== "command" && !n.segment_entry))) return "agent";
  return "auto";
}

/** Whether a station is the flow's Deploy stage (the deploy segment: it waits for the change to go live). */
const isDeployStage = (n: FlowNodeIn | undefined) => n?.segment_flow === "deploy" || n?.id === "deploy";

/** The flow's stages on its passing path, then Live. A flow with no Deploy stage of its own gets one before Live. */
export function journeyStages(graph: Graph): Omit<JourneyStage, "state" | "round">[] {
  const folded = foldFlow(graph.nodes, graph.edges);
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const main = folded.stations.filter((s) => s.main && s.kind !== "join" && !isSubject(byId.get(s.id)));
  const stages = main.map((s) => {
    const node = byId.get(s.id);
    const loops = graph.edges
      .filter((e) => segmentTopOf(e.from) === s.id && isSubject(byId.get(segmentTopOf(e.to))))
      .map((e) => byId.get(segmentTopOf(e.to))!)
      .filter((n, i, all) => all.findIndex((x) => x.id === n.id) === i)
      .map((n) => ({ id: n.id, label: n.label, max: n.max_visits ?? null }));
    // Deploying is the person's press (or CI's, for a target that goes out by itself); the stage itself only waits.
    const who: StageWho = isDeployStage(node) ? "you" : whoOf(graph, s.id);
    return { id: s.id, label: STAGE_WORDS[node?.segment_flow ?? s.flow ?? ""] ?? s.label, who, loops };
  });
  const hasDeploy = main.some((s) => isDeployStage(byId.get(s.id)));
  return [
    ...stages,
    ...(hasDeploy ? [] : [{ id: "deploy", label: "Deploy", who: "you" as const, loops: [] }]),
    { id: "live", label: "Live", who: "auto" as const, loops: [] },
  ];
}

const LIVE_STATUSES = new Set(["pending", "running", "paused"]);

/** A stop reason a person can read: its leading "Stopped:" and any JSON or a trailing cut word taken off. */
export function readableWhy(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let s = raw.replace(/^Stopped:\s*/, "").replace(/\s*\{[^{}]*"[a-z_]+"\s*:[^{}]*\}\s*$/i, "").trim();
  if (s.length > 280) s = s.slice(0, 280).replace(/\s+\S*$/, "") + "…";
  return s || null;
}

/** The journey of a flow, on a run when there is one, with where its landed change is on each deploy target. */
export function journeyOf(graph: Graph, run: JourneyRun | null | undefined, targets: ReadonlyArray<TargetState> = []): Journey {
  const base = journeyStages(graph);
  if (!run) return { stages: base.map((s) => ({ ...s, state: "idle", round: null })), now: { kind: "idle" } };
  const statuses = run.node_statuses ?? [];
  const live = LIVE_STATUSES.has(run.status);
  const waitingOn = run.waiting_on_session ?? null;
  const at = run.current_node_id ?? null;
  // A fix station the run stands at (or the session it waits on) belongs to the stage that sent the work back.
  const backFrom = (nodeId: string | null) => (nodeId ? base.find((s) => s.loops.some((l) => l.id === segmentTopOf(nodeId)))?.id ?? null : null);
  const backStage = live ? backFrom(waitingOn?.node_id ?? null) ?? backFrom(at) : null;
  const atStage = at ? base.find((s) => s.id !== "live" && inGroup(s.id, at))?.id ?? null : null;
  const passed = run.status === "completed";
  // The flow's own Deploy stage waits for the change to go live and says so in its step's latest line.
  const ownDeploy = base.find((s) => isDeployStage(graph.nodes.find((n) => n.id === s.id)));
  const deployId = ownDeploy?.id ?? "deploy";
  // Its words, never a step's machine output (a JSON report like {"exit": "live"}).
  const deployLine = ownDeploy ? [...statuses].reverse().find((n) => inGroup(deployId, n.node_id) && !!n.result_preview && !/^\s*[{[]/.test(n.result_preview)) : undefined;
  const line = deployLine?.result_preview?.trim() || null;

  const deploying = targets.filter((t) => t.state === "deploying");
  const liveOn = targets.filter((t) => t.state === "live");
  const allLive = ownDeploy ? passed : targets.length > 0 && liveOn.length === targets.length;
  const atDeploy = live && atStage === deployId;
  const goingOut = atDeploy ? /going out in dp-/.test(line ?? "") : deploying.length > 0;

  const labelOf = (id: string) => graph.nodes.find((n) => n.id === id)?.label ?? id;
  // A stage's own steps: a segment's entry and its ends are the stage itself and its outcome, which the track and the bar already say.
  const isEnd = (id: string) => { const n = graph.nodes.find((x) => x.id === id); return !!n && (n.type === "exit" || !!n.segment_exit); };
  const stepsOf = (stageId: string, loops: JourneyStage["loops"]): StageStep[] => statuses
    .filter((n) => (inGroup(stageId, n.node_id) && !(n.node_id === stageId && graph.nodes.some((x) => x.id.startsWith(`${stageId}${SEGMENT_SEP}`))) && !isEnd(n.node_id)) || loops.some((l) => l.id === n.node_id))
    .map((n) => ({ id: n.node_id, label: labelOf(n.node_id), status: n.status, visits: n.visits ?? null, said: n.result_preview?.trim() || n.activity || null, session: n.session ? { id: String(n.session._id), title: n.session.title ?? null } : null, at: n.started_at ?? null }));
  const stages: JourneyStage[] = base.map((s0) => ({ ...s0, steps: stepsOf(s0.id, s0.loops) })).map((s) => {
    if (s.id === "live") return { ...s, state: allLive ? "done" : "idle", round: null };
    if (s.id === deployId) {
      const state: StageState = allLive ? "done"
        : atDeploy ? (goingOut ? "active" : "waiting")
        : run.status === "failed" && atStage === deployId ? "stopped"
        : !ownDeploy && passed ? (goingOut ? "active" : targets.some((t) => t.state === "failed") ? "stopped" : "waiting")
        : "idle";
      return { ...s, state, round: null };
    }
    const mine = statuses.filter((n) => inGroup(s.id, n.node_id));
    const rounds = Math.max(0, ...mine.map((n) => n.visits ?? 1));
    const state: StageState = s.id === backStage ? "back"
      : s.id === atStage && live ? (run.status === "paused" || s.who === "you" ? "waiting" : "active")
      : s.id === atStage && run.status === "failed" ? "stopped"
      : passed || mine.some((n) => n.status === "completed") ? "done"
      : mine.some((n) => n.status === "failed") ? "stopped"
      : "idle";
    return { ...s, state, round: rounds > 1 ? rounds : null };
  });

  const stageLabel = (id: string | null) => (id ? stages.find((s) => s.id === id)?.label ?? id : null);
  let now: JourneyNow;
  if (run.status === "pending") now = { kind: "starting" };
  else if (live && backStage) {
    const loop = base.find((s) => s.id === backStage)!.loops.find((l) => l.id === segmentTopOf(waitingOn?.node_id ?? at ?? ""));
    const node = statuses.find((n) => n.node_id === (waitingOn?.node_id ?? at));
    now = { kind: "session", stage: stageLabel(backStage)!, note: readableWhy(waitingOn?.note) ?? "", since: waitingOn?.since ?? node?.started_at ?? null, round: node?.visits ?? null, max: loop?.max ?? null };
  } else if (atDeploy) {
    now = goingOut ? { kind: "deploying", targets: [], line } : { kind: "landed", sha: run.merge?.sha ?? null, at: run.merge?.at ?? null, line };
  } else if (live && atStage && stages.find((s) => s.id === atStage)?.who === "you") {
    now = { kind: "you", stage: stageLabel(atStage)!, decisionId: run.gate_decision_id ?? null, prompt: run.gate_prompt?.split("\n")[0] ?? null };
  } else if (live) {
    const stage = stages.find((s) => s.id === atStage);
    const node = [...statuses].reverse().find((n) => at && n.node_id === at);
    now = { kind: "working", stage: stage?.label ?? "Running", who: stage?.who ?? "auto", activity: node?.activity ?? null, since: node?.started_at ?? null, session: node?.session ? { id: String(node.session._id), title: node.session.title ?? null } : null };
  } else if (run.status === "failed") {
    const stopped = run.fail_reason?.startsWith("Stopped");
    now = { kind: stopped ? "stopped" : "failed", stage: stageLabel(atStage), why: readableWhy(run.fail_reason) };
  } else if (allLive) now = { kind: "live", targets: liveOn.map((t) => t.name), line };
  else if (goingOut) now = { kind: "deploying", targets: deploying.map((t) => t.name), line };
  else now = { kind: "landed", sha: run.merge?.sha ?? null, at: run.merge?.at ?? null, line };
  return { stages, now };
}

/** Whether a run is still in flight: the session's Ship control shows it rather than offering another. */
export const runIsLive = (run: { status: string } | null | undefined) => !!run && LIVE_STATUSES.has(run.status);

/** The few words for who acts at a stage. */
export const WHO_WORDS: Record<StageWho, string> = { session: "This session", agent: "Agent", you: "You", auto: "Automatic" };

/** The targets a Deploy stage's line names: "live on web dp-12, waiting for backend, cli (going out in dp-13)". */
export function targetsFromLine(line: string | null | undefined): TargetState[] {
  if (!line) return [];
  const out: TargetState[] = [];
  const liveOn = line.match(/\blive on ([^.;()]+?)(?:[,;.]\s*waiting|[.;]|$)/i)?.[1] ?? line.match(/^Live:\s*\S+\s+on\s+([^.;]+)/i)?.[1] ?? "";
  for (const m of liveOn.matchAll(/([a-z][a-z0-9-]{0,31})\s+(dp-\d+)/g)) out.push({ name: m[1], state: "live", deploy: m[2] });
  const waiting = line.match(/\bwaiting for ([a-z0-9, -]+?)(?:\s*\(going out in (dp-\d+)\))?\s*[.;]?\s*$/i);
  if (waiting && !/to land on main/.test(line)) {
    for (const name of waiting[1].split(/\s*,\s*|\s+and\s+/).map((x) => x.trim()).filter(Boolean)) {
      if (!out.some((t) => t.name === name)) out.push({ name, state: waiting[2] ? "deploying" : "waiting", ...(waiting[2] ? { deploy: waiting[2] } : {}) });
    }
  }
  return out;
}

/** What a stage said when it sent the work back to the session, by the stage's name. */
export const SENT_BACK: Record<string, string> = { Check: "Check failed", Review: "Changes asked", Decide: "Revise asked", Land: "Conflict" };

/** Where a session's change is, in the words and tone its Ship control and a run's row both show. */
export function journeyWords(j: Journey | null): { words: string; tone: "idle" | "working" | "agent" | "session" | "you" | "ok" | "bad" } {
  if (!j) return { words: "Ship", tone: "idle" };
  const n = j.now;
  switch (n.kind) {
    case "working": return { words: n.stage, tone: n.who === "agent" ? "agent" : "working" };
    case "starting": return { words: "Starting", tone: "working" };
    case "session": return { words: `${SENT_BACK[n.stage] ?? "Sent back"} · fixing`, tone: "session" };
    case "you": return { words: "Your call", tone: "you" };
    case "landed": return { words: "Waiting to deploy", tone: "you" };
    case "deploying": return { words: "Deploying", tone: "working" };
    case "live": return { words: "Live", tone: "ok" };
    case "stopped": case "failed": return { words: n.stage ? `Stopped at ${n.stage}` : "Stopped", tone: "bad" };
    default: return { words: "Ship", tone: "idle" };
  }
}

/** Whether a person approves the change before it lands: a stage of theirs before Land. */
export function asksBeforeLand(stages: ReadonlyArray<Pick<JourneyStage, "id" | "label" | "who">>): boolean {
  const land = stages.findIndex((s) => s.label === "Land");
  return stages.slice(0, land < 0 ? stages.length : land).some((s) => s.who === "you");
}
