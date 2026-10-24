import { describe, expect, test } from "bun:test";
import { flowDiagram, runReached, stepStates } from "../flowDiagram";
import { appPool, flowBySlug, pushedFlow } from "../flowPool";
import { flowRunState, readFlowFence } from "../flowFence";
import { flowCommandTarget } from "../flowCommandOutput";

const pool = appPool();
const change = flowBySlug(pool, "change")!;

describe("a flow as a diagram", () => {
  test("the change line reads as its four segments, each holding its own steps, ending at Done", () => {
    const d = flowDiagram(change);
    expect(d.steps.map((s) => s.label)).toEqual(["Check", "Review", "Decide", "Ship"]);
    expect(d.steps.map((s) => s.inner.map((i) => i.label))).toEqual([["Verify"], ["Review"], ["Decide"], ["Rebase", "Land"]]);
    expect(d.end).toBe("Done");
    expect(d.steps[3].inner[0].id).toBe("ship__rebase");
  });

  test("routes off the path say where they go: a stop, a loop back, a way out", () => {
    const ship = flowDiagram(change).steps[3];
    const rebase = ship.inner[0].side.map((r) => [r.tone, r.outcome, r.leadsTo]);
    const shipStep = ship.inner[1].side.map((r) => [r.tone, r.outcome, r.leadsTo]);
    expect(rebase).toEqual([["out", "Already landed", null], ["stop", "Conflict", null]]);
    expect(shipStep).toContainEqual(["back", "default branch moved", "Rebase"]);
    expect(shipStep).toContainEqual(["stop", "Not shipped", null]);
  });

  test("a segment's plain end is not a route off its last step", () => {
    const review = flowDiagram(change).steps[1].inner[0];
    expect(review.side.map((r) => r.outcome)).toEqual(["Changes asked", "Rejected"]);
  });

  test("a run lights the steps it passed, stands at its current step, and marks where it stopped", () => {
    const d = flowDiagram(change);
    const running = stepStates(d, { status: "running", current_node_id: "review__review", node_statuses: [{ node_id: "check", status: "completed" }, { node_id: "check__verify", status: "completed" }, { node_id: "review", status: "completed" }] });
    expect(running.get("check")).toBe("done");
    expect(running.get("check__verify")).toBe("done");
    expect(running.get("review__review")).toBe("current");
    expect(running.get("decide")).toBe("idle");
    const stopped = stepStates(d, { status: "failed", current_node_id: "check__failed", node_statuses: [{ node_id: "check__verify", status: "failed" }] });
    expect(stopped.get("check")).toBe("stopped");
    expect(runReached({ status: "failed", current_node_id: "check__failed" }, "check__failed")).toBe(true);
  });
});

describe("a route in words", () => {
  test("a stop says it stops, an end says the flow ends there, a route says where it goes", () => {
    const { routeTail } = require("../flowDiagram");
    expect(routeTail({ outcome: "Checks failed", leadsTo: null, tone: "stop", toId: "x" })).toBe("stops the run");
    expect(routeTail({ outcome: "Already landed", leadsTo: null, tone: "out", toId: "x" })).toBe("ends here");
    expect(routeTail({ outcome: "default branch moved", leadsTo: "Rebase", tone: "back", toId: "x" })).toBe("back to Rebase");
    expect(routeTail({ outcome: "a prompt problem", leadsTo: "Eval", tone: "out", toId: "x" })).toBe("on to Eval");
  });
});

describe("what a flow asks a person", () => {
  test("a gate is said by its own options", () => {
    const { flowAsks } = require("../flowDiagram");
    expect(flowAsks(change)).toEqual(["Ship, revise or drop it"]);
  });
});

describe("a run in words", () => {
  const check = flowBySlug(pool, "check")!;
  test("an ended run is named by the end it reached", () => {
    expect(flowRunState({ status: "completed", current_node_id: "passed" }, check)).toMatchObject({ tone: "passed", words: "Passed" });
    expect(flowRunState({ status: "failed", current_node_id: "failed", fail_reason: "Stopped: The project's check failed: 1 fail" }, check)).toEqual({ tone: "stopped", words: "Checks failed", why: "The project's check failed: 1 fail" });
  });
  test("a live run says where it is, a segment's step under the segment's name", () => {
    expect(flowRunState({ status: "running", current_node_id: "review__review" }, change).words).toBe("At Review");
    expect(flowRunState({ status: "running", current_node_id: "ship__rebase" }, change).words).toBe("At Ship: Rebase");
  });
});

describe("the pool", () => {
  test("holds the shipped flows, and a pushed one by its slug, reading its kind from its source", () => {
    expect(pool.filter((f) => f.kind === "segment").map((f) => f.slug).sort()).toEqual(["check", "decide", "eval", "prove-implement", "review", "ship"]);
    const pushed = pushedFlow({
      _id: "w1", slug: "polish", name: "polish",
      source: 'digraph polish { graph [kind="segment", label="Polish", description="Critique then fix"] }',
      nodes: [{ id: "start", label: "Start", type: "start" }, { id: "critic", label: "Critic", type: "agent" }, { id: "fix", label: "Fix", type: "agent" }, { id: "done", label: "Done", type: "exit" }],
      edges: [{ from: "start", to: "critic" }, { from: "critic", to: "fix" }, { from: "fix", to: "critic", condition: "fix.json.again = true", label: "another round" }, { from: "fix", to: "done", condition: "fix.json.again != true" }],
    });
    expect(pushed).toMatchObject({ kind: "segment", label: "Polish", description: "Critique then fix", where: "pushed" });
    expect(flowDiagram(pushed).steps.map((s) => s.label)).toEqual(["Critic", "Fix"]);
    expect(appPool([{ ...pushed, _id: "w2", slug: "change", source: null, nodes: pushed.nodes, edges: pushed.edges } as any]).filter((f) => f.slug === "change")).toHaveLength(1);
  });
});

describe("the fence and the command", () => {
  test("a flow fence names a flow or a run", () => {
    expect(readFlowFence('{"flow":"change"}')).toEqual({ ok: true, spec: { flow: "change", run: null, title: null } });
    expect(readFlowFence('{"run":"th7abc"}').ok).toBe(true);
    expect(readFlowFence("{}").ok).toBe(false);
  });
  test("a cast flow run names the flow it ran and the run it started", () => {
    const out = "\x1b[1mCheck\x1b[0m started on ct-1: Verify\n  run th780qtq75txys5586ar1ma7fx8gre4b · cast workflow runs --task ct-1";
    expect(flowCommandTarget("run", 'check --title "Fix sum"', out, false)).toEqual({ flow: "check", runId: "th780qtq75txys5586ar1ma7fx8gre4b", dryRun: false });
    expect(flowCommandTarget("run", "change --dry-run", "Nothing started", false)).toEqual({ flow: "change", runId: null, dryRun: true });
    expect(flowCommandTarget("run", "check", '{"run_id":"th7xyzxyzxyzxyzxyzxyzxyz","task":"ct-2"}', false).runId).toBe("th7xyzxyzxyzxyzxyzxyzxyz");
  });
  test("a cast flow show names the flow it drew: a live flow by its block's slug, an older CLI's @handle by none", () => {
    const live = "\x1b[2m\x1b[0m● on   \x1b[1mUnion fix flow\x1b[0m  \x1b[2magentwatch\x1b[0m\n       sources  every source";
    expect(flowCommandTarget("show", '"Union fix flow"', live, false).flow).toBe("agentwatch");
    expect(flowCommandTarget("show", "change --team Codecast", "Change  flow · shipped", false).flow).toBe("change");
    expect(flowCommandTarget("show", "--team Codecast change", "Change  flow · shipped", false).flow).toBe("change");
    expect(flowCommandTarget("show", "@calling", "Calling  @calling · or-3", false).flow).toBeNull();
    expect(flowCommandTarget("on", "", "", true).flow).toBeNull();
  });
  test("a flow the session wrote on stdin is named by where the CLI kept it; a file by its name", () => {
    const kept = "✓ Spine, flaky test (line, draft of jx7bm3n): Investigate → Implement → Review\nkept at ../.codecast/session-flows/flaky-fix/flaky-fix.cast";
    expect(flowCommandTarget("validate", "- <<'EOF'\ndigraph flaky_fix {}\nEOF", kept, false)).toEqual({ flow: "flaky-fix", runId: null, dryRun: false });
    expect(flowCommandTarget("run", "--task ct-9 - --dry-run", kept, false)).toEqual({ flow: "flaky-fix", runId: null, dryRun: true });
    expect(flowCommandTarget("validate", ".codecast/flows/spine.cast", "✓ Spine", false).flow).toBe("spine");
    expect(flowCommandTarget("validate", "-", "✗ no graph", true).flow).toBeNull();
  });
});

describe("a flow a session built on a backbone", () => {
  // As a run's push stores it: the parser's expanded nodes (no segment fields) and the source as written.
  const row = {
    _id: "w1", slug: "flaky-fix", name: "flaky-fix", workspace: "user:u1",
    source: `digraph flaky_fix { graph [extends="spine", label="Spine, flaky test"] subgraph implement { a -> b } }`,
    nodes: [
      { id: "start", label: "start", type: "start" }, { id: "exit", label: "Shipped", type: "exit" },
      { id: "investigate", label: "Investigate", type: "agent" }, { id: "implement", label: "Implement", type: "conditional" },
      { id: "implement__a", label: "Reproduce", type: "agent" }, { id: "implement__b", label: "Patch", type: "agent" },
      { id: "implement__exit", label: "exit", type: "command" }, { id: "review", label: "Review", type: "agent" },
    ],
    edges: [
      { from: "start", to: "investigate" }, { from: "investigate", to: "implement" }, { from: "implement", to: "implement__a" },
      { from: "implement__a", to: "implement__b" }, { from: "implement__b", to: "implement__exit" },
      { from: "implement__exit", to: "review", condition: "outcome = success" }, { from: "review", to: "exit" },
    ],
  };

  test("draws its written segment as a filled slot, without the segment's exit as a step, and names its base", () => {
    const f = pushedFlow(row);
    expect(f.base).toBe("spine");
    expect(f.label).toBe("Spine, flaky test");
    const d = flowDiagram(f);
    expect(d.steps.map((s) => s.label)).toEqual(["Investigate", "Implement", "Review"]);
    expect(d.steps[1].inner.map((s) => s.label)).toEqual(["Reproduce", "Patch"]);
    expect(d.steps[1].slot).toEqual({ does: "", filled: "generated" });
    expect(f.uses).toEqual([]);
    expect(d.end).toBe("Shipped");
  });

  test("a row with no source says what it wrote in place through its own list", () => {
    const d = flowDiagram(pushedFlow({ ...row, source: null, fills: ["implement"], label: "Flaky fix" }));
    expect(d.steps[1].slot?.filled).toBe("generated");
  });

  test("a backbone's empty slot reads as a slot", () => {
    const backbone = pushedFlow({
      _id: "w2", slug: "spine", name: "spine",
      source: `digraph spine { graph [kind="line"] implement [slot="Make the change", label="Implement"] }`,
      nodes: [{ id: "start", label: "start", type: "start" }, { id: "implement", label: "Implement", type: "agent" }, { id: "exit", label: "Done", type: "exit" }],
      edges: [{ from: "start", to: "implement" }, { from: "implement", to: "exit" }],
    });
    expect(flowDiagram(backbone).steps[0]).toMatchObject({ kind: "segment", slot: { does: "Make the change", filled: "empty" } });
  });
});
