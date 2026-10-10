import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { dotQuote, graphOrigin, LineGraphError, planGraphEdit, runLineGraphEdit } from "./lineGraphEdit";
import { graphHash, graphNodeHashes, parseWorkflowFile, parseWorkflowSource } from "./workflow/parser";

const CAST = `digraph watch {
  graph [goal="$task_title"]
  start [shape=Mdiamond, label="Start"]
  exit  [shape=Msquare, label="Exit"]
  investigate [label="Investigate", backend=session, agent=claude, prompt="@watch/investigate.md"]
  gate [label="Proposal", shape=hexagon, prompt="Approve the fix?"]
  start -> investigate
  investigate -> gate
  gate -> exit [label="[A] Approve"]
}
`;
const PROMPT = "Find the mechanism behind $bind.json.cluster_id.\n\nReport it.\n";

let root: string;
let castAbs: string;
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "graph-edit-")));
  spawnSync("git", ["init", "-q", root]);
  fs.mkdirSync(path.join(root, "outreach/line/watch"), { recursive: true });
  castAbs = path.join(root, "outreach/line/watch.cast");
  fs.writeFileSync(castAbs, CAST);
  fs.writeFileSync(path.join(root, "outreach/line/watch/investigate.md"), PROMPT);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("graphOrigin", () => {
  test("names the checkout, the .cast and each station's file, with the hash its runs record", () => {
    const graph = parseWorkflowFile(castAbs);
    const o = graphOrigin(castAbs, graph, "dev-1")!;
    expect(o.root).toBe(root);
    expect(o.file).toBe("outreach/line/watch.cast");
    expect(o.files).toEqual([{ node: "investigate", prompt: "outreach/line/watch/investigate.md" }]);
    expect(o.graph_hash).toBe(graphHash(graph));
    expect(o.nodes).toEqual(graphNodeHashes(graph));
  });

  test("a graph outside any checkout has no origin", () => {
    const loose = fs.mkdtempSync(path.join(os.tmpdir(), "graph-loose-"));
    const f = path.join(loose, "x.cast");
    fs.writeFileSync(f, CAST);
    expect(graphOrigin(f, parseWorkflowFile(f), "dev-1")).toBeNull();
    fs.rmSync(loose, { recursive: true, force: true });
  });
});

describe("planGraphEdit", () => {
  test("a step with its own file gets that file rewritten; the step's hash moves, no other step's does", () => {
    const before = graphNodeHashes(parseWorkflowFile(castAbs));
    const plan = planGraphEdit(castAbs, { node: "investigate", text: "Find the mechanism. Say it in one line.\n" }, { root });
    expect(plan.changed).toBe(true);
    expect(plan.writes).toEqual([{ file: path.join(root, "outreach/line/watch/investigate.md"), content: "Find the mechanism. Say it in one line.\n" }]);
    expect(plan.was_hash).toBe(before.find((n) => n.id === "investigate")!.h);
    expect(plan.node_hash).not.toBe(plan.was_hash);
    // Nothing was written by the plan.
    expect(fs.readFileSync(path.join(root, "outreach/line/watch/investigate.md"), "utf8")).toBe(PROMPT);
    // After the write, the graph parses to the planned hashes.
    for (const w of plan.writes) fs.writeFileSync(w.file, w.content);
    const after = parseWorkflowFile(castAbs);
    expect(graphHash(after)).toBe(plan.graph_hash);
    const moved = graphNodeHashes(after).filter((n) => before.find((b) => b.id === n.id)!.h !== n.h).map((n) => n.id);
    expect(moved).toEqual(["investigate"]);
  });

  test("an inline prompt is rewritten in the .cast and reads back exactly", () => {
    const text = 'Approve "the" fix?\n\tWith a \\ backslash.';
    const plan = planGraphEdit(castAbs, { node: "gate", text }, { root });
    expect(plan.writes.map((w) => w.file)).toEqual([castAbs]);
    expect(parseWorkflowSource(plan.writes[0].content).nodes.get("gate")!.prompt).toBe(text);
    expect(plan.writes[0].content).toContain(`prompt=${dotQuote(text)}`);
  });

  test("the same text is no change", () => {
    const plan = planGraphEdit(castAbs, { node: "investigate", text: PROMPT }, { root });
    expect(plan.changed).toBe(false);
    expect(plan.writes).toEqual([]);
  });

  test("a step that moved since the editor read it is refused", () => {
    expect(() => planGraphEdit(castAbs, { node: "investigate", text: "x", base_hash: "deadbeef" }, { root })).toThrow(/changed since it was read/);
  });

  test("a step the graph lacks, an empty text and a file outside the checkout are refused", () => {
    expect(() => planGraphEdit(castAbs, { node: "nope", text: "x" }, { root })).toThrow(LineGraphError);
    expect(() => planGraphEdit(castAbs, { node: "investigate", text: "  " }, { root })).toThrow(/cannot be empty/);
    fs.writeFileSync(castAbs, CAST.replace("@watch/investigate.md", "@../../../../escape.md"));
    expect(() => planGraphEdit(castAbs, { node: "investigate", text: "x" }, { root })).toThrow(/outside the checkout/);
  });
});

describe("runLineGraphEdit", () => {
  test("fences both files, writes, then publishes", async () => {
    const admitted: string[] = [];
    const writes: string[] = [];
    let published = 0;
    const reply = await runLineGraphEdit({ root, file: "outreach/line/watch.cast", node: "investigate", text: "New.\n" }, {
      admit: async (f) => { admitted.push(f); return f; },
      write: (f, c) => { writes.push(f); fs.writeFileSync(f, c); },
      publish: () => { published++; return { ok: "pending" }; },
    });
    expect(admitted).toEqual([castAbs, path.join(root, "outreach/line/watch/investigate.md")]);
    expect(writes).toEqual([path.join(root, "outreach/line/watch/investigate.md")]);
    expect(published).toBe(1);
    expect(reply.changed).toBe(true);
    expect(reply.published).toEqual({ ok: "pending" });
  });

  test("a graph the fence refuses writes nothing", async () => {
    const writes: string[] = [];
    await expect(runLineGraphEdit({ root, file: "outreach/line/watch.cast", node: "investigate", text: "New.\n" }, {
      admit: async () => null,
      write: (f) => { writes.push(f); },
    })).rejects.toThrow(/not a graph in a project this machine tracks/);
    expect(writes).toEqual([]);
  });

  test("only a .cast is a graph", async () => {
    await expect(runLineGraphEdit({ root, file: "outreach/line/watch/investigate.md", node: "investigate", text: "x" }, { admit: async (f) => f, write: () => {} })).rejects.toThrow(/names a \.cast file/);
  });
});
