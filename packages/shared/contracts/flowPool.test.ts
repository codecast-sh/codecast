// A session's graph saved to the library (convex flowLibrary.save): its graph
// attributes rewritten with every other byte kept, and a flow's base read the
// same way whether a save named it or the graph extends a file.
import { expect, test } from "bun:test";
import { flowBase, flowGraphAttr, flowPathWords, foldFlow, publishableFlowSource, sourceTakesSessionChange, withGraphAttrs } from "./flowPool";
import { flowEditWords, type FlowEditChange } from "./flowEdit";

test("withGraphAttrs sets and drops graph attributes, quotes and the rest of the source kept", () => {
  const src = `digraph x {\n  graph [kind="line", label="A, b ] c", takes="task", draft="imported", goal="$task_title"]\n  a [label="x"]\n}\n`;
  const out = withGraphAttrs(src, { draft: null, label: `New "name"` });
  expect(flowGraphAttr(out, "draft")).toBe(null);
  expect(out).toContain(`goal="$task_title"`);
  expect(out).toContain(`label="New \\"name\\""`);
  expect(out).toContain(`a [label="x"]`);
  expect(publishableFlowSource(out)).toBe(true);
});

test("a source with no graph list gets one", () => {
  expect(publishableFlowSource(withGraphAttrs(`digraph y {\n a -> b\n}`, { kind: "line" }))).toBe(true);
});

test("flowBase reads a save's base, else the extends file", () => {
  expect(flowBase({ source: `digraph z { graph [extends="../line.cast"] }` })).toBe("line");
  expect(flowBase({ variant_of: "spine", source: null })).toBe("spine");
  expect(flowBase({ source: `digraph z { graph [kind="line"] }` })).toBe(null);
});

test("a flow takes a session's change when it takes a branch and is a whole flow or lands it itself", () => {
  // A flow a session writes for its own change: no kind, but its Land station runs the ship segment.
  const own = `digraph land_built_change {\n  graph [label="Built change", takes="task,branch", draft="jx7dhj9"]\n  check [flow="check"]\n  land [label="Land", flow="ship"]\n}`;
  expect(sourceTakesSessionChange(own)).toBe(true);
  expect(sourceTakesSessionChange(`digraph x { graph [takes="branch"]; land [flow=ship]; }`)).toBe(true);
  expect(sourceTakesSessionChange(`digraph x { graph [takes="branch"]; land [flow="ship-now"]; }`)).toBe(false);
  expect(sourceTakesSessionChange(`digraph change {\n  graph [kind="line", takes="task,branch"]\n}`)).toBe(true);
  // The check segment alone takes a branch but lands nothing; a task flow takes no branch.
  expect(sourceTakesSessionChange(`digraph check {\n  graph [kind="segment", takes="branch"]\n  verify [flow="checker"]\n}`)).toBe(false);
  expect(sourceTakesSessionChange(`digraph line {\n  graph [kind="line", takes="task"]\n  ship [flow="ship"]\n}`)).toBe(false);
  expect(sourceTakesSessionChange(null)).toBe(false);
});

// A station a variant placed after Check (parser.ts variantEdits) as the expanded graph holds it: Check's passing
// exit leads to it, it goes on to Review on success and back to Fix check on failure.
test("the main path runs through a station inserted after a segment, not its way back", () => {
  const n = (id: string, type: string, more: Record<string, unknown> = {}) => ({ id, label: id, shape: "box", type, ...more });
  const nodes = [
    n("start", "start"),
    n("check", "conditional", { label: "Check", segment: "check", segment_entry: true, segment_flow: "check" }),
    n("check__verify", "command", { segment: "check" }),
    n("check__passed", "command", { segment: "check", segment_exit: "done" }),
    n("lint", "command", { label: "Lint" }),
    n("review", "conditional", { label: "Review", segment: "review", segment_entry: true, segment_flow: "review" }),
    n("review__review", "agent", { segment: "review" }),
    n("fix_check", "agent", { label: "Fix check", backend: "subject" }),
    n("exit", "exit", { label: "Live" }),
  ] as unknown as Parameters<typeof foldFlow>[0];
  const edges = [
    { from: "start", to: "check" },
    { from: "check", to: "check__verify" },
    { from: "check__verify", to: "check__passed", condition: "outcome = success" },
    { from: "check__passed", to: "lint" },
    { from: "lint", to: "review", condition: "outcome = success" },
    { from: "lint", to: "fix_check", condition: "outcome = failure", label: "lint failed" },
    { from: "fix_check", to: "check" },
    { from: "review", to: "review__review" },
    { from: "review__review", to: "exit" },
  ];
  const folded = foldFlow(nodes, edges);
  expect(folded.stations.filter((s) => s.main).map((s) => s.label)).toEqual(["Check", "Lint", "Review"]);
  expect(folded.stations.find((s) => s.id === "lint")!.next).toEqual([
    { to: "Review", toId: "review", when: "outcome = success" },
    { to: "Fix check", toId: "fix_check", when: "lint failed" },
  ]);
});

test("a variant's edits read as one line each", () => {
  const label = (id: string) => ({ check: "Check", review: "Review", decide: "Decide", lint: "Lint", e2e: "E2E" })[id] ?? id;
  expect([
    { op: "add", station: "lint", label: "Lint", after: "check" },
    { op: "add", station: "e2e", before: "review" },
    { op: "guide", station: "review" },
    { op: "skip", station: "decide" },
    { op: "when", station: "e2e", paths: ["landing/**"] },
    { op: "when", station: "e2e", paths: [] },
  ].map((c) => flowEditWords(c as FlowEditChange, label))).toEqual([
    "+ Lint after Check",
    "+ E2E before Review",
    "~ Review: guidance added",
    "Decide skipped",
    "E2E runs when landing/**",
    "E2E always runs",
  ]);
});

test("a fan-out reads as its own name when the graph gives it one, else as its branches joined", () => {
  const n = (id: string, type: string, label = id) => ({ id, label, shape: "box", type });
  const edges = [{ from: "start", to: "checks" }, { from: "checks", to: "ci" }, { from: "checks", to: "review" }, { from: "ci", to: "read" }, { from: "review", to: "read" }, { from: "read", to: "exit" }];
  const nodes = (fanLabel: string) => [n("start", "start"), n("checks", "parallel_fanout", fanLabel), n("ci", "command", "CI"), n("review", "agent", "Review"), n("read", "parallel_fanin", "Read"), n("exit", "exit", "Live")] as unknown as Parameters<typeof foldFlow>[0];
  expect(flowPathWords(foldFlow(nodes("CI and review"), edges)).path).toBe("CI and review");
  expect(flowPathWords(foldFlow(nodes("checks"), edges)).path).toBe("CI + Review");
});
