// A station that takes only so many of the team's runs at once (the line
// profile's caps.stations). Eval proofs queued for one of the eval host's slots
// inside Eval's own clock, and ct-68695 was killed an hour in with 91 of 95
// cases drawn (2026-10-29). A run past the cap now waits outside the station,
// and the station's clock starts once the run holds a place.
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { parseWorkflowSource } from "./parser.js";
import { runWorkflow, waitForStationPlace, type RunOptions } from "./runner.js";
import { isolateCodecastDirEachTest } from "../test-helpers/codecastDir.js";
isolateCodecastDirEachTest("cast-wf-state-");

const graph = parseWorkflowSource(`digraph line {
  start [shape=Mdiamond]
  prepare [shape=parallelogram, script="true"]
  eval [label="Eval", shape=parallelogram, timeout=60, script="true"]
  exit [shape=Msquare]
  start -> prepare -> eval -> exit
}`);

describe("workflow/runner (a station with a cap on runs at once)", () => {
  let tmpDir: string;
  let origFetch: typeof fetch;
  let origLog: typeof console.log;
  let calls: Array<{ route: string; body: any }>;
  // The admission's answers, in order; the last repeats.
  let answers: Array<unknown>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cast-wf-stationcap-"));
    origFetch = globalThis.fetch;
    origLog = console.log;
    console.log = () => {};
    calls = [];
    answers = [{ admitted: true }];
    globalThis.fetch = (async (url: any, init: any) => {
      const route = String(url).replace(/^https?:\/\/[^/]+/, "");
      const body = JSON.parse(init?.body || "{}");
      calls.push({ route, body });
      if (route === "/cli/workflow-runs/admit") {
        const a = answers.length > 1 ? answers.shift() : answers[0];
        return a === "missing" ? new Response("not found", { status: 404 }) : new Response(JSON.stringify(a), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
    console.log = origLog;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const options = (): RunOptions => ({ cwd: tmpDir, runId: "run-1", apiToken: "tok", convexSiteUrl: "https://convex.test", stationPollMs: 1 } as RunOptions);
  const evalNode = graph.nodes.get("eval")!;

  test("a run past the cap asks again until a place is free, then goes in", async () => {
    answers = [{ admitted: false, inside: 2, cap: 2 }, { admitted: false, inside: 2, cap: 2 }, { admitted: true, inside: 2, cap: 2 }];
    await waitForStationPlace(evalNode, 2, options());
    const asks = calls.filter((c) => c.route === "/cli/workflow-runs/admit");
    expect(asks).toHaveLength(3);
    expect(asks[0].body).toMatchObject({ run_id: "run-1", node_id: "eval", cap: 2 });
  });

  test("a server that cannot answer lets the run in after three asks", async () => {
    answers = ["missing"];
    await waitForStationPlace(evalNode, 2, options());
    expect(calls.filter((c) => c.route === "/cli/workflow-runs/admit")).toHaveLength(3);
  });

  test("the run asks for its place before the station reports it started, and only at the capped station", async () => {
    fs.mkdirSync(path.join(tmpDir, ".codecast"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, ".codecast/line.toml"), "[line.caps.stations]\neval = 2\n");
    answers = [{ admitted: false, inside: 2, cap: 2 }, { admitted: true, inside: 2, cap: 2 }];
    await runWorkflow(graph, options());
    const asks = calls.filter((c) => c.route === "/cli/workflow-runs/admit");
    expect(asks.map((c) => c.body.node_id)).toEqual(["eval", "eval"]);
    const firstAsk = calls.findIndex((c) => c.route === "/cli/workflow-runs/admit");
    const evalStarted = calls.findIndex((c) => c.route === "/cli/workflow-runs/progress" && c.body.node_id === "eval" && c.body.node_status === "running");
    expect(evalStarted).toBeGreaterThan(firstAsk);
  });

  // At 07:08 UTC Nov 5 Eval held 6 runs and Prove 8 under caps of 4: every run over the cap had been resumed straight
  // into its station (cast workflow resume, a queued resume) and held no place.
  test("a run resumed at a capped station asks for its place before the station starts", async () => {
    fs.mkdirSync(path.join(tmpDir, ".codecast"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, ".codecast/line.toml"), "[line.caps.stations]\neval = 2\n");
    answers = [{ admitted: false, inside: 2, cap: 2 }, { admitted: true, inside: 2, cap: 2 }];
    const resume = { current_node_id: "eval", status: "running", node_statuses: [{ node_id: "prepare", status: "completed", completed_at: 1 }] } as any;
    const out = await runWorkflow(graph, { ...options(), runId: `run-resumed-${Date.now()}`, resume }); if (process.env.PROBE) process.stderr.write(JSON.stringify({ out, calls: calls.map((c) => [c.route, c.body.node_id, c.body.node_status]) }) + "\n");
    const asks = calls.filter((c) => c.route === "/cli/workflow-runs/admit");
    expect(asks.map((c) => c.body.node_id)).toEqual(["eval", "eval"]);
    const firstAsk = calls.findIndex((c) => c.route === "/cli/workflow-runs/admit");
    const evalStarted = calls.findIndex((c) => c.route === "/cli/workflow-runs/progress" && c.body.node_id === "eval" && c.body.node_status === "running");
    expect(evalStarted).toBeGreaterThan(firstAsk);
  });

  test("a profile with no station caps asks for no place", async () => {
    await runWorkflow(graph, options());
    expect(calls.some((c) => c.route === "/cli/workflow-runs/admit")).toBe(false);
  });
});
