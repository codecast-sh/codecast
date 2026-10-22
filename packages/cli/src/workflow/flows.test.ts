// Segments compose (docs/architecture/flows.md FL3): a `flow="<slug>"` node
// runs that segment's stations in place, read from the repo's
// .codecast/flows/, a file beside the graph, or a flow the CLI ships.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { graphNodeHashes, parseWorkflowFile, parseWorkflowSource, validateWorkflow } from "./parser";
import { runWorkflow } from "./runner";
import { BUILTIN_WORKFLOW_TEMPLATES } from "./templates";

let root: string;
let logs: string[];
const orig = { log: console.log, error: console.error };

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "cast-flows-"));
  fs.mkdirSync(path.join(root, ".codecast", "flows"), { recursive: true });
  logs = [];
  console.log = (...a: unknown[]) => logs.push(a.join(" "));
  console.error = (...a: unknown[]) => logs.push(a.join(" "));
});
afterEach(() => {
  console.log = orig.log;
  console.error = orig.error;
  fs.rmSync(root, { recursive: true, force: true });
});

const write = (rel: string, text: string) => {
  const f = path.join(root, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
  return f;
};

// A segment that passes, asks for changes, or fails on a marker file, and says which.
const GATE = `digraph gate {
  graph [kind="segment", label="Gate", description="Pass or stop on a marker", takes="branch"]
  start [shape=Mdiamond]
  look [label="Look", shape=parallelogram, script="test ! -e ${"$"}marker && echo '{\\"ok\\": true}'"]
  note [label="Note", shape=parallelogram, script="echo saw $look.output"]
  passed [shape=Msquare, label="Passed"]
  failed [shape=Msquare, label="Failed", stop="The marker was there."]
  start -> look
  look -> note [condition="outcome = success and look.json.ok = true"]
  look -> failed [condition="outcome = failure"]
  note -> passed
}`;

describe("expanding a segment", () => {
  test("its stations join the graph under the node's name, with their references renamed", () => {
    write(".codecast/flows/gate.cast", GATE);
    const file = write("flows/main.cast", `digraph main {
      start [shape=Mdiamond]
      gate [flow="gate", label="Marker gate"]
      after [shape=parallelogram, script="echo after"]
      exit [shape=Msquare]
      start -> gate -> after -> exit
    }`);
    const g = parseWorkflowFile(file);
    expect(validateWorkflow(g)).toEqual([]);
    expect([...g.nodes.keys()].sort()).toEqual(["after", "exit", "gate", "gate__failed", "gate__look", "gate__note", "gate__passed", "start"]);
    expect(g.nodes.get("gate")).toMatchObject({ type: "conditional", label: "Marker gate", segment_entry: true, segment_flow: "gate" });
    expect(g.nodes.get("gate__note")!.script).toBe("echo saw $gate__look.output");
    expect(g.nodes.get("gate__note")).toMatchObject({ segment: "gate", segment_label: "Marker gate" });
    expect(g.edges).toContainEqual({ from: "gate__look", to: "gate__note", condition: "outcome = success and gate__look.json.ok = true" });
    // The plain exit leaves by the node's own edge; the stop exit stays a stop.
    expect(g.edges).toContainEqual({ from: "gate__passed", to: "after" });
    expect(g.nodes.get("gate__failed")).toMatchObject({ type: "exit", stop: "The marker was there." });
    expect(g.sources).toContain(path.join(root, ".codecast", "flows", "gate.cast"));
  });

  test("prose naming a station is left alone; only $station. references move", () => {
    write(".codecast/flows/one.cast", `digraph one {
      start [shape=Mdiamond]
      review [prompt="Read the diff. End the review. Then read $review.output and $review_note."]
      done [shape=Msquare]
      start -> review -> done
    }`);
    const g = parseWorkflowSource(`digraph m { start [shape=Mdiamond] r [flow="one"] exit [shape=Msquare] start -> r -> exit }`, root);
    expect(g.nodes.get("r__review")!.prompt).toBe("Read the diff. End the review. Then read $r__review.output and $review_note.");
  });

  test("a node that routes failure takes the stop exit as a failing step, and .exit names the exit", () => {
    write(".codecast/flows/gate.cast", GATE);
    const g = parseWorkflowSource(`digraph m {
      start [shape=Mdiamond]
      gate [flow="gate"]
      fix [shape=parallelogram, script="echo fix"]
      exit [shape=Msquare]
      start -> gate
      gate -> exit [condition="outcome = success and gate.exit = passed"]
      gate -> fix  [condition="outcome = failure"]
      fix -> exit
    }`, root);
    expect(validateWorkflow(g)).toEqual([]);
    expect(g.nodes.get("gate__failed")).toMatchObject({ type: "command", segment_exit: "stop" });
    expect(g.edges).toContainEqual({ from: "gate__failed", to: "fix", condition: "outcome = failure" });
    expect(g.edges).toContainEqual({ from: "gate__passed", to: "exit", condition: "outcome = success and gate__passed.json.exit = passed" });
    expect(g.edges.filter((e) => e.from === "gate__passed").map((e) => e.to)).toEqual(["exit"]);
  });

  test("segments nest, a segment that names itself is refused, and an unknown one says where it looked", () => {
    write(".codecast/flows/gate.cast", GATE);
    write(".codecast/flows/twice.cast", `digraph twice { start [shape=Mdiamond] a [flow="gate"] b [flow="gate"] done [shape=Msquare] start -> a -> b -> done }`);
    const g = parseWorkflowSource(`digraph m { start [shape=Mdiamond] t [flow="twice"] exit [shape=Msquare] start -> t -> exit }`, root);
    expect(g.nodes.has("t__a__look")).toBe(true);
    expect(g.nodes.has("t__b__look")).toBe(true);
    expect(validateWorkflow(g)).toEqual([]);

    write(".codecast/flows/loop.cast", `digraph loop { start [shape=Mdiamond] l [flow="loop"] done [shape=Msquare] start -> l -> done }`);
    expect(() => parseWorkflowSource(`digraph m { start [shape=Mdiamond] l [flow="loop"] exit [shape=Msquare] start -> l -> exit }`, root)).toThrow(/comes back to itself/);
    expect(() => parseWorkflowSource(`digraph m { start [shape=Mdiamond] x [flow="nowhere"] exit [shape=Msquare] start -> x -> exit }`, root)).toThrow(/not in the pool/);
  });

  test("a change to a segment changes the stations of every flow that uses it", () => {
    write(".codecast/flows/gate.cast", GATE);
    const main = `digraph m { start [shape=Mdiamond] gate [flow="gate"] exit [shape=Msquare] start -> gate -> exit }`;
    const before = graphNodeHashes(parseWorkflowSource(main, root));
    write(".codecast/flows/gate.cast", GATE.replace("echo saw", "echo found"));
    const after = graphNodeHashes(parseWorkflowSource(main, root));
    const changed = before.filter((b) => after.find((a) => a.id === b.id)?.h !== b.h).map((b) => b.id);
    expect(changed).toEqual(["gate__note"]);
  });
});

describe("running a segment", () => {
  const MAIN = `digraph main {
    start [shape=Mdiamond]
    gate [flow="gate"]
    after [shape=parallelogram, script="echo after-the-gate"]
    exit [shape=Msquare]
    start -> gate -> after -> exit
  }`;

  test("a passing segment runs its stations, then the node's next station", async () => {
    write(".codecast/flows/gate.cast", GATE.replace("${marker}", "none").replace("$marker", path.join(root, "absent")));
    const g = parseWorkflowSource(MAIN, root);
    expect(await runWorkflow(g, { cwd: root })).toBe("completed");
    const said = logs.join("\n");
    expect(said).toContain("after-the-gate");
  });

  test("a segment's stop exit ends the run in the segment's words", async () => {
    write("marker", "");
    write(".codecast/flows/gate.cast", GATE.replace("$marker", path.join(root, "marker")));
    const g = parseWorkflowSource(MAIN, root);
    expect(await runWorkflow(g, { cwd: root })).toBe("failed");
    expect(logs.join("\n")).not.toContain("after-the-gate");
  });
});

describe("the shipped pool", () => {
  const SEGMENTS = ["check", "review", "eval", "decide", "ship", "prove-implement"];

  test("each starter segment says it is one, and the change line strings four of them", () => {
    for (const slug of SEGMENTS) {
      const g = parseWorkflowSource(BUILTIN_WORKFLOW_TEMPLATES[slug]);
      expect({ slug, errors: validateWorkflow(g), kind: g.kind, has: !!g.description }).toEqual({ slug, errors: [], kind: "segment", has: true });
    }
    const change = parseWorkflowSource(BUILTIN_WORKFLOW_TEMPLATES.change);
    expect(change.kind).toBe("line");
    expect(validateWorkflow(change)).toEqual([]);
    const entries = [...change.nodes.values()].filter((n) => n.segment_entry).map((n) => n.segment_flow);
    expect(entries).toEqual(["check", "review", "decide", "ship"]);
  });

  test("segments read the line's own station files, so the prompts are one copy", () => {
    const review = parseWorkflowSource(BUILTIN_WORKFLOW_TEMPLATES.review);
    const line = parseWorkflowSource(BUILTIN_WORKFLOW_TEMPLATES.line);
    expect(review.nodes.get("review")!.prompt).toBe(line.nodes.get("review")!.prompt);
  });
});
