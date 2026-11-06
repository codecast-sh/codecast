// A run a person stopped while its runner waited out a hold (ct-73543, Nov 5): the cancel ended the row, the hold
// ended hours later, and the runner went on through Build and Present, posting a second card for the problem. The
// server answers a report from a run that is over with why it ended (workflow_runs runOver), and the runner starts
// no station after that answer.
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { parseWorkflowSource } from "./parser.js";
import { runWorkflow, type RunOptions } from "./runner.js";
import { isolateCodecastDirEachTest } from "../test-helpers/codecastDir.js";
isolateCodecastDirEachTest("cast-wf-ended-");

const graph = () => parseWorkflowSource(`digraph line {
  start [shape=Mdiamond]
  hold [label="Hold", shape=parallelogram, script="true"]
  build [label="Build", shape=parallelogram, script="touch built"]
  exit [shape=Msquare]
  start -> hold -> build -> exit
}`);

describe("workflow/runner (a run that ended on the server while its runner waited)", () => {
  let tmpDir: string;
  let origFetch: typeof fetch;
  let origLog: typeof console.log;
  let calls: Array<{ route: string; body: any; ended: boolean }>;
  // The report after which the server holds the run as over (a person's cancel while that station ran).
  let cancelDuring: string | null;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cast-wf-ended-"));
    origFetch = globalThis.fetch;
    origLog = console.log;
    console.log = () => {};
    calls = [];
    let over = false;
    globalThis.fetch = (async (url: any, init: any) => {
      const route = String(url).replace(/^https?:\/\/[^/]+/, "");
      const body = JSON.parse(init?.body || "{}");
      const progress = route === "/cli/workflow-runs/progress";
      calls.push({ route, body, ended: progress && over });
      if (progress && over) return new Response(JSON.stringify({ ended: { status: "failed", reason: "Cancelled by user" } }), { status: 200 });
      if (progress && body.node_id === cancelDuring && body.node_status === "running") over = true;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
    console.log = origLog;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const options = (): RunOptions => ({ cwd: tmpDir, runId: "run-1", apiToken: "tok", convexSiteUrl: "https://convex.test" } as RunOptions);
  const reports = () => calls.filter((c) => c.route === "/cli/workflow-runs/progress");

  test("a run cancelled while it waited at a hold starts no station after the hold", async () => {
    cancelDuring = "hold";
    expect(await runWorkflow(graph(), options())).toBe("failed");
    expect(fs.existsSync(path.join(tmpDir, "built"))).toBe(false);
    expect(reports().some((c) => c.body.node_id === "build")).toBe(false);
    // The hold's end was the one report the server turned away, and the runner sent nothing after it.
    expect(reports().filter((c) => c.ended).map((c) => [c.body.node_id, c.body.node_status])).toEqual([["hold", "completed"]]);
  });

  test("a run nobody stopped goes on through every station", async () => {
    cancelDuring = null;
    expect(await runWorkflow(graph(), options())).toBe("completed");
    expect(fs.existsSync(path.join(tmpDir, "built"))).toBe(true);
    expect(reports().some((c) => c.body.run_status === "completed")).toBe(true);
  });
});
