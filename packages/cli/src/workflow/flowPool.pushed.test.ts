// A flow a teammate published (docs/architecture/flows.md FL2) joins this
// checkout's pool from its pool row: the source and each station's file are
// written under the cache as the publisher's checkout held them, so the
// parser reads its prompts, and a slug the repo or the CLI already names wins.
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { materializePushedFlow, poolFlows, type PushedPoolRow } from "./flowPool.js";
import { parseWorkflowFile } from "./parser.js";

const tmp: string[] = [];
const mkdtemp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "flowpool-")); tmp.push(d); return d; };
afterEach(() => { for (const d of tmp.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

const SOURCE = `digraph review_pass {
  graph [kind="segment", label="Review pass", description="A second read of the diff", takes="branch"]
  start [shape=Mdiamond]
  review [label="Review", prompt="@review_pass/review.md"]
  exit [shape=Msquare]
  start -> review -> exit
}`;

const row = (over: Partial<PushedPoolRow> = {}): PushedPoolRow => ({
  _id: "k57abc", slug: "review-pass", name: "review_pass", source: SOURCE, workspace: "team:t1", by: "Ana", mine: false,
  nodes: [{ id: "start" }, { id: "review", prompt: "Read the diff on $branch." }, { id: "exit" }],
  origin: { file: ".codecast/flows/review-pass.cast", files: [{ node: "review", prompt: ".codecast/flows/review_pass/review.md" }] },
  ...over,
});

describe("a published flow in the pool", () => {
  test("materializes as the publisher's checkout held it, and parses with its station prompts", () => {
    const cache = mkdtemp();
    const file = materializePushedFlow(row(), cache);
    expect(file).toBe(path.join(cache, "k57abc", ".codecast/flows/review-pass.cast"));
    expect(parseWorkflowFile(file).nodes.get("review")?.prompt).toBe("Read the diff on $branch.");
  });

  test("never writes outside its own directory", () => {
    const cache = mkdtemp();
    materializePushedFlow(row({ origin: { file: "../../escape.cast", files: [{ node: "review", prompt: "../../../escape.md" }] } }), cache);
    expect(fs.existsSync(path.join(cache, "k57abc", "review-pass.cast"))).toBe(true);
    expect(fs.readdirSync(cache)).toEqual(["k57abc"]);
    expect(fs.existsSync(path.join(path.dirname(cache), "escape.md"))).toBe(false);
  });

  test("lists as the team's beside the repo and shipped flows, and a slug they name wins", () => {
    const cache = mkdtemp();
    const repo = mkdtemp();
    const pool = poolFlows(repo, null, [row(), row({ _id: "k57dup", slug: "change" })], cache);
    const f = pool.find((p) => p.slug === "review-pass")!;
    expect([f.where, f.by, f.kind, f.label, f.takes, f.errors]).toEqual(["team", "Ana", "segment", "Review pass", ["branch"], []]);
    expect(pool.filter((p) => p.slug === "change").map((p) => p.where)).toEqual(["shipped"]);
  });
});

describe("a published flow as a segment", () => {
  test("a repo flow that names a team flow by slug runs its steps, read from this machine's copy", () => {
    const cache = mkdtemp();
    const repo = mkdtemp();
    const saved = process.env.CODECAST_FLOWS_CACHE;
    process.env.CODECAST_FLOWS_CACHE = cache;
    try {
      fs.mkdirSync(path.join(repo, ".codecast", "flows"), { recursive: true });
      fs.writeFileSync(path.join(repo, ".codecast", "flows", "ship-it.cast"), `digraph ship_it {
        graph [kind="line", label="Ship it"]
        start [shape=Mdiamond]
        second [flow="review-pass"]
        exit [shape=Msquare]
        start -> second -> exit
      }`);
      const pool = poolFlows(repo, null, [row()]);
      const shipIt = pool.find((f) => f.slug === "ship-it")!;
      expect(shipIt.errors).toEqual([]);
      expect(shipIt.uses).toEqual(["review-pass"]);
      const graph = parseWorkflowFile(path.join(repo, ".codecast", "flows", "ship-it.cast"));
      expect(graph.nodes.get("second__review")?.prompt).toBe("Read the diff on $branch.");
      expect(fs.existsSync(path.join(cache, "index.json"))).toBe(true);
    } finally {
      if (saved === undefined) delete process.env.CODECAST_FLOWS_CACHE;
      else process.env.CODECAST_FLOWS_CACHE = saved;
    }
  });
});
