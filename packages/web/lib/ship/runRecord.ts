// What a run recorded, read against the flow it is drawn on (lib/ship/journey.ts): the commit it landed, and its steps
// by their ids in today's graph. Pure, with relative imports only: the phone's run card reads a run here too.
import { SEGMENT_SEP, type FlowEdgeIn, type FlowNodeIn } from "@codecast/shared/contracts/flowPool";

/** The runner's merge step and its landing steps (runner.ts): what one reports when it passes is the commit it put on main. */
const MERGING_STEP = /(^|__)(merge|shipped|landed)$/;
/** Deploy's stop for a commit it did not find on main (`cast flow await-deploy` exit 4). */
const UNMERGED_STEP = /(^|__)unmerged$/;
const SHA_OUT = /"sha"\s*:\s*"([0-9a-f]{7,40})"/;

type RecordedRun = {
  merge?: { sha?: string | null } | null;
  current_node_id?: string | null;
  waiting_on_session?: { node_id: string } | null;
  gate_node_id?: string | null;
  node_statuses?: ReadonlyArray<{ node_id: string; status?: string; result_preview?: string | null; started_at?: number }> | null;
};

/**
 * The landed fact: the sha a merge recorded on the run (`/cli/line/merge/record`), else the sha a merge or landing step
 * reported when it passed, as await-deploy reads a merge station's merge.json (a flow's own merge script, a run from a
 * CLI that recorded nothing), unless Deploy then stopped finding it not on main. Nothing else means landed.
 */
export function landedSha(run: RecordedRun | null | undefined): string | null {
  if (run?.merge?.sha) return run.merge.sha;
  const statuses = run?.node_statuses ?? [];
  const step = [...statuses].reverse().find((n) => n.status === "completed" && MERGING_STEP.test(n.node_id) && SHA_OUT.test(n.result_preview ?? ""));
  if (!step) return null;
  const refuted = UNMERGED_STEP.test(run?.current_node_id ?? "") || statuses.some((n) => UNMERGED_STEP.test(n.node_id) && (n.started_at ?? 0) >= (step.started_at ?? 0));
  return refuted ? null : step.result_preview!.match(SHA_OUT)![1];
}

const leafOf = (id: string) => id.split(SEGMENT_SEP).pop()!;
/** The segment a step sits in, "" for a top-level one. */
export const parentOf = (id: string) => (id.includes(SEGMENT_SEP) ? id.slice(0, id.lastIndexOf(SEGMENT_SEP)) : "");

/**
 * The steps a run recorded, by their ids in this graph. A run with no pinned version is drawn on the flow as it stands,
 * and one of an older version may have named its steps before a segment held them (`merge`, now `land__merge`). Such a
 * flat id becomes the one segment step with the same last part, and only in a segment the run entered at its start (one
 * of the steps its entry leads to is among them): a step of the same name in a segment the run never reached is another
 * step (an old `revise` is not the card's `decide__revise`). Every other id stays as recorded.
 */
export function recordedIds(graph: { nodes: ReadonlyArray<FlowNodeIn>; edges: ReadonlyArray<FlowEdgeIn> }, run: RecordedRun): (id: string) => string {
  const recorded = [...(run.node_statuses ?? []).map((n) => n.node_id), run.current_node_id, run.waiting_on_session?.node_id, run.gate_node_id];
  const own = new Set(graph.nodes.map((n) => n.id));
  const byLeaf = new Map<string, string | null>();
  for (const n of graph.nodes) byLeaf.set(leafOf(n.id), byLeaf.has(leafOf(n.id)) ? null : n.id);
  const guess = new Map<string, string>();
  for (const id of recorded) {
    const to = id && !own.has(id) && !id.includes(SEGMENT_SEP) ? byLeaf.get(id) : null;
    if (id && to && parentOf(to)) guess.set(id, to);
  }
  const entered = new Set([...guess.values()].filter((to) => graph.edges.some((e) => e.from === parentOf(to) && e.to === to)).map(parentOf));
  return (id) => { const to = guess.get(id); return to && entered.has(parentOf(to)) ? to : id; };
}
