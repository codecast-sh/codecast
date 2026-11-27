// A reviewer read as finished with no verdict is asked once to finish before its station settles (verdictAsk.ts).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseWorkflowSource } from "./parser.js";
import { runWorkflow, type RunOptions } from "./runner.js";
import { holdForVerdict } from "./verdictAsk.js";
import { isolateCodecastDirEachTest } from "../test-helpers/codecastDir.js";
isolateCodecastDirEachTest("cast-wf-verdict-");

describe("workflow/runner (a reviewer that settles with no verdict)", () => {
  let tmpDir: string;
  let restoreLog: () => void;
  let origFetch: typeof fetch;
  let calls: Array<{ route: string; body: any }>;
  // The reviewer's row: its transcript grows by `onAsk` messages once the ask reaches it, and it pins then if `pinsOnAsk`.
  let row: Record<string, unknown>;
  let pinned: Record<string, unknown> | null;
  let task: Record<string, unknown>;
  let onAsk: () => void;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cast-wf-verdict-"));
    const log = console.log;
    console.log = () => {};
    restoreLog = () => { console.log = log; };
    origFetch = globalThis.fetch;
    calls = [];
    // ct-102683's reviewer: live, its last message a tool call, read needs_input.
    row = { id: "conv_rev", work_state: "needs_input", is_live: true, message_count: 30 };
    pinned = null;
    task = { status: "in_progress" };
    onAsk = () => {};
    globalThis.fetch = (async (url: any, init: any) => {
      const route = String(url).replace(/^https?:\/\/[^/]+/, "");
      const body = JSON.parse(init?.body || "{}");
      calls.push({ route, body });
      const reply = (v: unknown) => new Response(JSON.stringify(v), { status: 200 });
      if (route === "/cli/spawn") return reply({ conversation_id: "conv_rev", short_id: "jx7rev" });
      if (route === "/cli/inbox") return reply({ sessions: [row] });
      if (route === "/cli/sessions/state/get") return reply(pinned);
      if (route === "/cli/work/get") return reply(task);
      if (route === "/cli/messages/send") onAsk();
      return reply({ ok: true });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
    restoreLog();
    fs.rmSync(tmpDir, { recursive: true });
  });

  const run = (grace = 60_000) => runWorkflow(parseWorkflowSource(`digraph change {
    start [shape=Mdiamond]
    review [label="Review", backend=session, agent=claude, reviewer=true, prompt="review it"]
    shipped [shape=Msquare]
    unreviewed [shape=Msquare, stop="No verdict: $review.output"]
    start -> review
    review -> shipped [condition="review.json.verdict = ship"]
    review -> unreviewed
  }`), { cwd: tmpDir, runId: "run-1", runSession: "conv_run", taskId: "ct-9", apiToken: "tok", convexSiteUrl: "https://convex.test", pollIntervalMs: 1, verdictAskGraceMs: grace } as RunOptions);
  const asks = () => calls.filter((c) => c.route === "/cli/messages/send");

  test("it is asked once to finish, and the verdict it then pins routes the run", async () => {
    onAsk = () => {
      row = { ...row, work_state: "done", message_count: 33 };
      pinned = { state: "ship", status: "done", result: '{"verdict": "ship"}', at: Date.now() };
    };
    expect(await run()).toBe("completed");
    expect(asks()).toHaveLength(1);
    expect(asks()[0]!.body).toMatchObject({ to: "conv_rev", from: "conv_run", wake: true });
    expect(asks()[0]!.body.body).toContain("you have left no verdict");
  }, 30000);

  test("one that takes the ask and settles again with no verdict goes the flow's own way, without waiting out the grace", async () => {
    onAsk = () => { row = { ...row, message_count: 33 }; };
    const t0 = Date.now();
    expect(await run()).toBe("failed");
    expect(Date.now() - t0).toBeLessThan(20_000);
    expect(asks()).toHaveLength(1);
    const failed = calls.find((c) => c.route === "/cli/workflow-runs/progress" && c.body.run_status === "failed");
    // The stop quotes the station's output, its session's state in words.
    expect(String(failed?.body.fail_reason)).toBe("Stopped: No verdict: Its session stopped, waiting for input.");
  }, 30000);

  test("one that never takes the ask settles at the grace's end", async () => {
    expect(await run(50)).toBe("failed");
    expect(asks()).toHaveLength(1);
  }, 30000);

  test("a reviewer stopped on an error it does not come back from is not asked or held: it fails as such", async () => {
    row = { ...row, blocked_on: "auth" };
    expect(await run()).toBe("failed");
    expect(asks()).toHaveLength(0);
    const failed = calls.find((c) => c.route === "/cli/workflow-runs/progress" && c.body.run_status === "failed");
    expect(String(failed?.body.fail_reason)).toContain("stopped on an auth error");
  }, 30000);

  test("the ask goes under one client_id per run and hand, so a runner that takes over the wait asks nothing new", async () => {
    onAsk = () => { row = { ...row, message_count: 33 }; };
    await run();
    expect(asks()[0]!.body.client_id).toBe("run:run-1:verdict-ask:conv_rev");
  }, 30000);

  test("a reviewer that recorded its verdict on the task, or pinned one, is not asked", async () => {
    task = { status: "in_progress", review_verdict: { verdict: "approve", at: Date.now() + 60_000 } };
    expect(await run()).toBe("failed");
    expect(asks()).toHaveLength(0);
    task = { status: "in_progress" };
    pinned = { state: "ship", status: "done", result: '{"verdict": "ship"}', at: Date.now() };
    calls = [];
    expect(await run()).toBe("completed");
    expect(asks()).toHaveLength(0);
  }, 30000);
});

describe("holdForVerdict", () => {
  // A runner that takes over the wait passes the hand's own start (`<node>.hand_at`), so a verdict its reviewer
  // recorded before the takeover counts.
  test("a task verdict counts from the hand's start, not the runner's", async () => {
    const at = 1_000_000;
    const sends: unknown[] = [];
    const call = async (route: string, body: Record<string, unknown>) => (route === "/cli/work/get" ? { review_verdict: { verdict: "approve", at } } : (sends.push(body), { ok: true }));
    const o = { row: { message_count: 5 }, pinned: null, taskId: "ct-9", to: "conv_rev", shortId: "jx7rev", runId: "run-1" };
    expect(await holdForVerdict(call, { ask: null }, { ...o, since: at - 1 })).toBe(false);
    expect(sends).toHaveLength(0);
    expect(await holdForVerdict(call, { ask: null }, { ...o, since: at + 1 })).toBe(true);
    expect(sends).toHaveLength(1);
  });
});
