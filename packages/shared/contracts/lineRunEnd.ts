// How a line run ended, read from the stations it visited (the-line-end-to-end.md
// LE12, LE16): the card gate, the line's end stations, and the one reader the
// run listings, the cause history, the Line workspace and the cause repair all
// go through. changeCard.ts re-exports it for the card's readers.

/** The line template's decide gate (LE11): the node whose decision is the card. */
export const CARD_GATE_NODE_ID = "decide";

/** What a line run did to its cause (LE12, LE16), read from its stations:
 *  the watch station runs only after the change landed (ship, or merge), so a
 *  completed watch is the ship record; drop, dissolve and park each end the
 *  run at their own station. A line run is told apart from a run of another
 *  workflow with a station of the same name by its graph (isLineRun). */
export type LineRunEnd = "shipped" | "dropped" | "dissolved" | "parked";
/** The stations that end a line run, and the end each means. */
export const LINE_END_NODES: Readonly<Record<string, LineRunEnd>> = { watch: "shipped", drop: "dropped", dissolve: "dissolved", park: "parked" };

/** A run as isLineRun and lineRunOutcome read it: the stations it visited, and its graph's stations (LE14). */
export type LineRunStations = {
  node_statuses?: ReadonlyArray<{ node_id: string; status: string; outcome?: string | null; started_at?: number; completed_at?: number; result_preview?: string | null }>;
  graph_nodes?: ReadonlyArray<{ id: string }>;
};

/** Whether the run's merge station left the merge to a person (the line it prints: "merge left to a person: <why>",
 *  lineMerge.ts): the switch was off, the day's limit was used, main clashed with the branch, or its checks were red.
 *  The change is pushed but not on the default branch. AgentWatch's graph walks on from its merge station to its
 *  watch either way, so such a run still ends "shipped" (through its landing steps, as the Line pages read it:
 *  approved, not merged), and its watch alone does not say the change landed. */
export function mergeLeft(run: LineRunStations): boolean {
  const merge = [...(run.node_statuses ?? [])].reverse().find((n) => n.node_id === "merge");
  return merge?.status === "completed" && /^merge left to a person\b/m.test(merge.result_preview ?? "");
}

/** Whether a run is a line run: its graph puts a change to a person on the card gate and watches it after it
 *  ships, which the shipped line and every variant of its spine (agentwatch starts at bind) share and no segment
 *  or other workflow has; or it visited ground, where the shipped line starts, which is all a run recorded before
 *  runs carried their graph shows. */
export function isLineRun(run: LineRunStations | null | undefined): boolean {
  if (!run) return false;
  if (run.node_statuses?.some((n) => n.node_id === "ground")) return true;
  const ids = new Set(run.graph_nodes?.map((n) => n.id));
  return ids.has(CARD_GATE_NODE_ID) && ids.has("watch");
}

/** A run that went on past a card nobody answered (its decide gate failed)
 *  and still reached ship. Nothing approved it, so nothing after the card is
 *  a ship, on any graph. */
export function passedUnansweredCard(nodes: ReadonlyArray<{ node_id: string; status: string; outcome?: string | null }> | undefined, gate?: AnsweredGate | null): boolean {
  // An answered gate records the chosen key as its outcome ("s"); only a gate
  // that came back with no answer records "failure". The gate's decision is
  // the record of the answer: a gate that gave up waiting while its card stayed
  // open, and that a person then answered, was answered (ct-57444, answered
  // Ship by a teammate 7 minutes after its node failed).
  if (cardAnswered(gate)) return false;
  const decide = nodes?.find((n) => n.node_id === CARD_GATE_NODE_ID);
  const ship = nodes?.find((n) => n.node_id === "ship");
  return decide?.outcome === "failure" && ship?.status === "completed";
}

/** The run row's record of its newest gate's decision (workflow_runs gate_*). */
export type AnsweredGate = { gate_node_id?: string | null; gate_decision_status?: string | null; gate_answer?: string | null };

/** The run's card decision was answered, whatever its gate node recorded. */
export const cardAnswered = (gate: AnsweredGate | null | undefined): boolean =>
  !!gate && gate.gate_node_id === CARD_GATE_NODE_ID && (gate.gate_decision_status === "answered" || !!gate.gate_answer?.trim());

/** The ends every graph shares: a completed watch shipped, a completed drop dropped. */
const SHARED_ENDS: Readonly<Record<string, LineRunEnd>> = { watch: "shipped", drop: "dropped" };

/** Another graph's own close stations, by name: AgentWatch closes a cause at
 *  `dissolved_at_investigate` (no fix needed, found at Investigate) and parks
 *  it at `park_built`. The step it closed at is the name's tail. */
function foreignEnd(id: string): LineRunEnd | null {
  if (/^(?:dissolved|released)_at_\w+$/.test(id)) return "dissolved";
  if (/^park(?:_|$)/.test(id)) return "parked";
  return null;
}

/** Whether the run went on from its i-th station: a station other than the exit started after it completed (in the run's order, for stations with no times). */
function wentOn(nodes: ReadonlyArray<{ node_id: string; started_at?: number; completed_at?: number }>, i: number): boolean {
  const done = nodes[i].completed_at ?? nodes[i].started_at;
  return nodes.some((m, j) => j !== i && m.node_id !== "exit" && (done !== undefined && m.started_at !== undefined ? m.started_at >= done : j > i));
}

/** The latest end station a run completed, the end it means and when, or null when it reached none: on a line run
 *  the line's own end stations, on every graph the ends all graphs share and another graph's close stations. An end
 *  station is where the run stopped. AgentWatch's spine passes through a `dissolve` step on its way to Investigate and
 *  closes at its own `dissolved_at_<step>`; read as an end, that step called 25 of Union's 48 AgentWatch runs dissolved
 *  while they ran, waited on a card or had stopped at Refine (2026-10-25). */
function endStation(run: LineRunStations, gate: AnsweredGate | null | undefined): { kind: LineRunEnd; at: number; node: string } | null {
  const nodes = run.node_statuses;
  if (!nodes || passedUnansweredCard(nodes, gate)) return null;
  const line = isLineRun(run);
  let best: { kind: LineRunEnd; at: number; node: string } | null = null;
  nodes.forEach((n, i) => {
    const kind = (line ? LINE_END_NODES[n.node_id] : SHARED_ENDS[n.node_id]) ?? foreignEnd(n.node_id);
    if (!kind || n.status !== "completed" || wentOn(nodes, i)) return;
    const at = n.completed_at ?? n.started_at ?? 0;
    if (!best || at >= best.at) best = { kind, at, node: n.node_id };
  });
  return best;
}

/** How a run ended, in any graph, so a run of another graph that merged and started its watch reads as shipped and
 *  one that closed its cause reads as dissolved, never by a gate it passed on the way. `node` is the end station it
 *  reached. The run row carries its own gate's record. */
export const runEnd = (run: LineRunStations & AnsweredGate) => endStation(run, run);

/** How a line run ended (runEnd), or null for a run of any other workflow. */
export function lineRunOutcome(run: LineRunStations | null | undefined, gate?: AnsweredGate | null): { kind: LineRunEnd; at: number; node: string } | null {
  return run && isLineRun(run) ? endStation(run, gate) : null;
}

/** A run that ended badly: failed, or completed through one of its graph's failure stations (agentwatch's
 *  failed_at_build), which reads as completed because the graph walks on to its exit. */
export function endedFailing(run: { status: string } & LineRunStations): boolean {
  if (run.status === "failed") return true;
  if (run.status !== "completed") return false;
  let last: { node_id: string; completed_at?: number } | null = null;
  for (const n of run.node_statuses ?? []) if (n.node_id !== "exit" && (!last || (n.completed_at ?? 0) >= (last.completed_at ?? 0))) last = n;
  return /^failed(?:_|$)/.test(last?.node_id ?? "");
}

/** A run that ended with its approved change pushed and its merge left to a person (mergeLeft). Like a failed run,
 *  it resumes at a station of its graph: at its merge station once what stopped the merge is gone. */
export const endedUnmerged = (run: { status: string } & LineRunStations): boolean => run.status === "completed" && mergeLeft(run);
