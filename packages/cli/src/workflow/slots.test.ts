import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { emptySlots, graphSlots, parseWorkflowFile, parseWorkflowSource, validateWorkflow } from "./parser";
import { foldFlow } from "@codecast/shared/contracts/flowPool";

// A library flow as a backbone with slots, and flows that extend it and fill
// them with steps they write in place (parser.ts parseWorkflowSource).
const files = (fs: Record<string, string>) => (abs: string) => fs[abs] ?? null;

const SPINE = `digraph spine {
  graph [kind="line", label="Spine", takes="task"]
  start [shape=Mdiamond]
  exit  [shape=Msquare, label="Shipped"]
  investigate [prompt="Find the cause of $task_title."]
  implement [slot="Make the change the investigation calls for", label="Implement"]
  review [prompt="Review the branch."]
  start -> investigate -> implement
  implement -> review [condition="outcome = success"]
  implement -> exit [condition="outcome = failure"]
  review -> exit
}`;

const REPO = { "/r/.codecast/flows/spine.cast": SPINE };

describe("a backbone with a slot", () => {
  test("parses, names its empty slot, and does not run", () => {
    const g = parseWorkflowFile("/r/.codecast/flows/spine.cast", { read: files(REPO) });
    expect(validateWorkflow(g)).toEqual([]);
    expect(emptySlots(g)).toEqual([{ id: "implement", label: "Implement", does: "Make the change the investigation calls for" }]);
    const implement = foldFlow([...g.nodes.values()], g.edges).stations.find((s) => s.id === "implement")!;
    expect(implement.kind).toBe("segment");
    expect(implement.slot).toEqual({ does: "Make the change the investigation calls for", filled: "empty" });
  });

  test("a variant extends it by name and fills the slot with steps it writes", () => {
    const g = parseWorkflowFile("/r/session/fix.cast", {
      read: files({
        ...REPO,
        "/r/session/fix.cast": `digraph fix {
          graph [extends="spine", label="Spine, flaky test"]
          subgraph implement {
            reproduce [prompt="Reproduce the flake 20 times."]
            patch [prompt="Patch the race."]
            prove [shape=parallelogram, script="bun test --rerun-each 20"]
            reproduce -> patch -> prove
          }
        }`,
      }),
    });
    expect(validateWorkflow(g)).toEqual([]);
    expect(emptySlots(g)).toEqual([]);
    expect(graphSlots(g)).toEqual([{ id: "implement", label: "Implement", does: "Make the change the investigation calls for", filled: "generated" }]);
    expect(g.nodes.get("implement__reproduce")!.prompt).toBe("Reproduce the flake 20 times.");
    expect(g.nodes.get("implement__patch")!.segment_generated).toBe(true);
    // The backbone's own stations and routes stay.
    expect(g.nodes.get("investigate")!.prompt).toBe("Find the cause of $task_title.");
    expect(g.edges.some((e) => e.from === "investigate" && e.to === "implement")).toBe(true);
    expect(g.edges.filter((e) => e.to === "review").map((e) => e.from)).toEqual(["implement__exit"]);
    const folded = foldFlow([...g.nodes.values()], g.edges);
    expect(folded.stations.filter((s) => s.main).map((s) => s.label)).toEqual(["investigate", "Implement", "review"]);
    expect(folded.stations.find((s) => s.id === "implement")).toMatchObject({ steps: 3, slot: { filled: "generated" } });
    expect(folded.uses).toEqual([]);
  });

  test("a fill that writes its own start and exit is read as written", () => {
    const g = parseWorkflowFile("/r/v.cast", {
      read: files({ ...REPO, "/r/v.cast": `digraph v { graph [extends=".codecast/flows/spine.cast"] subgraph implement { s [shape=Mdiamond] e [shape=Msquare] a [prompt="x"] s -> a -> e } }` }),
    });
    expect(emptySlots(g)).toEqual([]);
    expect(g.nodes.has("implement__a")).toBe(true);
  });

  test("a slot's own flow= runs when nothing fills it", () => {
    const g = parseWorkflowSource(`digraph b { graph [kind="line"] start [shape=Mdiamond] exit [shape=Msquare] check [slot="Prove the change", flow="check"] start -> check -> exit }`);
    expect(emptySlots(g)).toEqual([]);
    expect(graphSlots(g)[0].filled).toBe("default");
  });

  test("it refuses a fill of a station that is not a slot, a slot that is not there, and a fill with two first steps", () => {
    const run = (body: string) => () => parseWorkflowFile("/r/v.cast", { read: files({ ...REPO, "/r/v.cast": `digraph v { graph [extends="spine"] ${body} }` }) });
    expect(run(`subgraph review { a [prompt="x"] }`)).toThrow(/not a slot; its slots: implement/);
    expect(run(`subgraph build { a [prompt="x"] }`)).toThrow(/no slot build \(its slots: implement\)/);
    expect(run(`subgraph implement { a [prompt="x"] b [prompt="y"] }`)).toThrow(/starts at a and b/);
    expect(run(`subgraph implement { }`)).toThrow(/is empty/);
  });

  test("extends by a name the pool lacks says so, and by a retired one names what replaced it", () => {
    expect(() => parseWorkflowFile("/r/v.cast", { read: files({ "/r/v.cast": `digraph v { graph [extends="nope"] }` }) })).toThrow(/no flow of that name in the pool/);
    // A flow the library retired names what replaced it.
    expect(() => parseWorkflowFile("/r/v.cast", { read: files({ "/r/v.cast": `digraph v { graph [extends="quick-change"] }` }) }))
      .toThrow('/r/v.cast: extends="quick-change": quick-change is no longer in the library: use change (Ship), which asks a person only when the change edits CI');
  });

  test("a stale entry for a retired flow in this machine's index of team flows still names what replaced it", () => {
    const cache = fs.mkdtempSync(path.join(os.tmpdir(), "retired-index-"));
    const saved = process.env.CODECAST_FLOWS_CACHE;
    process.env.CODECAST_FLOWS_CACHE = cache;
    try {
      const stale = path.join(cache, "k57quick", "quick-change.cast");
      fs.mkdirSync(path.dirname(stale), { recursive: true });
      fs.writeFileSync(stale, `digraph quick_change { graph [kind="line"] start [shape=Mdiamond] exit [shape=Msquare] start -> exit }`);
      fs.writeFileSync(path.join(cache, "index.json"), JSON.stringify({ "quick-change": stale }));
      const read = (p: string) => (p === "/r/v.cast" ? `digraph v { graph [extends="quick-change"] }` : fs.existsSync(p) ? fs.readFileSync(p, "utf-8") : null);
      expect(() => parseWorkflowFile("/r/v.cast", { read }))
        .toThrow('/r/v.cast: extends="quick-change": quick-change is no longer in the library: use change (Ship), which asks a person only when the change edits CI');
    } finally {
      if (saved === undefined) delete process.env.CODECAST_FLOWS_CACHE;
      else process.env.CODECAST_FLOWS_CACHE = saved;
      fs.rmSync(cache, { recursive: true, force: true });
    }
  });

  test("a flow with no base may fill its own nodes in place", () => {
    const g = parseWorkflowSource(`digraph mine { start [shape=Mdiamond] exit [shape=Msquare] fix [label="Fix"] start -> fix -> exit subgraph fix { a [prompt="one"] b [prompt="two"] a -> b } }`);
    expect(validateWorkflow(g)).toEqual([]);
    expect([...g.nodes.keys()]).toContain("fix__b");
    expect(() => parseWorkflowSource(`digraph m { start [shape=Mdiamond] subgraph ghost { a [prompt="x"] } }`)).toThrow(/fills no node/);
  });
});

describe("a station placed after a filled slot", () => {
  test("follows the slot's steps on the passing path, and the slot's failure end stays the slot's", () => {
    const g = parseWorkflowFile("/r/session/fix.cast", {
      read: files({
        ...REPO,
        "/r/session/fix.cast": `digraph fix {
          graph [extends="spine"]
          lint [after="implement", label="Lint", shape=parallelogram, script="bun lint"]
          subgraph implement { patch [prompt="Patch it."] }
        }`,
      }),
    });
    expect(validateWorkflow(g)).toEqual([]);
    expect(g.edges.filter((e) => e.to === "lint").map((e) => [e.from, e.condition])).toEqual([["implement__exit", "outcome = success"]]);
    expect(g.edges.filter((e) => e.from === "lint")).toEqual([{ from: "lint", to: "review", condition: "outcome = success" }]);
    const folded = foldFlow([...g.nodes.values()], g.edges);
    expect(folded.stations.filter((s) => s.main).map((s) => s.label)).toEqual(["investigate", "Implement", "Lint", "review"]);
  });
});
