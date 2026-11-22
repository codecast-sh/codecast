// The confirm for sending a session's change through a flow (flows.md FL4): what starts, what comes back to the
// session, what is asked of a person, which stations can stop it. RunThroughFlow's Ship and the pipeline's Checkouts
// both ask through it.
import { flowAsks, flowDiagram, type DiagramStep } from "../../lib/line/flowDiagram";
import { journeyStages } from "../../lib/ship/journey";
import type { ShippedFlow } from "../../lib/line/flowPool";
import { flowRunLedger } from "./ledgers";

/** The passing path's stations as the pipeline draws them: a fan-out's branches each a station, its join none. */
export function flowStations(flow: ShippedFlow): DiagramStep[] {
  return flowDiagram(flow).steps.flatMap((s) => (s.kind === "join" ? [] : s.kind === "parallel" && s.inner.length ? s.inner : [s]));
}

const stops = (s: DiagramStep): boolean => s.side.some((r) => r.tone === "stop") || s.inner.some(stops);

/**
 * `count`: how many sessions ship at once (a checkout's finished work), each through its own run. `drawn`: the confirm
 * draws the stations as a lane; `labelOf` names a station as that lane does. `from`: the checkout it ships from, when that is a risk ("ip-172-31-42-177, 364
 * behind main, conflicts in 10 files").
 */
export function shipLedgerFor(flow: ShippedFlow, session: string, count = 1, opts: { drawn?: boolean; from?: string | null; labelOf?: (id: string) => string | undefined } = {}) {
  // Where a drawn lane names a station its own way ("Wait for release"), the rows say what the lane says.
  const stations = flowStations(flow).map((s) => ({ ...s, label: opts.labelOf?.(s.id) ?? s.label }));
  const d = flowDiagram(flow);
  const ends = d.steps.flatMap((s) => [...s.side, ...s.inner.flatMap((i) => i.side)]).filter((r) => r.tone === "stop").map((r) => r.outcome);
  const stages = journeyStages(flow).filter((s) => s.id !== "live");
  return flowRunLedger({
    flow: flow.label, session, count, stages, asks: flowAsks(flow), ends: [...new Set(ends)],
    stations: stations.map((s) => s.label), stops: [...new Set(stations.filter(stops).map((s) => s.label))], drawn: opts.drawn, from: opts.from ?? null,
  });
}
