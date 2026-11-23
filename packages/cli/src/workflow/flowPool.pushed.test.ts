// A flow a teammate published (docs/architecture/flows.md FL2) joins this
// checkout's pool from its pool row: the source and each station's file are
// written under the cache as the publisher's checkout held them, so the
// parser reads its prompts, and a slug the repo or the CLI already names wins
// in the listing and in a parse in that checkout, while this machine's index
// still names the team's flow for a run read anywhere else.
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

describe("a team flow the checkout also names", () => {
  const land = (says: string) => `digraph land {
    graph [kind="segment", label="Land"]
    start [shape=Mdiamond]
    merge [label="Merge", prompt="${says}"]
    exit [shape=Msquare]
    start -> merge -> exit
  }`;

  test("is still indexed for this machine, and a parse in the checkout still takes the repo's file", () => {
    const cache = mkdtemp();
    const repo = mkdtemp();
    const elsewhere = mkdtemp();
    const saved = process.env.CODECAST_FLOWS_CACHE;
    process.env.CODECAST_FLOWS_CACHE = cache;
    try {
      const flows = path.join(repo, ".codecast", "flows");
      fs.mkdirSync(flows, { recursive: true });
      fs.writeFileSync(path.join(flows, "land.cast"), land("The repo's landing."));
      fs.writeFileSync(path.join(flows, "ship.cast"), `digraph ship {
        graph [kind="line", label="Ship"]
        start [shape=Mdiamond]
        land [flow="land"]
        exit [shape=Msquare]
        start -> land -> exit
      }`);
      const team = row({ _id: "k57land", slug: "land", name: "land", source: land("The team's landing."), nodes: [{ id: "start" }, { id: "merge" }, { id: "exit" }], origin: { file: ".codecast/flows/land.cast", files: [] } });
      const pool = poolFlows(repo, null, [team], cache);
      expect(pool.filter((f) => f.slug === "land").map((f) => f.where)).toEqual(["repo"]);
      const index = JSON.parse(fs.readFileSync(path.join(cache, "index.json"), "utf-8"));
      expect(index.land).toBe(path.join(cache, "k57land", ".codecast/flows/land.cast"));
      expect(parseWorkflowFile(path.join(flows, "ship.cast")).nodes.get("land__merge")?.prompt).toBe("The repo's landing.");
      fs.writeFileSync(path.join(elsewhere, "ship.cast"), fs.readFileSync(path.join(flows, "ship.cast"), "utf-8"));
      expect(parseWorkflowFile(path.join(elsewhere, "ship.cast")).nodes.get("land__merge")?.prompt).toBe("The team's landing.");
    } finally {
      if (saved === undefined) delete process.env.CODECAST_FLOWS_CACHE;
      else process.env.CODECAST_FLOWS_CACHE = saved;
    }
  });
});

describe("a retired flow's stored row", () => {
  // A run of quick-change before the library retired it left a workflows row of that name in its runner's pool.
  const quick = () => row({ _id: "k57quick", slug: "quick-change", name: "quick-change", workspace: "user:u1", mine: true, source: SOURCE.replace("review_pass", "quick_change").replace('kind="segment"', 'kind="line"') });

  test("never joins the pool or this machine's index of team flows", () => {
    const cache = mkdtemp();
    const pool = poolFlows(mkdtemp(), null, [quick(), row()], cache);
    expect(pool.some((f) => f.slug === "quick-change")).toBe(false);
    expect(pool.some((f) => f.slug === "review-pass")).toBe(true);
    expect(Object.keys(JSON.parse(fs.readFileSync(path.join(cache, "index.json"), "utf-8")))).toEqual(["review-pass"]);
  });
});

test("a plain file an older CLI left where a station folder goes is replaced by the folder", () => {
  const cache = mkdtemp();
  fs.mkdirSync(path.join(cache, "k57abc", ".codecast", "flows"), { recursive: true });
  fs.writeFileSync(path.join(cache, "k57abc", ".codecast", "flows", "review_pass"), "a base written at its bare slug");
  const file = materializePushedFlow(row(), cache);
  expect(parseWorkflowFile(file).nodes.get("review")?.prompt).toBe("Read the diff on $branch.");
});
