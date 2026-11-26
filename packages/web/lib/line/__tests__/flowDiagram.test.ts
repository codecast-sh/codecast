import { describe, expect, test } from "bun:test";
import { flowDiagram, runReached, stepResult, stepStates } from "../flowDiagram";
import { appPool, flowBySlug, pushedFlow } from "../flowPool";
import { flowRunState, readFlowFence, runStatusWords } from "../flowFence";
import { flowCommandTarget } from "../flowCommandOutput";
import quickRun from "./quickChangeRun.fixture.json";

const pool = appPool();
const change = flowBySlug(pool, "change")!;
// The graph a run of the retired quick-change pinned when it started (ct-98653), as its workflows row stores it: no
// longer in the pool, so the run's card draws it from the row (useRunFlow). It is built from segments, which the
// tests below read it for.
const quick = pushedFlow(quickRun);

describe("a flow as a diagram", () => {
  test("the change line reads as PR, CI beside review, Verdicts, Merge, Merged and Deploy, ending at Live", () => {
    const d = flowDiagram(change);
    expect(d.steps.map((s) => s.label)).toEqual(["PR", "CI and review", "Verdicts", "Merge", "Merged", "Deploy"]);
    expect(d.steps.map((s) => s.inner.map((i) => i.label))).toEqual([[], ["CI", "Review"], [], [], [], ["Go live"]]);
    expect(d.end).toBe("Live");
  });

  test("what CI and the reviewer find, and a merge conflict, go back to the session; a rejection, silent CI and a refused merge stop", () => {
    const side = (i: number) => flowDiagram(change).steps[i].side.map((r) => [r.tone, r.outcome, r.leadsTo]);
    expect(side(2)).toEqual([
      ["out", "pushed after this round", "Branch moved"], ["stop", "Branch keeps moving", null], ["stop", "Rejected", null], ["out", "CI never reported", "CI"], ["out", "no verdict this round", "Review"], ["stop", "CI never reported", null],
      ["out", "every failure is main's", "Wait for green main"], ["stop", "Main stayed red", null], ["out", "it edits CI", "Why a person"], ["stop", "Needs a person", null], ["stop", "Found work", null],
      ["back", "conflicts with main", "this session"], ["back", "CI red or changes asked", "this session"], ["back", "no verdict", "this session"], ["stop", "No verdicts", null],
    ]);
    expect(side(3)).toEqual([["back", "conflict", "this session"], ["out", "retest", "Retest"], ["stop", "Main keeps moving", null], ["stop", "Not merged", null]]);
  });

  test("a run pinned to the retired quick-change reads as its four segments, each holding its own steps, ending at Live", () => {
    expect(flowBySlug(pool, "quick-change")).toBeNull();
    const d = flowDiagram(quick);
    expect(d.steps.map((s) => s.label)).toEqual(["Check", "Review", "Land", "Deploy"]);
    expect(d.steps.map((s) => s.inner.map((i) => i.label))).toEqual([["Verify"], ["Review"], ["Rebase", "Land"], ["Go live"]]);
    expect(d.end).toBe("Live");
    expect(d.steps[2].inner[0].id).toBe("ship__rebase");
  });

  test("routes off the path say where they go: a stop, a loop back, a way out", () => {
    const ship = flowDiagram(quick).steps[2];
    const rebase = ship.inner[0].side.map((r) => [r.tone, r.outcome, r.leadsTo]);
    const shipStep = ship.inner[1].side.map((r) => [r.tone, r.outcome, r.leadsTo]);
    expect(rebase).toEqual([["out", "Already landed", null], ["back", "Conflict", "this session"]]);
    expect(shipStep).toContainEqual(["back", "default branch moved", "Rebase"]);
    expect(shipStep).toContainEqual(["stop", "Not shipped", null]);
  });

  test("a stage's findings go back to the session the change came from, said once; true stops still stop", () => {
    const routes = (flow: typeof quick, i: number) => { const s = flowDiagram(flow).steps[i]; return [...s.side, ...s.inner.flatMap((x) => x.side)].map((r) => [r.tone, r.outcome, r.leadsTo]); };
    expect(routes(quick, 0)).toEqual([["back", "Checks failed", "this session"], ["stop", "Not checked here", null]]);
    expect(routes(quick, 1)).toEqual([["back", "Changes asked", "this session"], ["stop", "Rejected", null]]);
    expect(routes(change, 5)).toEqual([["stop", "Not merged", null], ["stop", "Deploy stuck", null], ["stop", "Deploy failed", null]]);
  });

  test("a segment's plain end is not a route off its last step", () => {
    const review = flowDiagram(quick).steps[1].inner[0];
    expect(review.side.map((r) => r.outcome)).toEqual(["Changes asked", "Rejected"]);
  });

  test("a run lights the steps it passed, stands at its current step, and marks where it stopped", () => {
    const d = flowDiagram(quick);
    const running = stepStates(d, { status: "running", current_node_id: "review__review", node_statuses: [{ node_id: "check", status: "completed" }, { node_id: "check__verify", status: "completed" }, { node_id: "review", status: "completed" }] });
    expect(running.get("check")).toBe("done");
    expect(running.get("check__verify")).toBe("done");
    expect(running.get("review__review")).toBe("current");
    expect(running.get("ship")).toBe("idle");
    const stopped = stepStates(d, { status: "failed", current_node_id: "check__failed", node_statuses: [{ node_id: "check__verify", status: "failed" }] });
    expect(stopped.get("check")).toBe("stopped");
    expect(runReached({ status: "failed", current_node_id: "check__failed" }, "check__failed")).toBe(true);
  });

  test("a step of any flow but an own-results round reads as it ran, whatever its result's outcome says", () => {
    const d = flowDiagram(quick);
    const r = { status: "completed", current_node_id: "exit", node_statuses: [
      { node_id: "check", status: "completed", started_at: 1 },
      { node_id: "check__verify", status: "completed", started_at: 2, result_preview: '{"outcome":"skipped","note":"No checks documented"}' },
      { node_id: "review__review", status: "completed", started_at: 3, result_preview: '```json\n{"outcome":"ship","left_for_you":"Tag the release"}\n```' },
    ] };
    const states = stepStates(d, r);
    expect([states.get("check"), states.get("check__verify"), states.get("review__review")]).toEqual(["done", "done", "done"]);
    expect(stepResult(r, "check")).toEqual({ outcome: "skipped", note: "No checks documented", leftForYou: null });
    // A step that exits 0 and says it failed passed all the same: only the personal Ship reads its stations' words.
    expect(stepStates(d, { status: "running", current_node_id: "review__review", node_statuses: [{ node_id: "check__verify", status: "completed", result_preview: '{"outcome":"fail","note":"2 tests failed"}' }] }).get("check")).toBe("done");
    expect(stepStates(d, { status: "failed", current_node_id: "check__failed", node_statuses: [{ node_id: "check__verify", status: "failed", result_preview: '{"outcome":"skipped"}' }] }).get("check")).toBe("stopped");
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
    expect(flowAsks(flowBySlug(pool, "decide")!)).toEqual(["Approve merge, revise or drop it"]);
    // The change line asks a person only about a change to CI.
    expect(flowAsks(change)).toEqual(["Approve merge, revise or drop it"]);
  });
});

describe("a run in words", () => {
  test("says a paused run waits for approval and capitalizes the rest", () => {
    expect(runStatusWords("paused")).toBe("Waiting for approval");
    expect(runStatusWords("running")).toBe("Running");
  });
  const check = flowBySlug(pool, "check")!;
  test("an ended run is named by the end it reached", () => {
    expect(flowRunState({ status: "completed", current_node_id: "passed" }, check)).toMatchObject({ tone: "passed", words: "Passed" });
    expect(flowRunState({ status: "failed", current_node_id: "failed", fail_reason: "Stopped: The project's check failed: 1 fail" }, check)).toEqual({ tone: "stopped", words: "Checks failed", why: "The project's check failed: 1 fail" });
  });
  test("a live run says where it is, a segment's step under the segment's name", () => {
    expect(flowRunState({ status: "running", current_node_id: "review" }, change).words).toBe("At Review");
    expect(flowRunState({ status: "running", current_node_id: "ship__rebase" }, quick).words).toBe("At Land: Rebase");
  });
  test("a run waiting on its card is waiting for approval, the card's question its why", () => {
    expect(flowRunState({ status: "paused", current_node_id: "decide", gate_prompt: "Should this ship?\nMore" }, change)).toEqual({ tone: "waiting", words: "Waiting for approval", why: "Should this ship?" });
    expect(flowRunState({ status: "paused", current_node_id: "decide" }, change)).toMatchObject({ words: "Waiting for approval", why: "at Decide" });
  });
  test("a run stopped at a station waiting on a person names the step, never its id", () => {
    expect(flowRunState({ status: "failed", current_node_id: "brief", fail_reason: "Stopped: brief is waiting on a person" }, change).why).toBe("Fix findings is waiting on a person");
    expect(flowRunState({ status: "failed", current_node_id: "brief", fail_reason: "brief stopped: its session was killed while it waited on a person" }, change).why).toBe("Fix findings stopped: its session was killed while it waited on a person");
  });
});

describe("the pool", () => {
  test("holds the shipped flows, and a pushed one by its slug, reading its kind from its source", () => {
    expect(pool.filter((f) => f.kind === "segment").map((f) => f.slug).sort()).toEqual(["check", "decide", "deploy", "eval", "intent", "judge", "prove-implement", "review", "ship"]);
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
    expect(readFlowFence('{"flow":"change"}')).toEqual({ ok: true, spec: { flow: "change", run: null, title: null, edit: null, pipeline: null } });
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

describe("a flow run around one step", () => {
  // onefix's shape: Build sends the work, by its outcome, to a stage that hands it back; Watch then ends the run.
  const n = (id: string, type = "command", label = id[0].toUpperCase() + id.slice(1)) => ({ id, label, type });
  const e = (from: string, to: string, condition?: string, label?: string) => ({ from, to, ...(condition ? { condition } : {}), ...(label ? { label } : {}) });
  const hubFlow = {
    nodes: [n("start", "start"), n("exit", "exit", "Exit"), n("triage", "agent"), n("build", "agent"), n("critique", "agent"), n("decide", "human"), n("push"), n("merge"), n("deploy"), n("watch"), n("closed"), n("stopped")],
    edges: [
      e("start", "triage"), e("triage", "build"),
      e("build", "critique", "build.json.outcome = critique"), e("build", "decide", "build.json.outcome = present"), e("build", "push", "build.json.outcome = ready"),
      e("build", "deploy", "build.json.outcome = landed"), e("build", "watch", "build.json.outcome = watching"), e("build", "closed", "build.json.outcome = closed"), e("build", "stopped", "build.json.outcome = stopped"),
      e("critique", "build"), e("decide", "build"), e("push", "merge", "outcome = success"), e("push", "build", "outcome = failure", "push refused"), e("merge", "build", undefined, "on main"),
      e("deploy", "build"), e("watch", "exit"), e("closed", "exit"), e("stopped", "exit"),
    ],
  };

  test("its stages follow it in the order it names them, a stage's own next step with it, and the path ends where Watch does", () => {
    const d = flowDiagram(hubFlow as any);
    expect(d.hub).toEqual({ id: "build", label: "Build" });
    expect(d.steps.map((s) => s.label)).toEqual(["Triage", "Build", "Critique", "Decide", "Push", "Merge", "Deploy", "Watch"]);
    expect(d.end).toBe("Exit");
  });

  test("the hub keeps only its ends as routes, and each stage's way back leads to it", () => {
    const d = flowDiagram(hubFlow as any);
    const build = d.steps[1].side.map((r) => [r.tone, r.outcome, r.leadsTo]);
    expect(build).toEqual([["out", "Closed", null], ["stop", "Stopped", null]]);
    expect(d.steps.find((s) => s.label === "Merge")!.side).toContainEqual(expect.objectContaining({ tone: "back", leadsTo: "Build" }));
  });
});
