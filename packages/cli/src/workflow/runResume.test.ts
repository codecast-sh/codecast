import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { parseWorkflowSource } from "./parser.js";
import { runWorkflow, type RunOptions } from "./runner.js";
import { checkpointPath, claimRun, isMidRun, readCheckpoint, resumePoint, runnerPidFile, type ResumeRow } from "./runResume.js";
import { lineRunDir } from "./runner.js";

// A runner that dies is a runner whose next request never comes back: the
// first run is left hanging on a fetch that never resolves, and a second
// runner resumes the row the first left behind.

const graph = () => parseWorkflowSource(`digraph line {
  start [shape=Mdiamond]
  ground [label="Ground", backend=session, agent=claude, prompt="ground it"]
  build [label="Build", backend=session, agent=claude, prompt="build it"]
  decide [label="Decide", shape=hexagon]
  ship [label="Ship", shape=parallelogram, script="mkdir -p $run_dir && echo shipped >> $run_dir/ship.log"]
  reopen [shape=parallelogram, script="true"]
  exit [shape=Msquare]
  start -> ground -> build -> decide
  decide -> ship [label="[S] Ship"]
  decide -> reopen [label="[R] Revise"]
  reopen -> build
  ship -> exit
}`);

describe("workflow/runResume (a run outlives its runner)", () => {
  let tmpDir: string;
  let stateDir: string;
  let origFetch: typeof fetch;
  let origLog: typeof console.log;
  let origDir: string | undefined;
  let calls: Array<{ route: string; body: any }>;
  let hangOn: string | null;
  let gateAnswer: string | null;
  let handRow: (id: string) => any;
  let spawned: number;
  let runId: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cast-resume-test-"));
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cast-resume-state-"));
    origDir = process.env.CODECAST_DIR;
    process.env.CODECAST_DIR = stateDir;
    origFetch = globalThis.fetch;
    origLog = console.log;
    console.log = () => {};
    calls = [];
    hangOn = null;
    gateAnswer = null;
    spawned = 0;
    runId = `run-resume-${Math.random().toString(36).slice(2, 10)}`;
    handRow = (id) => ({ id, work_state: "done", is_live: false });
    globalThis.fetch = (async (url: any, init: any) => {
      const route = String(url).replace(/^https?:\/\/[^/]+/, "");
      const body = JSON.parse(init?.body || "{}");
      calls.push({ route, body });
      const reply = (v: unknown) => new Response(JSON.stringify(v), { status: 200 });
      if (hangOn && route === hangOn && (route !== "/cli/inbox" || body.session_ids?.[0] === "conv_build_2")) return new Promise<Response>(() => {});
      if (route === "/cli/spawn") {
        spawned++;
        const node = String(body.title).toLowerCase();
        return reply({ conversation_id: `conv_${node}_${spawned}`, short_id: `jx${node}${spawned}` });
      }
      if (route === "/cli/inbox") return reply({ sessions: [handRow(body.session_ids[0])] });
      if (route === "/cli/sessions/state/get") return reply({ state: "done", status: "done" });
      if (route === "/cli/workflow-runs/poll-gate") return reply(gateAnswer ? { status: "running", gate_response: gateAnswer } : { status: "paused", gate_response: null });
      return reply({ ok: true });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
    console.log = origLog;
    if (origDir === undefined) delete process.env.CODECAST_DIR;
    else process.env.CODECAST_DIR = origDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.rmSync(lineRunDir(tmpDir, `line-${runId}`), { recursive: true, force: true });
  });

  const options = (extra: Partial<RunOptions> = {}): RunOptions => ({
    cwd: tmpDir, runId, runSession: "conv_run", apiToken: "tok", convexSiteUrl: "https://convex.test", pollIntervalMs: 1, ...extra,
  });
  const until = async (ok: () => boolean) => {
    for (let i = 0; i < 400 && !ok(); i++) await new Promise((r) => setTimeout(r, 5));
    expect(ok()).toBe(true);
  };
  const progress = () => calls.filter((c) => c.route === "/cli/workflow-runs/progress");
  const row = (over: Partial<ResumeRow>): ResumeRow => ({
    status: "running",
    node_statuses: [
      { node_id: "start", status: "completed", outcome: "success", completed_at: 1 },
      { node_id: "ground", status: "completed", outcome: "success", session_id: "jxground1", completed_at: 2 },
      { node_id: "build", status: "completed", outcome: "success", session_id: "jxbuild2", completed_at: 3 },
    ],
    ...over,
  });

  test("a run killed at the decide gate with its gate answered resumes at ship", async () => {
    // The runner dies asking the gate.
    hangOn = "/cli/workflow-runs/gate";
    void runWorkflow(graph(), options());
    await until(() => calls.some((c) => c.route === "/cli/workflow-runs/gate"));
    // The runner is gone; the person answered Ship on the card meanwhile.
    calls.length = 0;
    hangOn = null;
    const runDir = lineRunDir(tmpDir, `line-${runId}`);
    expect(readCheckpoint(runDir, runId)?.node_id).toBe("decide");

    const outcome = await runWorkflow(graph(), options({ resume: row({ current_node_id: "decide", gate_node_id: "decide", gate_response: "S" }) }));
    expect(outcome).toBe("completed");
    // Nothing done before the gate is done again, and the gate is not asked again.
    expect(calls.some((c) => c.route === "/cli/spawn")).toBe(false);
    expect(calls.some((c) => c.route === "/cli/workflow-runs/gate")).toBe(false);
    expect(calls.some((c) => c.route === "/cli/workflow-runs/poll-gate")).toBe(false);
    const decide = progress().find((c) => c.body.node_id === "decide" && c.body.node_status === "completed");
    expect(decide?.body.outcome).toBe("s");
    expect(progress().some((c) => c.body.node_id === "ship" && c.body.node_status === "completed")).toBe(true);
    expect(progress().at(-1)?.body.run_status).toBe("completed");
    expect(fs.readFileSync(path.join(runDir, "ship.log"), "utf-8").trim()).toBe("shipped");
    // The resumed runner names its machine, so a later death resumes it there too.
    expect(progress().some((c) => typeof c.body.runner_device === "string" && c.body.runner_device.length > 0)).toBe(true);
  }, 30000);

  test("a run killed at a gate still open waits on that gate without asking it twice", async () => {
    gateAnswer = "S";
    const outcome = await runWorkflow(graph(), options({ resume: row({ status: "paused", current_node_id: "decide", gate_node_id: "decide" }) }));
    expect(outcome).toBe("completed");
    expect(calls.some((c) => c.route === "/cli/workflow-runs/gate")).toBe(false);
    expect(calls.some((c) => c.route === "/cli/workflow-runs/poll-gate")).toBe(true);
  }, 30000);

  test("a run killed mid-station resumes that station, waiting on the hand it left working", async () => {
    hangOn = "/cli/inbox";
    void runWorkflow(graph(), options());
    const runDir = lineRunDir(tmpDir, `line-${runId}`);
    await until(() => readCheckpoint(runDir, runId)?.context["build.conversation_id"] === "conv_build_2"
      && calls.some((c) => c.route === "/cli/inbox" && c.body.session_ids?.[0] === "conv_build_2"));
    calls.length = 0;
    hangOn = null;

    gateAnswer = "S";
    const outcome = await runWorkflow(graph(), options({
      resume: row({ current_node_id: "build", node_statuses: row({}).node_statuses!.slice(0, 2).concat([{ node_id: "build", status: "running", session_id: "jxbuild2" }]) }),
    }));
    expect(outcome).toBe("completed");
    // The hand still standing finished the station; no second hand was started.
    expect(calls.some((c) => c.route === "/cli/spawn")).toBe(false);
    expect(calls.find((c) => c.route === "/cli/inbox")?.body.session_ids).toEqual(["conv_build_2"]);
    expect(progress().some((c) => c.body.node_id === "build" && c.body.node_status === "completed" && c.body.session_id === "jxbuild2")).toBe(true);
    expect(progress().some((c) => c.body.node_id === "ship" && c.body.node_status === "completed")).toBe(true);
    // Build ran once in the run's count, not twice.
    expect(readCheckpoint(runDir, runId)?.visit_counts.build).toBe(1);
  }, 30000);

  test("a station whose hand died with its runner starts that station again", async () => {
    hangOn = "/cli/inbox";
    void runWorkflow(graph(), options());
    const runDir = lineRunDir(tmpDir, `line-${runId}`);
    await until(() => readCheckpoint(runDir, runId)?.context["build.conversation_id"] === "conv_build_2"
      && calls.some((c) => c.route === "/cli/inbox" && c.body.session_ids?.[0] === "conv_build_2"));
    calls.length = 0;
    hangOn = null;
    // The hand was killed with the machine: not live, never finished.
    handRow = (id) => (id === "conv_build_2" ? { id, work_state: "working", is_live: false } : { id, work_state: "done", is_live: false });

    gateAnswer = "S";
    const outcome = await runWorkflow(graph(), options({ resume: row({ current_node_id: "build" }) }));
    expect(outcome).toBe("completed");
    expect(calls.filter((c) => c.route === "/cli/spawn").map((c) => c.body.title)).toEqual(["Build"]);
    expect(calls.some((c) => c.route === "/cli/spawn" && c.body.title === "Ground")).toBe(false);
  }, 30000);

  test("a run a live runner holds is not driven a second time", async () => {
    const other = Bun.spawn(["sleep", "30"]);
    try {
      fs.mkdirSync(path.dirname(runnerPidFile(runId)), { recursive: true });
      fs.writeFileSync(runnerPidFile(runId), JSON.stringify({ pid: other.pid, at: Date.now() }));
      expect(claimRun(runId)).toEqual({ heldBy: other.pid });
      expect(await runWorkflow(graph(), options({ resume: row({ current_node_id: "decide", gate_node_id: "decide", gate_response: "S" }) }))).toBe("invalid");
      expect(calls).toEqual([]);
    } finally {
      other.kill();
    }
    await other.exited;
    // Its holder gone, the run is free to claim.
    const claim = claimRun(runId);
    expect("release" in claim).toBe(true);
    if ("release" in claim) claim.release();
    expect(fs.existsSync(runnerPidFile(runId))).toBe(false);
  }, 30000);
});

describe("workflow/runResume resumePoint", () => {
  test("without a checkpoint the row's finished nodes are the run's history", () => {
    const p = resumePoint(graph(), {
      status: "running", current_node_id: "decide", gate_node_id: "decide", gate_response: "S",
      node_statuses: [
        { node_id: "build", status: "completed", outcome: "success", session_id: "jxb", completed_at: 3 },
        { node_id: "start", status: "completed", outcome: "success", completed_at: 1 },
        { node_id: "decide", status: "running" },
      ],
    }, null)!;
    expect(p.node_id).toBe("decide");
    expect(p.completed).toEqual(["start", "build"]);
    expect(p.context["build.session_id"]).toBe("jxb");
    expect(p.gate).toEqual({ node_id: "decide", response: "S", open: false });
    expect(p.from).toBe("row");
  });

  test("a runner that died between finishing a node and reporting the next keeps its route", () => {
    const p = resumePoint(graph(), { status: "running", current_node_id: "build", node_statuses: [{ node_id: "build", status: "completed", outcome: "success" }] }, {
      run_id: "r", node_id: "decide", started: false, visit_counts: { build: 1 }, completed: ["start", "ground", "build"],
      node_outcomes: { build: "success" }, context: { "build.outcome": "success" }, at: 1,
    })!;
    expect(p.node_id).toBe("decide");
    expect(p.visit_counts).toEqual({ build: 1 });
    // The gate was never asked: the resume asks it.
    expect(p.gate).toEqual({ node_id: "decide", response: null, open: false });
  });

  test("a row stands mid-run once a runner reported past its start, and not before", () => {
    expect(isMidRun({ status: "pending", node_statuses: [] })).toBe(false);
    expect(isMidRun({ status: "running", current_node_id: "decide", node_statuses: [{ node_id: "start", status: "completed" }] })).toBe(true);
    expect(isMidRun({ status: "completed", current_node_id: "exit", node_statuses: [{ node_id: "exit", status: "completed" }] })).toBe(false);
    expect(resumePoint(graph(), { status: "running", current_node_id: "gone" }, null)).toBeNull();
    expect(checkpointPath("/x", "r1")).toBe("/x/runs/r1.json");
  });
});
