// End to end (flows.md FL4): a session's change is the run's subject. Its check
// fails, the failure comes back to the session as a message, the session fixes
// its own checkout, the run freezes the change again and Check passes on it.
// The session hears Decide's answer and how the run ended. Real git and real
// transcripts in an isolated CODECAST_DIR and HOME; the server is a fake that
// plays the session.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { freezeSessionChange, writeFrozenChange } from "./flowChange";
import { readFrozenChange } from "./flowChangeFile";
import { parseWorkflowSource } from "./parser";
import { lineRunDir, runSlug, runWorkflow } from "./runner";
import { failureExcerpt, runEndMessage } from "./subjectStation";

const ENV = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_NOSYSTEM: "1" };
const saved: Record<string, string | undefined> = {};
let sandbox = "";
let origFetch: typeof fetch;
let origLog: typeof console.log;

beforeAll(() => {
  sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cast-subject-e2e-")));
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

const HOUR_AGO = new Date(Date.now() - 3_600_000).toISOString();
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8", env: { ...process.env, ...ENV, GIT_AUTHOR_DATE: HOUR_AGO, GIT_COMMITTER_DATE: HOUR_AGO } }).replace(/\n$/, "");
const CONV = "jx7ssssssssssssssssssssssssssss1";

let worlds = 0;
/** A shared checkout where session CONV changed a.txt, its transcript saying so. */
function world(content: string) {
  process.env.CODECAST_DIR = path.join(sandbox, `.codecast-${++worlds}`);
  const root = path.join(sandbox, `repo-${worlds}`);
  fs.mkdirSync(root);
  git(root, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(root, "a.txt"), "base\n");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "base");
  const dir = path.join(sandbox, ".claude", "projects", `-repo-${worlds}`);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `sess-${worlds}.jsonl`);
  const lines: object[] = [];
  const edit = (text: string) => {
    fs.writeFileSync(path.join(root, "a.txt"), text);
    lines.push({ type: "assistant", timestamp: new Date().toISOString(), cwd: root, message: { role: "assistant", content: [{ type: "tool_use", id: `t${lines.length}`, name: "Edit", input: { file_path: path.join(root, "a.txt"), old_string: "x", new_string: "y" } }] } });
    fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    const ledgerFile = path.join(process.env.CODECAST_DIR!, "sync-ledger.json");
    fs.mkdirSync(path.dirname(ledgerFile), { recursive: true });
    fs.writeFileSync(ledgerFile, JSON.stringify({ [file]: { lastSyncedAt: Date.now(), lastSyncedPosition: 0, messageCount: lines.length, conversationId: CONV, sourceGeneration: { client: "claude", sessionId: `sess-${worlds}`, dev: 0, ino: 0, birthtimeMs: 0, unit: "bytes", watermark: 0, prefixProven: true } } }));
  };
  edit(content);
  // The check segment beside the graph: it reads the frozen branch, the way a real check reads the run's worktree.
  fs.writeFileSync(path.join(root, "tcheck.cast"), `digraph tcheck {
    graph [kind="segment", label="Check"]
    start [shape=Mdiamond]
    verify [label="Verify", shape=parallelogram, script="v=$(git -C $project_path show $branch:a.txt); echo \\"line 1 fine\\"; [ \\"$v\\" = good ] || { echo \\"error: a.txt says $v, expected good\\"; exit 1; }"]
    passed [shape=Msquare, label="Passed"]
    failed [shape=Msquare, label="Checks failed", stop="The project's check failed on the change: $verify.output"]
    start -> verify
    verify -> passed [condition="outcome = success"]
    verify -> failed [condition="outcome = failure"]
  }`);
  return { root, edit };
}

const graphIn = (root: string) => parseWorkflowSource(`digraph change {
  graph [label="Change", on_failure=stop]
  start [shape=Mdiamond]
  check [flow="tcheck"]
  fix_check [label="Fix check", backend=subject, max_visits=3, prompt="Check failed on $task_id.\\n\\n$stop_reason"]
  decide [label="Decide", shape=hexagon, prompt="Ship it?"]
  exit [shape=Msquare, label="Done"]
  start -> check
  check -> decide
  check -> fix_check [condition="outcome = failure"]
  fix_check -> check
  decide -> exit [label="[S] Ship :: Land it"]
}`, root);

/** The server, playing the session: `fix` is what the session does when a brief reaches it; `dormant` has it pin dormant when it ends its turn. */
function server(fix: () => void, dormant = false) {
  const calls: Array<{ route: string; body: any }> = [];
  let messages = 10;
  globalThis.fetch = (async (url: any, init: any) => {
    const route = String(url).replace(/^https?:\/\/[^/]+/, "");
    const body = JSON.parse(init?.body || "{}");
    calls.push({ route, body });
    const reply = (v: unknown) => new Response(JSON.stringify(v), { status: 200 });
    if (route === "/cli/work/get") return reply({ title: "Make a.txt good", status: "in_progress" });
    if (route === "/cli/inbox") return reply({ sessions: [{ id: CONV, work_state: dormant ? "dormant" : "done", is_live: true, is_killed: false, message_count: messages }] });
    if (route === "/cli/sessions/state/get" && dormant) return reply({ state: "Fixed it; the run re-checks when this turn ends", status: "dormant", at: Date.now() });
    if (route === "/cli/messages/send") {
      // A brief starts a turn; the run's end and a gate's answer only inform.
      if (/^Check failed/.test(body.body)) fix();
      messages += 3;
      return reply({ ok: true });
    }
    if (route === "/cli/workflow-runs/gate") return reply({ ok: true });
    if (route === "/cli/workflow-runs/poll-gate") return reply({ status: "running", gate_response: "S" });
    return reply({ ok: true });
  }) as typeof fetch;
  return { calls, sent: () => calls.filter((c) => c.route === "/cli/messages/send").map((c) => c.body) };
}

async function start(root: string) {
  const graph = graphIn(root);
  const runDir = lineRunDir(root, runSlug(graph, { task_id: "ct-9" }, "run"));
  const change = await freezeSessionChange(root, CONV, { branch: "codecast/change-ct-9", worktree: "change-ct-9", title: "Make a.txt good" });
  writeFrozenChange(runDir, change);
  const t0 = Date.now();
  console.log = process.env.SHOW_RUN ? (...a: unknown[]) => origLog(`${Date.now() - t0}ms`, ...a) : () => {};
  try {
    const outcome = await runWorkflow(graph, { cwd: root, taskId: "ct-9", runId: "run-9", runSession: "conv_run", apiToken: "tok", convexSiteUrl: "https://convex.test", pollIntervalMs: 1 });
    return { outcome, runDir };
  } finally {
    console.log = origLog;
  }
}

describe("the session is the run's subject", () => {
  test("a failed check comes back to the session, it fixes it, the run freezes again and goes on; it hears the answer and the end", async () => {
    const { root, edit } = world("bad\n");
    const s = server(() => edit("good\n"));
    const { outcome, runDir } = await start(root);
    expect(outcome).toBe("completed");

    const [brief, answer, end] = s.sent();
    expect(brief.to).toBe(CONV);
    expect(brief.from).toBe("conv_run");
    expect(brief.body).toContain("Check failed on ct-9");
    expect(brief.body).toContain("error: a.txt says bad, expected good");
    expect(answer.body).toMatch(/^Decide: Ship\./);
    expect(end.body).toContain("The Change run on ct-9 is over: Done.");
    expect(s.sent()).toHaveLength(3);

    // What ships is the snapshot the run checked: the frozen branch holds the fix, the shared tree is untouched.
    expect(git(root, "show", "codecast/change-ct-9:a.txt")).toBe("good");
    expect(readFrozenChange(runDir)?.tip).toBe(git(root, "rev-parse", "codecast/change-ct-9"));
    expect(git(root, "rev-parse", "HEAD")).toBe(git(root, "rev-parse", "main"));
    expect(git(root, "status", "--porcelain", "--", "a.txt")).toBe(" M a.txt");

    // The run said it waited on the session, and then that it no longer does; Check's second visit is counted.
    const progress = s.calls.filter((c) => c.route === "/cli/workflow-runs/progress").map((c) => c.body);
    const waits = progress.filter((b) => "waiting_on_session" in b).map((b) => b.waiting_on_session);
    expect(waits[0]).toMatchObject({ node_id: "fix_check", conversation_id: CONV });
    expect(waits[0].note).toContain("expected good");
    expect(waits[1]).toBeNull();
    expect(progress.some((b) => b.node_id === "check" && b.visits === 2)).toBe(true);
    // The session is never reported as a hand of the run's.
    expect(progress.some((b) => b.session_id)).toBe(false);
  }, 60_000);

  test("a session that pins dormant naming the run as its wake has answered: the run goes on (ct-85419)", async () => {
    const { root, edit } = world("bad\n");
    const s = server(() => edit("good\n"), true);
    const { outcome } = await start(root);
    expect(outcome).toBe("completed");
    expect(s.sent().at(-1)!.body).toContain("is over: Done.");
  }, 60_000);

  test("a session that never fixes it is sent back three times, then the run stops and says why", async () => {
    const { root } = world("bad\n");
    const s = server(() => {});
    const { outcome } = await start(root);
    expect(outcome).toBe("failed");
    const sent = s.sent();
    expect(sent.filter((m) => /^Check failed/.test(m.body))).toHaveLength(3);
    expect(sent.at(-1)!.body).toContain("stopped at Fix check: Check sent the change back 3 times and it still does not pass.");
  }, 60_000);
});

describe("runEndMessage", () => {
  const g = parseWorkflowSource(`digraph "quick-change" { graph [label="Quick"] start [shape=Mdiamond] exit [shape=Msquare] start -> exit }`);
  test("a stop before Land says nothing shipped and how to run it again; one after Land says the change is on main", () => {
    expect(runEndMessage(g, { taskId: "ct-1", endLabel: "Fix check", failed: true, failReason: "Stopped: Check sent the change back 3 times and it still does not pass." }))
      .toBe("The Quick run on ct-1 stopped at Fix check: Check sent the change back 3 times and it still does not pass. The change was not shipped. Run it again with `cast flow run quick-change` once it is ready.");
    expect(runEndMessage(g, { taskId: "ct-1", endLabel: "Deploy failed", failed: true, failReason: "Stopped: The deploy that carried abc failed: web dp-2 (exit 1).", landed: true }))
      .toBe("The Quick run on ct-1 stopped at Deploy failed: The deploy that carried abc failed: web dp-2 (exit 1). The change is on the default branch; nothing after this stage ran.");
  });
});

describe("failureExcerpt", () => {
  test("short output passes whole; long output keeps what broke and the end", () => {
    expect(failureExcerpt("a\n\nb\n")).toBe("a\nb");
    const long = [...Array.from({ length: 300 }, (_, i) => `ok ${i}`), "src/x.ts(3,1): error TS2339: nope", ...Array.from({ length: 300 }, (_, i) => `ok more ${i}`), "1 failed"].join("\n");
    const cut = failureExcerpt(long);
    expect(cut).toContain("error TS2339: nope");
    expect(cut).toContain("1 failed");
    expect(cut).not.toContain("ok 5\n");
    expect(cut.split("\n").length).toBeLessThanOrEqual(80);
  });
});
