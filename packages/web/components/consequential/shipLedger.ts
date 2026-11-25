// The confirm for sending a session's change through a flow (flows.md FL4): what starts, what comes back to the
// session, what is asked of a person, which stations can stop it. RunThroughFlow's Ship and the pipeline's Checkouts
// both ask through it.
import { flowAsks, flowDiagram, type DiagramStep } from "../../lib/line/flowDiagram";
import { approvalOf, journeyStages, stagesHolding } from "../../lib/ship/journey";
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
export function shipLedgerFor(flow: ShippedFlow, session: string, count = 1, opts: { drawn?: boolean; from?: string | null; labelOf?: (id: string) => string | undefined; approves?: ReadonlyArray<string> | null } = {}) {
  // Where a drawn lane names a station its own way ("Wait for release"), the rows say what the lane says.
  const stations = flowStations(flow).map((s) => ({ ...s, label: opts.labelOf?.(s.id) ?? s.label }));
  const d = flowDiagram(flow);
  const ends = d.steps.flatMap((s) => [...s.side, ...s.inner.flatMap((i) => i.side)]).filter((r) => r.tone === "stop").map((r) => r.outcome);
  const stages = journeyStages(flow).filter((s) => s.id !== "live");
  // Who is asked reads from approvalOf, as the picker's chip does: every run, only on a side route, or never.
  const approval = approvalOf(flow);
  return flowRunLedger({
    flow: flow.label, session, count, stages, ends: [...new Set(ends)],
    asks: approval.kind === "always" ? flowAsks(flow) : [],
    asksIf: approval.kind === "if" ? approval.when ?? "" : null,
    // A pipeline lane drawn beside the confirm speaks in its stations; a session's Ship in the stages its picker showed,
    // so what can stop it is the stages holding a station that can, never each way a run ends.
    ...(opts.drawn
      ? { stations: stations.map((s) => s.label), stops: [...new Set(stations.filter(stops).map((s) => s.label))] }
      : { stops: stagesHolding(flow, stations.filter(stops).map((s) => s.id)) }),
    drawn: opts.drawn, from: opts.from ?? null, approves: opts.approves ?? null,
  });
}
