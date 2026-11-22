// The intent segment (intent.cast, flows.md FL4) composed into a flow and run
// offline: a fake `cast` on PATH answers the asker and the diff and runs the
// real `cast workflow clear` code (runsCli.clearRun) against a fake server,
// which also stands in for the model. Only a model answer that clears, and a
// server that accepts its citation, reach Cleared; everything else reaches Ask.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawnSync } from "child_process";
import { parseWorkflowSource, validateWorkflow } from "./parser";
import { expandScriptVars, lineRunDir, runWorkflow } from "./runner";
import { BUILTIN_WORKFLOW_TEMPLATES } from "./templates";
import { isolateCodecastDirEachTest } from "../test-helpers/codecastDir.js";
isolateCodecastDirEachTest("cast-intent-");
setDefaultTimeout(60_000);

const FLOW = `digraph intentcase {
  start [shape=Mdiamond]
  intent [flow="intent"]
  landed [shape=parallelogram, script="echo ROUTE=landed"]
  asked  [shape=parallelogram, script="echo ROUTE=asked"]
  done [shape=Msquare]
  start -> intent
  intent -> asked
  intent -> landed [condition="intent.exit = cleared"]
  landed -> done
  asked -> done
}`;

const ASKER = {
  chain: [], starter_id: "u_ana", starter_name: "Ana",
  typed: [{ short_id: "jx7lead", line: 115, provenance: "typed_local" }],
  text: "[jx7lead:115] Ana (typed_local): Yes, ship this and shepherd it into production.",
};
const SHIP = { ship: true, session: "jx7lead", line: 115, quote: "Yes, ship this and shepherd it into production.", in_scope: true, why: "Ana said ship it's fine; it's in scope." };

describe("the intent segment", () => {
  let server: ReturnType<typeof Bun.serve>;
  let model: any;
  let clearAnswer: any;
  let seen: Array<{ route: string; body: any }>;
  let tmp: string;
  let repo: string;
  let log: string;
  let out: string[];
  const original = { log: console.log, path: process.env.PATH };

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const route = new URL(req.url).pathname;
        const body = await req.json();
        seen.push({ route, body: structuredClone(body) });
        if (route === "/cli/model/call") return Response.json(model);
        if (route === "/cli/workflow-runs/clear") return Response.json(clearAnswer);
        if (route === "/cli/work/get") return Response.json({ short_id: "ct-7", title: "Fix the deploys page", description: "Three bugs on /admin/deploys", status: "open", steps: [] });
        return Response.json({});
      },
    });
  });
  afterAll(() => server.stop(true));

  beforeEach(() => {
    seen = [];
    out = [];
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "intent-"));
    repo = path.join(tmp, "repo");
    fs.mkdirSync(repo);
    const git = (...a: string[]) => spawnSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...a], { encoding: "utf-8" });
    git("init", "-q");
    git("commit", "-q", "--allow-empty", "-m", "base");
    // The change's branch, one commit past the base.
    git("checkout", "-q", "-b", "fix-deploys");
    git("commit", "-q", "--allow-empty", "-m", "fix the deploys page");
    git("checkout", "-q", "-");
    log = path.join(tmp, "cast.log");
    const bin = path.join(tmp, "bin");
    fs.mkdirSync(bin);
    // The fake cast: canned answers for the reads, the real clear for `workflow clear`.
    fs.writeFileSync(path.join(bin, "cast"), `#!/usr/bin/env bun
const fs = require("fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
const verb = args.slice(0, 2).join(" ");
if (verb === "ws path") { console.log(${JSON.stringify(repo)}); process.exit(0); }
if (verb === "flow asker") {
  if (process.env.FAKE_ASKER_FAIL) { console.error("Error: no /cli/sessions/originator route"); process.exit(1); }
  console.log(JSON.stringify(${JSON.stringify(ASKER)})); process.exit(0);
}
if (verb === "flow blind") { console.log(JSON.stringify({ files: 1, added: 3, removed: 1, text: "diff --git a/deploys.tsx b/deploys.tsx" })); process.exit(0); }
if (verb === "workflow clear") {
  // A commit lands on the branch between the read and the clear.
  if (process.env.FAKE_MOVE_BRANCH) require("child_process").spawnSync("sh", ["-c", "cd " + ${JSON.stringify(repo)} + " && git update-ref refs/heads/fix-deploys $(git -c user.name=t -c user.email=t@t commit-tree -m late -p fix-deploys 'fix-deploys^{tree}')"]);
  const opts = {};
  for (let i = 3; i < args.length; i += 2) opts[args[i].replace(/^--/, "")] = args[i + 1];
  const { clearRun } = await import(${JSON.stringify(path.join(import.meta.dir, "runsCli.ts"))});
  await clearRun({ getCliEndpoint: () => ({ siteUrl: ${JSON.stringify(server.url.origin)}, apiToken: "tok" }), detectCurrentSessionId: () => null }, args[2], opts);
  process.exit(0);
}
console.error("fake cast: unplanned " + verb); process.exit(9);
`, { mode: 0o755 });
    process.env.PATH = `${bin}:${original.path}`;
    console.log = (...a: unknown[]) => { out.push(a.join(" ")); };
    model = { ok: true, text: JSON.stringify(SHIP), json: SHIP, cost_usd: 0.01, model: "claude-opus-5-5" };
    clearAnswer = { run_id: "run_1", node_id: "intent__clear", attempt: 1, starter_id: "u_ana", starter_name: "Ana", cite: "jx7lead:115", quote: SHIP.quote };
  });
  afterEach(() => {
    console.log = original.log;
    process.env.PATH = original.path;
    delete process.env.FAKE_ASKER_FAIL;
    delete process.env.FAKE_MOVE_BRANCH;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const runDir = () => lineRunDir(repo, "intentcase-ct-7");
  /** Freeze a change for the run, as `cast flow run` does; `conversation` is its session, absent from a plain shell. */
  const freeze = (conversation: string | null, branch = "fix-deploys") => {
    fs.mkdirSync(runDir(), { recursive: true });
    fs.writeFileSync(path.join(runDir(), "change.json"), JSON.stringify({
      source: "branch", branch, worktree: "fix-deploys", base: "b", tip: "t", paths: [], shared: [], held: [],
      ...(conversation ? { conversation, session: "jx7lead" } : {}),
    }));
  };
  const run = async (conversation: string | null = "conv_lead", branch?: string) => {
    freeze(conversation, branch);
    const outcome = await runWorkflow(parseWorkflowSource(FLOW), { cwd: repo, taskId: "ct-7", runId: "run_1", apiToken: "tok", convexSiteUrl: server.url.origin, pollIntervalMs: 1 });
    expect(outcome).toBe("completed");
    // The station's own output, not the runner's echo of its script.
    const routed = out.filter((l) => /ROUTE=/.test(l) && !l.includes("echo")).map((l) => l.match(/ROUTE=(\w+)/)![1]);
    expect(routed).toHaveLength(1);
    return routed[0];
  };
  const casts = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf-8").trim().split("\n").map((l) => JSON.parse(l)) : []);
  const clears = () => seen.filter((s) => s.route === "/cli/workflow-runs/clear");
  const intentFile = () => path.join(runDir(), "intent.json");
  const head = () => spawnSync("git", ["-C", repo, "rev-parse", "fix-deploys"], { encoding: "utf-8" }).stdout.trim();

  test("the shipped segment validates, and composed it reads the asker, the change and the run's task", async () => {
    expect(validateWorkflow(parseWorkflowSource(BUILTIN_WORKFLOW_TEMPLATES.intent))).toEqual([]);
    expect(await run()).toBe("landed");
    const call = seen.find((s) => s.route === "/cli/model/call")!.body;
    expect(call).toMatchObject({ model: "claude-opus-5-5", max_tokens: 2000, output: "json" });
    expect(call.prompt).toContain("The person who started this run is Ana.");
    expect(call.prompt).toContain(ASKER.text);
    expect(call.prompt).toContain("<task>\nFix the deploys page\n");
    expect(call.prompt).toContain("Three bugs on /admin/deploys");
    expect(call.prompt).toContain("The change (1 files, +3 -1)");
    expect(call.prompt).not.toMatch(/\$\w/);
  });

  test("a valid answer clears through the server with the cited line and quote, and writes intent.json with the head Change diffed", async () => {
    fs.mkdirSync(runDir(), { recursive: true });
    const diffed = head();
    expect(await run()).toBe("landed");
    expect(casts().find((a) => a[0] === "flow" && a[1] === "blind")).toEqual(
      ["flow", "blind", "diff", "--base", "main", "--head", diffed, "--redact", "fix-deploys", "fix-deploys", "jx7lead", "conv_lead"],
    );
    expect(casts().find((a) => a[0] === "flow" && a[1] === "asker")).toEqual(["flow", "asker", "conv_lead", "--task", "ct-7", "--run", "run_1"]);
    expect(clears().map((c) => c.body)).toEqual([{ api_token: "tok", run_id: "run_1", why: SHIP.why, cite: { conversation_short_id: "jx7lead", line: 115 }, quote: SHIP.quote }]);
    expect(JSON.parse(fs.readFileSync(intentFile(), "utf-8"))).toEqual({ starter_id: "u_ana", starter_name: "Ana", cite: "jx7lead:115", quote: SHIP.quote, head: diffed });
  });

  test("a commit that lands on the branch after the read is not the head intent.json records", async () => {
    const diffed = head();
    process.env.FAKE_MOVE_BRANCH = "1";
    expect(await run()).toBe("landed");
    expect(head()).not.toBe(diffed);
    expect(JSON.parse(fs.readFileSync(intentFile(), "utf-8")).head).toBe(diffed);
  });

  test("a quote with quotes, a dollar sign and an apostrophe reaches the server as written", async () => {
    const quote = `ship it, it's "done" -- $HOME and \`ls\``;
    model = { ...model, json: { ...SHIP, quote } };
    expect(await run()).toBe("landed");
    expect(clears()[0].body.quote).toBe(quote);
  });

  const asks: Array<[string, () => void, string | null]> = [
    ["ship false", () => { model = { ...model, json: { ...SHIP, ship: false, session: "", line: 0, quote: "" } }; }, "conv_lead"],
    ["out of scope", () => { model = { ...model, json: { ...SHIP, in_scope: false } }; }, "conv_lead"],
    ["an answer that is not JSON", () => { model = { ok: true, text: "I think they wanted it shipped.", cost_usd: 0.01 }; }, "conv_lead"],
    ["a failed model call", () => { model = { ok: false, reason: "budget", error: "no room", cost_usd: 0 }; }, "conv_lead"],
    ["no line cited", () => { model = { ...model, json: { ...SHIP, line: 0 } }; }, "conv_lead"],
    ["no session behind the change", () => {}, null],
    ["a branch that does not resolve", () => {}, "conv_lead|no-such-branch"],
    ["the asker failing", () => { process.env.FAKE_ASKER_FAIL = "1"; }, "conv_lead"],
    ["the server refusing the citation", () => { clearAnswer = { error: "Not cleared: jx7lead:115 is not a line a person typed" }; }, "conv_lead"],
  ];
  for (const [name, arrange, conversation] of asks) {
    test(`${name} asks, and leaves no intent.json`, async () => {
      fs.mkdirSync(runDir(), { recursive: true });
      // A stale clear from an earlier run never reads as this one's.
      fs.writeFileSync(intentFile(), '{"starter_id": "u_old"}');
      arrange();
      const [conv, branch] = conversation ? conversation.split("|") : [null, undefined];
      expect(await run(conv, branch)).toBe("asked");
      expect(fs.existsSync(intentFile())).toBe(false);
      if (name !== "the server refusing the citation") expect(clears()).toEqual([]);
    });
  }

  test("the clear script quotes every value the model wrote", () => {
    const clear = parseWorkflowSource(BUILTIN_WORKFLOW_TEMPLATES.intent).nodes.get("clear")!.script!;
    const read = JSON.stringify({ ...SHIP, quote: "it's; rm -rf /", why: "$(whoami)" });
    expect(expandScriptVars(clear, { run_id: "run_1", run_dir: "/r", "read.json": read })).toBe(
      `_head="$(cat '/r'/intent-head)" && cast workflow clear 'run_1' --cite 'jx7lead':'115' --quote 'it'\\''s; rm -rf /' --why '$(whoami)' --record '/r'/intent.json --head "$_head"`,
    );
  });
});
