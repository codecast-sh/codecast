// The blind risk judge (templates/judge.cast): what its call reads carries the
// change and the repository's guidelines and nothing that names who made it,
// and the segment routes on the score and leaves it on the run's record.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawnSync } from "child_process";
import { blindDiff, blindGuidelines, guideDirs, renderBlindDiff, scrubAuthorSigns, splitDiff } from "./blindChange";
import { parseWorkflowSource } from "./parser";
import { lineRunDir, runWorkflow, type RunOptions } from "./runner";
import { writeFrozenChange } from "./flowChangeFile";
import { isolateCodecastDirEachTest } from "../test-helpers/codecastDir.js";
isolateCodecastDirEachTest("cast-blind-judge-");

const MAIN = path.resolve(import.meta.dir, "../main.ts");
const AUTHOR = "Dana Whitfield";
const EMAIL = "dana.w@example.org";
const SESSION = "jx7q2zk";
const BRANCH = "codecast/change-ct-4242";

function sh(cwd: string, args: string[], env: Record<string, string> = {}) {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf-8", env: { ...process.env, ...env } });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
}

/** A repository with guidelines (CLAUDE.md a symlink to AGENTS.md, one nested), and a branch whose commit and lines name its author. */
function makeRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "blind-repo-"));
  sh(dir, ["init", "-q", "-b", "main"]);
  sh(dir, ["config", "user.name", "Base Person"]);
  sh(dir, ["config", "user.email", "base@example.org"]);
  fs.writeFileSync(path.join(dir, "AGENTS.md"), "# Rules\nEvery write goes through the store.\n");
  fs.symlinkSync("AGENTS.md", path.join(dir, "CLAUDE.md"));
  fs.mkdirSync(path.join(dir, "pkg"));
  fs.writeFileSync(path.join(dir, "pkg", "CLAUDE.md"), "# pkg\nNever read the network at import time.\n");
  fs.mkdirSync(path.join(dir, "other"));
  fs.writeFileSync(path.join(dir, "other", "CLAUDE.md"), "# other\nUnrelated rules.\n");
  fs.writeFileSync(path.join(dir, "pkg", "store.ts"), "export const a = 1;\n");
  sh(dir, ["add", "-A"]);
  sh(dir, ["commit", "-q", "-m", "base"]);
  sh(dir, ["checkout", "-q", "-b", BRANCH]);
  fs.writeFileSync(path.join(dir, "pkg", "store.ts"), [
    "export const a = 2;",
    `// ${AUTHOR} asked for this; ping ${EMAIL} or Dana with questions (${SESSION}).`,
    "// Co-Authored-By: Claude <noreply@anthropic.com>",
    `export const branch = "${BRANCH}";`,
    "export function write(x: number) { return x * 2; }",
    "",
  ].join("\n"));
  sh(dir, ["add", "-A"]);
  sh(dir, ["commit", "-q", "-m", `feat: double writes\n\nCodecast-Session: ${SESSION}\nCo-Authored-By: Claude <noreply@anthropic.com>`], {
    GIT_AUTHOR_NAME: AUTHOR, GIT_AUTHOR_EMAIL: EMAIL, GIT_COMMITTER_NAME: AUTHOR, GIT_COMMITTER_EMAIL: EMAIL,
  });
  sh(dir, ["checkout", "-q", "main"]);
  return dir;
}

const AUTHOR_SIGNS = [AUTHOR, "Dana", EMAIL, SESSION, BRANCH, "Co-Authored-By", "Codecast-Session", "double writes", "noreply@anthropic.com"];

describe("what the judge reads", () => {
  let repo: string;
  beforeAll(() => { repo = makeRepo(); });
  afterAll(() => fs.rmSync(repo, { recursive: true, force: true }));

  test("the diff keeps the change and drops its author, the commit message, trailers and the branch", () => {
    const d = blindDiff({ cwd: repo, base: "main", head: BRANCH, redact: [BRANCH, SESSION] });
    expect(d.files).toBe(1);
    expect(d.text).toContain("pkg/store.ts (+");
    expect(d.text).toContain("+export function write(x: number) { return x * 2; }");
    expect(d.text).not.toMatch(/^index [0-9a-f]+\.\./m);
    for (const sign of AUTHOR_SIGNS) expect(d.text).not.toContain(sign);
  });

  test("the guidelines are the root's and those above changed files, at the base, each text once", () => {
    const g = blindGuidelines({ cwd: repo, base: "main", head: BRANCH });
    expect(g.files).toEqual(["CLAUDE.md", "pkg/CLAUDE.md"]);
    expect(g.text).toContain("Every write goes through the store.");
    expect(g.text).toContain("Never read the network at import time.");
    expect(g.text).not.toContain("Unrelated rules.");
    expect(g.text.match(/Every write goes through the store/g)!.length).toBe(1);
  });

  test("guideDirs walks from the root down to each changed file's folder", () => {
    expect(guideDirs(["a/b/c.ts", "a/d.ts", "e.ts"])).toEqual(["", "a", "a/b"]);
  });

  test("signature lines go and names go wherever they appear, not words that only contain them", () => {
    const out = scrubAuthorSigns("+// by Dana Whitfield\n+Signed-off-by: x\n+const Danaher = 1; // Dana", ["Dana Whitfield"]);
    expect(out).toBe("+// by [redacted]\n+const Danaher = 1; // [redacted]");
  });

  test("a diff too big for the record keeps every file named and both ends of the big ones", () => {
    const big = (name: string, n: number) => `diff --git a/${name} b/${name}\n--- a/${name}\n+++ b/${name}\n@@ -0,0 +1,${n} @@\n` + Array.from({ length: n }, (_, i) => `+line ${i} "quoted" \\ text`).join("\n");
    const raw = [big("small.ts", 3), big("huge.ts", 20_000), big("bun.lock", 5_000)].join("\n");
    const counts = new Map([["small.ts", { added: 3, removed: 0 }], ["huge.ts", { added: 20_000, removed: 0 }], ["bun.lock", { added: 5_000, removed: 0 }]]);
    const text = renderBlindDiff(splitDiff(raw, counts), 30_000);
    expect(text.length).toBeLessThanOrEqual(30_000);
    expect(text).toContain("small.ts (+3 -0)");
    expect(text).toContain("bun.lock (+5000 -0) [lockfile, binary or snapshot: lines not shown]");
    expect(text).toContain("+line 2 \"quoted\""); // small.ts whole
    expect(text).toContain("+line 19999 "); // huge.ts keeps its tail
    expect(text).toMatch(/\[\.\.\. \d+ lines left out here \.\.\.\]/);
  });
});

describe("the judge segment in a run", () => {
  let repo: string;
  let shim: string;
  let origFetch: typeof fetch;
  let origLog: typeof console.log;
  let origPath: string | undefined;
  let calls: Array<{ route: string; body: any }>;
  let answer: Record<string, unknown>;

  const GRAPH = `digraph t {
    start [shape=Mdiamond]
    judge [flow="judge", above=60]
    landed [shape=Msquare, label="Landed"]
    asked  [shape=Msquare, label="Asked a person"]
    start -> judge
    judge -> landed [condition="judge.exit = low"]
    judge -> asked  [condition="judge.exit != low"]
  }`;

  beforeAll(() => {
    repo = makeRepo();
    // `cast` in the segment's scripts is this tree's CLI.
    shim = fs.mkdtempSync(path.join(os.tmpdir(), "blind-shim-"));
    fs.writeFileSync(path.join(shim, "cast"), `#!/bin/sh\nexec bun ${JSON.stringify(MAIN)} "$@"\n`, { mode: 0o755 });
  });
  afterAll(() => {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(shim, { recursive: true, force: true });
  });
  beforeEach(() => {
    origFetch = globalThis.fetch;
    origLog = console.log;
    origPath = process.env.PATH;
    process.env.PATH = `${shim}:${process.env.PATH}`;
    console.log = () => {};
    calls = [];
    globalThis.fetch = (async (url: any, init: any) => {
      const route = String(url).replace(/^https?:\/\/[^/]+/, "");
      const body = JSON.parse(init?.body || "{}");
      calls.push({ route, body });
      if (route === "/cli/model/call") return new Response(JSON.stringify(answer), { status: 200 });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;
    writeFrozenChange(lineRunDir(repo, "t-run1"), { source: "session", session: SESSION, conversation: "k57abcdefabcdefabcdefabcdefabcd", base: "", tip: "", branch: BRANCH, worktree: "change-ct-4242", paths: ["pkg/store.ts"], shared: [], held: [] });
  });
  afterEach(() => {
    globalThis.fetch = origFetch;
    console.log = origLog;
    process.env.PATH = origPath;
  });

  const options = (): RunOptions => ({ cwd: repo, runId: "run1", apiToken: "tok", convexSiteUrl: "https://convex.test" } as RunOptions);
  const exitTaken = () => calls.filter((c) => c.route === "/cli/workflow-runs/progress" && c.body.node_status === "completed").map((c) => c.body.node_id).filter((id: string) => /^judge__(low|high|unscored)$/.test(id));
  const judgeRecord = () => calls.find((c) => c.route === "/cli/workflow-runs/progress" && c.body.node_id === "judge__judge" && c.body.node_status === "completed")?.body;

  test("a score under the bar lands; the call read the change blind, and the score is on the run", async () => {
    answer = { ok: true, text: '{"risk": 20, "why": "Doubles a value; the store write is unchanged."}', json: { risk: 20, why: "Doubles a value; the store write is unchanged." }, cost_usd: 0.05 };
    expect(await runWorkflow(parseWorkflowSource(GRAPH), options())).toBe("completed");
    const sent = calls.find((c) => c.route === "/cli/model/call")!.body;
    expect(sent.model).toBe("claude-sonnet-5-5");
    expect(sent.prompt).toContain("+export function write(x: number)");
    expect(sent.prompt).toContain("Never read the network at import time.");
    expect(sent.prompt).not.toMatch(/\$\w+\.json/);
    for (const sign of AUTHOR_SIGNS) expect(sent.prompt).not.toContain(sign);
    expect(sent.prompt).not.toContain("k57abcdefabcdef");
    expect(JSON.parse(judgeRecord().result_preview)).toEqual({ risk: 20, why: "Doubles a value; the store write is unchanged." });
    expect(judgeRecord().outcome).toBe("success");
    expect(exitTaken()).toEqual(["judge__low"]);
  }, 60_000);

  test("a score at the composing node's bar goes to a person", async () => {
    answer = { ok: true, text: '{"risk": 60, "why": "x"}', json: { risk: 60, why: "x" }, cost_usd: 0.05 };
    expect(await runWorkflow(parseWorkflowSource(GRAPH), options())).toBe("completed");
    expect(exitTaken()).toEqual(["judge__high"]);
  }, 60_000);

  test("a call that fails, or answers no risk, leaves the change unscored and goes to a person", async () => {
    answer = { ok: false, reason: "budget", error: "the team's model budget for this month has no room", cost_usd: 0 };
    expect(await runWorkflow(parseWorkflowSource(GRAPH), options())).toBe("completed");
    expect(exitTaken()).toEqual(["judge__unscored"]);
    calls = [];
    answer = { ok: true, text: '{"why": "no score"}', json: { why: "no score" }, cost_usd: 0.05 };
    expect(await runWorkflow(parseWorkflowSource(GRAPH), options())).toBe("completed");
    expect(exitTaken()).toEqual(["judge__unscored"]);
  }, 60_000);

  test("the segment's bar defaults to 50", () => {
    const g = parseWorkflowSource(GRAPH.replace(", above=60", ""));
    const conds = g.edges.filter((e) => e.from === "judge__judge").map((e) => e.condition);
    expect(conds).toContain("outcome = success and judge__judge.json.risk >= 50");
    const alone = parseWorkflowSource(fs.readFileSync(path.join(import.meta.dir, "templates", "judge.cast"), "utf-8"), path.join(import.meta.dir, "templates"));
    expect(alone.edges.filter((e) => e.from === "judge").map((e) => e.condition)).toContain("outcome = success and judge.json.risk < 50");
  });
});
