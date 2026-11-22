// The confirm for sending a session's change through a flow (flows.md FL4): what starts, what comes back to the
// session, what is asked of a person, how it can end. RunThroughFlow's Ship and the pipeline's Checkouts both ask
// through it.
import { flowAsks, flowDiagram } from "../../lib/line/flowDiagram";
import { journeyStages } from "../../lib/ship/journey";
import type { ShippedFlow } from "../../lib/line/flowPool";
import { flowRunLedger } from "./ledgers";

export function shipLedgerFor(flow: ShippedFlow, session: string) {
  const d = flowDiagram(flow);
  const stops = d.steps.flatMap((s) => [...s.side, ...s.inner.flatMap((i) => i.side)]).filter((r) => r.tone === "stop").map((r) => r.outcome);
  const stages = journeyStages(flow).filter((s) => s.id !== "live");
  return flowRunLedger({ flow: flow.label, session, stages, asks: flowAsks(flow), ends: [...new Set(stops)] });
}
