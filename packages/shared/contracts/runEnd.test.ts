// How a run ended, read from its stations (changeCard.ts endStation). The
// AgentWatch spine counts as a line run (its graph has the card gate and the
// watch) but passes through a `dissolve` step on its way to Investigate and
// closes at its own `dissolved_at_<step>` stations, so the line's `dissolve`
// end is an end only where the run stopped. The shapes are Union's real runs
// of 2026-10-25.
import { describe, expect, test } from "bun:test";
import { closedAtStep } from "./causeHistory";
import { lineRunOutcome, runEnd } from "./changeCard";

const AGENTWATCH_GRAPH = ["bind", "dissolve", "dissolved_at_dissolve", "waiting_at_dissolve", "failed_at_dissolve", "investigate", "refine", "dissolved_at_refine", "failed_at_refine", "kept", "prove", "propose", "build", "verify", "card", "decide", "ship", "merge", "watch", "drop", "exit"].map((id) => ({ id }));
const LINE_GRAPH = ["ground", "prove", "dissolve", "card", "decide", "ship", "watch", "drop", "park", "exit"].map((id) => ({ id }));

/** A run that visited `ids` in order, a minute apart; the last one `status` (completed unless named). */
function run(graph: { id: string }[], ids: string[], last: "completed" | "running" = "completed") {
  const t0 = 1_792_900_000_000;
  const node_statuses = ["start", ...ids].map((node_id, i, all) => {
    const started_at = t0 + i * 60_000;
    const done = i < all.length - 1 || last === "completed";
    return { node_id, status: done ? "completed" : "running", outcome: done ? "success" : null, started_at, ...(done ? { completed_at: started_at + 30_000 } : {}) };
  });
  return { graph_nodes: graph, node_statuses };
}

describe("an AgentWatch run's end", () => {
  test("a run still working past its dissolve step has not ended", () => {
    const r = run(AGENTWATCH_GRAPH, ["bind", "dissolve", "investigate", "refine", "kept", "prove"], "running");
    expect(runEnd(r)).toBeNull();
    expect(lineRunOutcome(r)).toBeNull();
  });

  test("a run waiting on its card has not ended", () => {
    expect(lineRunOutcome(run(AGENTWATCH_GRAPH, ["bind", "dissolve", "investigate", "refine", "kept", "prove", "propose", "build", "verify", "card", "decide"], "running"))).toBeNull();
  });

  test("a run that stopped at Refine reached no end", () => {
    expect(runEnd(run(AGENTWATCH_GRAPH, ["bind", "dissolve", "investigate", "refine", "failed_at_refine", "exit"]))).toBeNull();
  });

  test("a cause closed at Refine reads as dissolved there", () => {
    const end = runEnd(run(AGENTWATCH_GRAPH, ["bind", "dissolve", "investigate", "refine", "dissolved_at_refine", "exit"]));
    expect(end).toMatchObject({ kind: "dissolved", node: "dissolved_at_refine" });
    expect(closedAtStep(end!.node)).toBe("refine");
  });

  test("a cause the dissolve step closed reads as dissolved at Dissolve", () => {
    const end = lineRunOutcome(run(AGENTWATCH_GRAPH, ["bind", "dissolve", "dissolved_at_dissolve", "exit"]));
    expect(end).toMatchObject({ kind: "dissolved", node: "dissolved_at_dissolve" });
    expect(closedAtStep(end!.node)).toBe("dissolve");
  });

  test("a run that merged and started its watch shipped", () => {
    expect(runEnd(run(AGENTWATCH_GRAPH, ["bind", "dissolve", "investigate", "refine", "kept", "prove", "propose", "build", "verify", "card", "decide", "ship", "merge", "watch", "exit"]))?.kind).toBe("shipped");
  });

  test("with no times on its stations, the run's order says it went on", () => {
    const r = { graph_nodes: AGENTWATCH_GRAPH, node_statuses: ["bind", "dissolve", "investigate"].map((node_id) => ({ node_id, status: "completed" })) };
    expect(runEnd(r)).toBeNull();
  });
});

describe("the shipped line's own ends", () => {
  test("the dissolve station the run stopped at dissolved it", () => {
    expect(lineRunOutcome(run(LINE_GRAPH, ["ground", "prove", "dissolve", "exit"]))).toMatchObject({ kind: "dissolved", node: "dissolve" });
  });

  test("a drop and a park end the run at their own station", () => {
    expect(runEnd(run(LINE_GRAPH, ["ground", "prove", "card", "decide", "drop", "exit"]))?.kind).toBe("dropped");
    expect(runEnd(run(LINE_GRAPH, ["ground", "park", "exit"]))?.kind).toBe("parked");
  });
});
