// End to end (flows.md FL4): what a run reads of a change cut on fresh
// upstream. A reviewer's diff starts at the remote's default branch when the
// run has no frozen change, and a session's change found already on upstream
// when a subject station freezes it again ends the run done rather than going
// back through stages that would read an empty change. Real git with a bare
// origin, a fake server playing the session.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { freezeSessionChange, writeFrozenChange } from "./flowChange";
import { readFrozenChange } from "./flowChangeFile";
import { parseWorkflowSource } from "./parser";
import { lineRunDir, runSlug, runWorkflow } from "./runner";

const ENV = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_NOSYSTEM: "1" };
const saved: Record<string, string | undefined> = {};
let sandbox = "";
let origFetch: typeof fetch;
let origLog: typeof console.log;

beforeAll(() => {
  sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cast-flow-run-")));
  for (const [k, v] of Object.entries({ ...ENV, HOME: sandbox, CODECAST_DIR: path.join(sandbox, ".codecast") })) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  origFetch = globalThis.fetch;
  origLog = console.log;
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  globalThis.fetch = origFetch;
  console.log = origLog;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

// Commits are an hour old, so the transcript's writes (seconds ago) come after them.
const HOUR_AGO = new Date(Date.now() - 3_600_000).toISOString();
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8", env: { ...process.env, ...ENV, GIT_AUTHOR_DATE: HOUR_AGO, GIT_COMMITTER_DATE: HOUR_AGO } }).replace(/\n$/, "");
const CONV = "jx7llllllllllllllllllllllllllll1";

let worlds = 0;
/** A checkout cloned from a bare origin where session CONV wrote a.txt; `land` puts a.txt on origin's main as someone else would. */
function world(content: string) {
  process.env.CODECAST_DIR = path.join(sandbox, `.codecast-${++worlds}`);
  const dir = path.join(sandbox, `w${worlds}`);
  const origin = path.join(dir, "origin.git");
  const seed = path.join(dir, "seed");
  const root = path.join(dir, "shared");
  fs.mkdirSync(seed, { recursive: true });
  git(dir, "init", "-q", "--bare", "-b", "main", origin);
  git(seed, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(seed, "a.txt"), "base\n");
  git(seed, "add", "-A");
  git(seed, "commit", "-qm", "base");
  git(seed, "push", "-q", origin, "main");
  git(dir, "clone", "-q", origin, root);
  fs.writeFileSync(path.join(root, "a.txt"), content);
  const tdir = path.join(sandbox, ".claude", "projects", `-w${worlds}`);
  fs.mkdirSync(tdir, { recursive: true });
  const file = path.join(tdir, `sess-${worlds}.jsonl`);
  fs.writeFileSync(file, JSON.stringify({ type: "assistant", timestamp: new Date().toISOString(), cwd: root, message: { role: "assistant", content: [{ type: "tool_use", id: "t0", name: "Edit", input: { file_path: path.join(root, "a.txt"), old_string: "x", new_string: "y" } }] } }) + "\n");
  fs.mkdirSync(process.env.CODECAST_DIR!, { recursive: true });
  fs.writeFileSync(path.join(process.env.CODECAST_DIR!, "sync-ledger.json"), JSON.stringify({ [file]: { lastSyncedAt: Date.now(), lastSyncedPosition: 0, messageCount: 1, conversationId: CONV, sourceGeneration: { client: "claude", sessionId: `sess-${worlds}`, dev: 0, ino: 0, birthtimeMs: 0, unit: "bytes", watermark: 0, prefixProven: true } } }));
  const land = (text: string) => {
    fs.writeFileSync(path.join(seed, "a.txt"), text);
    git(seed, "commit", "-qam", "landed elsewhere");
    git(seed, "push", "-q", origin, "main");
    return git(origin, "rev-parse", "main");
  };
  return { root, land };
}

/** The server, playing the session: `fix` is what happens when a brief reaches it. */
function server(fix: () => void) {
  const calls: Array<{ route: string; body: any }> = [];
  let messages = 10;
  let owed = 0;
  globalThis.fetch = (async (url: any, init: any) => {
    const route = String(url).replace(/^https?:\/\/[^/]+/, "");
    const body = JSON.parse(init?.body || "{}");
    calls.push({ route, body });
    const reply = (v: unknown) => new Response(JSON.stringify(v), { status: 200 });
    if (route === "/cli/work/get") return reply({ title: "Make a.txt good", status: "in_progress" });
    if (route === "/cli/inbox") {
      messages += owed;
      owed = 0;
      return reply({ sessions: [{ id: CONV, work_state: "done", bucket: "done", is_live: true, is_killed: false, message_count: messages }] });
    }
    if (route === "/cli/deploys/targets") return reply({ targets: [] });
    if (route === "/cli/messages/send") {
      if (/^Check failed/.test(body.body)) { fix(); owed += 3; } else messages += 3;
      return reply({ ok: true });
    }
    if (route === "/cli/workflow-runs/poll-gate") return reply({ status: "running", gate_response: "S" });
    return reply({ ok: true });
  }) as typeof fetch;
  return { calls, sent: () => calls.filter((c) => c.route === "/cli/messages/send").map((c) => c.body) };
}

async function run(root: string, graph: ReturnType<typeof parseWorkflowSource>, task: string, opts: Record<string, unknown> = {}) {
  console.log = process.env.SHOW_RUN ? origLog : () => {};
  try {
    return await runWorkflow(graph, { cwd: root, taskId: task, ...opts });
  } finally {
    console.log = origLog;
  }
}

describe("a run on a change cut on fresh upstream", () => {
  test("with no frozen change, a reviewer's diff starts at the remote's default branch", async () => {
    const { root } = world("x\n");
    // The checkout has origin/main, which is where a change would land.
    const flow = parseWorkflowSource(`digraph plain {
      start [shape=Mdiamond]
      look [label="Look", shape=parallelogram, script="mkdir -p $run_dir && echo $diff_base > $run_dir/base.txt"]
      done [shape=Msquare]
      start -> look -> done
    }`);
    const runDir = lineRunDir(root, runSlug(flow, { task_id: "ct-3" }, "run"));
    globalThis.fetch = origFetch;
    expect(await run(root, flow, "ct-3")).toBe("completed");
    expect(fs.readFileSync(path.join(runDir, "base.txt"), "utf-8").trim()).toBe("origin/main");
  }, 180_000);

  test("a session's change found already on upstream at a refreeze ends the run done, with no stage run again", async () => {
    const { root, land } = world("bad\n");
    let landedAt = "";
    // While the session is briefed, someone lands exactly its edit upstream.
    const s = server(() => { landedAt = land("bad\n"); });
    const graph = parseWorkflowSource(`digraph change {
      graph [label="Change", on_failure=stop]
      start [shape=Mdiamond]
      check [label="Check", shape=parallelogram, script="v=$(git -C $project_path show $branch:a.txt); [ \\"$v\\" = good ] || { echo \\"error: a.txt says $v\\"; exit 1; }"]
      fix_check [label="Fix check", backend=subject, max_visits=3, prompt="Check failed on $task_id. $check.output"]
      decide [label="Decide", shape=hexagon, prompt="Ship it?"]
      exit [shape=Msquare, label="Done"]
      start -> check
      check -> decide [condition="outcome = success"]
      check -> fix_check [condition="outcome = failure"]
      fix_check -> check
      decide -> exit [label="[S] Ship :: Land it"]
    }`, root);
    const runDir = lineRunDir(root, runSlug(graph, { task_id: "ct-4" }, "run"));
    const change = await freezeSessionChange(root, CONV, { branch: "codecast/change-ct-4", worktree: "change-ct-4" });
    expect(change.landed).toBeUndefined();
    writeFrozenChange(runDir, change);

    const outcome = await run(root, graph, "ct-4", { runId: "run-4", runSession: "conv_run", apiToken: "tok", convexSiteUrl: "https://convex.test", pollIntervalMs: 1 });
    expect(outcome).toBe("completed");
    expect(readFrozenChange(runDir)?.landed).toBe(landedAt);
    // One brief, Check never ran again, nobody was asked at Decide.
    expect(s.sent().filter((m) => /^Check failed/.test(m.body))).toHaveLength(1);
    const ran = s.calls.filter((c) => c.route === "/cli/workflow-runs/progress" && c.body.node_status === "running").map((c) => c.body.node_id);
    expect(ran.filter((id) => id === "check")).toHaveLength(1);
    expect(ran).not.toContain("decide");
    expect(s.calls.some((c) => c.route === "/cli/workflow-runs/gate")).toBe(false);
    const fixed = s.calls.find((c) => c.route === "/cli/workflow-runs/progress" && c.body.node_id === "fix_check" && c.body.node_status === "completed");
    expect(fixed?.body.result_preview ?? "").toContain("already on upstream");
  }, 180_000);
});
