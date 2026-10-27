import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { parseWorkflowSource } from "./parser.js";
import { runWorkflow, type RunOptions } from "./runner.js";
import { checkpointPath, claimRun, closeDeadRunPanes, DEAD_RUN_PANE_IDLE_S, deadRunPanes, isMidRun, PANE_CLAIM_GRACE_S, paneReplaceable, readCheckpoint, resumePoint, runnerPidFile, runPaneLaunchLine, type ResumeRow } from "./runResume.js";
import { lineRunDir } from "./runner.js";
import { deviceId } from "../remote/device.js";

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

  // Every hand of a run is placed on the machine running it. A shared hand
  // placed by its path alone landed on another host with the same checkout
  // path and could not read the run's branch (union-line-1 and -3, 2026-10-23).
  test("every station hand is placed on the runner's own machine, isolated or not", async () => {
    hangOn = "/cli/workflow-runs/gate";
    void runWorkflow(graph(), options());
    await until(() => calls.some((c) => c.route === "/cli/workflow-runs/gate"));
    hangOn = null;
    const spawns = calls.filter((c) => c.route === "/cli/spawn");
    expect(spawns.length).toBeGreaterThan(0);
    for (const c of spawns) expect(c.body.device).toBe(deviceId());
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
    const outcome = await runWorkflow(graph(), options({ resume: row({ status: "paused", current_node_id: "decide", gate_node_id: "decide", gate_decision_id: "sd_1" }) }));
    expect(outcome).toBe("completed");
    expect(calls.some((c) => c.route === "/cli/workflow-runs/gate")).toBe(false);
    expect(calls.some((c) => c.route === "/cli/workflow-runs/poll-gate")).toBe(true);
  }, 30000);

  test("a trial run killed at its waiting card waits on that card without asking again (no decision id; gate_card)", async () => {
    gateAnswer = "S";
    const outcome = await runWorkflow(graph(), options({ resume: row({ status: "paused", current_node_id: "decide", gate_node_id: "decide", gate_card: "tc-41" }) }));
    expect(outcome).toBe("completed");
    expect(calls.some((c) => c.route === "/cli/workflow-runs/gate")).toBe(false);
    expect(calls.some((c) => c.route === "/cli/workflow-runs/poll-gate")).toBe(true);
  }, 30000);

  test("a gate answered after the graph's files changed continues in a fresh runner, reporting nothing past the gate first", async () => {
    const prompt = path.join(tmpDir, "build.md");
    fs.writeFileSync(prompt, "build it");
    const g = graph();
    g.sources = [prompt];
    let handedOff = false;
    const continueFresh = () => { handedOff = true; return new Promise<void>(() => {}); };
    void runWorkflow(g, options({ continueFresh, resume: row({ status: "paused", current_node_id: "decide", gate_node_id: "decide", gate_card: "tc-41" }) }));
    await until(() => calls.some((c) => c.route === "/cli/workflow-runs/poll-gate"));
    fs.writeFileSync(prompt, "build it, the new way");
    fs.utimesSync(prompt, new Date(), new Date(Date.now() + 5000));
    gateAnswer = "S";
    await until(() => handedOff);
    expect(progress().some((c) => c.body.node_id === "decide" && c.body.node_status === "completed")).toBe(false);
  }, 30000);

  test("a gate answered with nothing changed goes on in the same runner", async () => {
    gateAnswer = "S";
    let handedOff = false;
    const outcome = await runWorkflow(graph(), options({ continueFresh: async () => { handedOff = true; }, resume: row({ status: "paused", current_node_id: "decide", gate_node_id: "decide", gate_card: "tc-41" }) }));
    expect(outcome).toBe("completed");
    expect(handedOff).toBe(false);
  }, 30000);

  // A run's line commands are the repo's profile as it is when a station runs, not as it was when the
  // run started: union-shared's runs started before a7d2cb4090 kept evaluating in place, on scratch, for days.
  describe("a line profile changed while a run waits", () => {
    const evalGraph = () => parseWorkflowSource(`digraph line {
      start [shape=Mdiamond]
      decide [label="Decide", shape=hexagon]
      eval [label="Eval", shape=parallelogram, script="bash -c $line.commands.eval"]
      exit [shape=Msquare]
      start -> decide
      decide -> eval [label="[S] Ship"]
      eval -> exit
    }`);
    const profile = (cmd: string) => {
      fs.mkdirSync(path.join(tmpDir, ".codecast"), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, ".codecast", "line.toml"), `[line.commands]\neval = ${JSON.stringify(`mkdir -p $run_dir && echo ${cmd} >> $run_dir/eval.log`)}\n`);
    };
    const evalLog = () => fs.readFileSync(path.join(lineRunDir(tmpDir, `line-${runId}`), "eval.log"), "utf-8").trim();
    const atGate = (over: Partial<ResumeRow> = {}) => ({ status: "paused" as const, current_node_id: "decide", gate_node_id: "decide", gate_card: "tc-41", node_statuses: [{ node_id: "start", status: "completed", outcome: "success", completed_at: 1 }], ...over });

    test("a run resumed by a fresh runner runs the profile's command as it is now", async () => {
      profile("old");
      hangOn = "/cli/workflow-runs/gate";
      void runWorkflow(evalGraph(), options());
      await until(() => calls.some((c) => c.route === "/cli/workflow-runs/gate"));
      hangOn = null;
      expect(readCheckpoint(lineRunDir(tmpDir, `line-${runId}`), runId)?.context["line.commands.eval"]).toContain("echo old");
      profile("new");
      const outcome = await runWorkflow(evalGraph(), options({ resume: atGate({ status: "running", gate_card: undefined, gate_response: "S" }) }));
      expect(outcome).toBe("completed");
      expect(evalLog()).toBe("new");
    }, 30000);

    test("a runner waiting at a gate when the profile changes runs the new command once answered", async () => {
      profile("old");
      const run = runWorkflow(evalGraph(), options({ resume: atGate() }));
      await until(() => calls.some((c) => c.route === "/cli/workflow-runs/poll-gate"));
      profile("new");
      gateAnswer = "S";
      expect(await run).toBe("completed");
      expect(evalLog()).toBe("new");
    }, 30000);

    test("a profile broken while the run waited fails the run the way a fresh start does", async () => {
      profile("old");
      const run = runWorkflow(evalGraph(), options({ resume: atGate() }));
      await until(() => calls.some((c) => c.route === "/cli/workflow-runs/poll-gate"));
      fs.writeFileSync(path.join(tmpDir, ".codecast", "line.toml"), "[line.commands\neval = ");
      gateAnswer = "S";
      expect(await run).toBe("failed");
      expect(progress().at(-1)?.body.fail_reason).toContain("the line profile could not be read");
      expect(fs.existsSync(path.join(lineRunDir(tmpDir, `line-${runId}`), "eval.log"))).toBe(false);
    }, 30000);
  });

  test("a gate picked up on a graph that grew a station before it makes that station first (ct-59267: proposal_words)", () => {
    const grown = parseWorkflowSource(`digraph line {
      start [shape=Mdiamond]
      build [label="Build", backend=session, agent=claude, prompt="build it"]
      words [label="Words", backend=session, agent=claude, prompt="word it"]
      decide [label="Decide", shape=hexagon]
      exit [shape=Msquare]
      start -> build -> words -> decide
      decide -> exit [label="[S] Ship"]
      decide -> build [label="[R] Revise"]
    }`);
    const cp = { run_id: "r", node_id: "decide", started: true, visit_counts: { start: 1, build: 1, decide: 1 }, completed: ["start", "build"], node_outcomes: { start: "success", build: "success" } as any, context: { "build.json": "{}" }, at: 1 };
    const at = resumePoint(grown, { status: "running", current_node_id: "decide", node_statuses: [] }, cp)!;
    expect(at).toMatchObject({ node_id: "words", gate: null });
    expect(at.context["build.json"]).toBe("{}");
    // The run made what the gate reads: the gate is asked again as it stands.
    expect(resumePoint(grown, { status: "running", current_node_id: "decide", node_statuses: [] }, { ...cp, completed: ["start", "build", "words"] })!.node_id).toBe("decide");
    // Answered while it was down: taken, never re-made.
    expect(resumePoint(grown, { status: "running", current_node_id: "decide", gate_node_id: "decide", gate_response: "S", node_statuses: [] }, cp)!.node_id).toBe("decide");
  });

  // A failed run resumed at a station (cast workflow resume) is a new attempt: the cap that stops a loop within one
  // attempt (max_visits) counts that attempt's visits only (ct-59974 died at implement's 3 of 3, then its cause was fixed).
  describe("a failed run resumed at a station as a new attempt", () => {
    const capped = () => parseWorkflowSource(`digraph line {
      start [shape=Mdiamond]
      check [label="Check", shape=parallelogram, max_visits=1, script="mkdir -p $run_dir && echo checked >> $run_dir/check.log"]
      exit [shape=Msquare]
      start -> check
      check -> exit [condition="outcome = success"]
    }`);
    const usedUp = (at: number) => ({ run_id: runId, node_id: "check", started: false, visit_counts: { start: 1, check: 1 }, completed: ["start", "check"], node_outcomes: { start: "success", check: "failure" } as any, context: { "check.visits": "1", kept: "what the run made" }, at });
    const failedAtCheck = (over: Partial<ResumeRow> = {}): ResumeRow => ({
      status: "running",
      current_node_id: "check",
      node_statuses: [
        { node_id: "start", status: "completed", outcome: "success", completed_at: 1 },
        { node_id: "check", status: "failed", outcome: "failure", completed_at: 2 },
      ],
      ...over,
    });

    test("the visits the earlier attempt used count no more, and what it made stays", () => {
      const at = resumePoint(capped(), failedAtCheck({ visits_reset_at: 2000 }), usedUp(1000))!;
      expect(at.visit_counts).toEqual({});
      expect(at.context).toEqual({ kept: "what the run made" });
      // Without the reset the earlier attempt's visits stand.
      expect(resumePoint(capped(), failedAtCheck(), usedUp(1000))!.visit_counts).toEqual({ start: 1, check: 1 });
      // A checkpoint written after the resume is this attempt's own: its visits count.
      expect(resumePoint(capped(), failedAtCheck({ visits_reset_at: 2000 }), usedUp(3000))!.visit_counts).toEqual({ start: 1, check: 1 });
      // Read from the row (no checkpoint on this machine) the same holds.
      expect(resumePoint(capped(), failedAtCheck({ visits_reset_at: 2000 }), null)!.visit_counts).toEqual({});
    });

    test("the station a person named stands, even the one the run finished last before it failed", () => {
      // The checkpoint finished `start` and routed on to `check`; the run is resumed at `start`.
      const routed = { ...usedUp(1000), node_id: "check", completed: ["start"] };
      expect(resumePoint(capped(), failedAtCheck({ current_node_id: "start", visits_reset_at: 2000 }), routed)!.node_id).toBe("start");
      // A runner that died between finishing `start` and reporting `check` still goes on to `check`.
      expect(resumePoint(capped(), failedAtCheck({ current_node_id: "start" }), routed)!.node_id).toBe("check");
    });

    test("a station whose visits the earlier attempt used up runs again, and the run finishes", async () => {
      const runDir = lineRunDir(tmpDir, `line-${runId}`);
      const cp = usedUp(1000);
      fs.mkdirSync(path.dirname(checkpointPath(runDir, runId)), { recursive: true });
      fs.writeFileSync(checkpointPath(runDir, runId), JSON.stringify(cp));
      expect(await runWorkflow(capped(), options({ resume: failedAtCheck() }))).toBe("failed");
      fs.writeFileSync(checkpointPath(runDir, runId), JSON.stringify(cp));
      expect(await runWorkflow(capped(), options({ resume: failedAtCheck({ visits_reset_at: 2000 }) }))).toBe("completed");
      expect(fs.readFileSync(path.join(runDir, "check.log"), "utf-8")).toBe("checked\n");
    }, 30000);
  });

  test("a run paused at a gate whose ask never made a decision asks it again on resume", async () => {
    gateAnswer = "S";
    const outcome = await runWorkflow(graph(), options({ resume: row({ status: "paused", current_node_id: "decide", gate_node_id: "decide" }) }));
    expect(outcome).toBe("completed");
    expect(calls.some((c) => c.route === "/cli/workflow-runs/gate")).toBe(true);
  }, 30000);

  test("a run killed mid-station resumes that station, waiting on the hand it left working", async () => {
    hangOn = "/cli/inbox";
    void runWorkflow(graph(), options());
    const runDir = lineRunDir(tmpDir, `line-${runId}`);
    await until(() => readCheckpoint(runDir, runId)?.context["build.conversation_id"] === "conv_build_2"
      && calls.some((c) => c.route === "/cli/inbox" && c.body.session_ids?.[0] === "conv_build_2"));
    calls.length = 0;
    hangOn = null;

    const resumed = runWorkflow(graph(), options({
      resume: row({ current_node_id: "build", node_statuses: row({}).node_statuses!.slice(0, 2).concat([{ node_id: "build", status: "running", session_id: "jxbuild2" }]) }),
    }));
    // Build ran once in the run's count, not twice: read at the gate, whose answer starts the next attempt.
    await until(() => readCheckpoint(runDir, runId)?.node_id === "decide");
    expect(readCheckpoint(runDir, runId)?.visit_counts.build).toBe(1);
    gateAnswer = "S";
    const outcome = await resumed;
    expect(outcome).toBe("completed");
    // The hand still standing finished the station; no second hand was started.
    expect(calls.some((c) => c.route === "/cli/spawn")).toBe(false);
    expect(calls.find((c) => c.route === "/cli/inbox")?.body.session_ids).toEqual(["conv_build_2"]);
    expect(progress().some((c) => c.body.node_id === "build" && c.body.node_status === "completed" && c.body.session_id === "jxbuild2")).toBe(true);
    expect(progress().some((c) => c.body.node_id === "ship" && c.body.node_status === "completed")).toBe(true);
  }, 30000);

  // The hand was killed with the machine: not live, never finished. Once its
  // heartbeat lapses it reads needs_input, which is no answer: seven Implement
  // runs read theirs as one 3 minutes after a reboot and ended with no handoff
  // (Mac mini, 2026-10-17).
  for (const left of ["working", "needs_input"]) {
    test(`a station whose hand died with its runner (reading ${left}), and was not revived, starts again with the old hand stopped`, async () => {
      hangOn = "/cli/inbox";
      void runWorkflow(graph(), options());
      const runDir = lineRunDir(tmpDir, `line-${runId}`);
      await until(() => readCheckpoint(runDir, runId)?.context["build.conversation_id"] === "conv_build_2"
        && calls.some((c) => c.route === "/cli/inbox" && c.body.session_ids?.[0] === "conv_build_2"));
      calls.length = 0;
      hangOn = null;
      handRow = (id) => (id === "conv_build_2" ? { id, work_state: left, is_live: false } : { id, work_state: "done", is_live: false });

      gateAnswer = "S";
      const outcome = await runWorkflow(graph(), options({ resume: row({ current_node_id: "build" }), reviveGraceMs: 50 }));
      expect(outcome).toBe("completed");
      expect(calls.some((c) => c.route === "/cli/sessions/kill" && c.body.session === "conv_build_2")).toBe(true);
      expect(calls.filter((c) => c.route === "/cli/spawn").map((c) => c.body.title)).toEqual(["Build"]);
      expect(calls.some((c) => c.route === "/cli/spawn" && c.body.title === "Ground")).toBe(false);
    }, 30000);
  }

  test("a station whose hand died with its runner and was revived in the grace goes on with that hand", async () => {
    hangOn = "/cli/inbox";
    void runWorkflow(graph(), options());
    const runDir = lineRunDir(tmpDir, `line-${runId}`);
    await until(() => readCheckpoint(runDir, runId)?.context["build.conversation_id"] === "conv_build_2"
      && calls.some((c) => c.route === "/cli/inbox" && c.body.session_ids?.[0] === "conv_build_2"));
    calls.length = 0;
    hangOn = null;
    // Dead with the machine for three reads, then revived in its own conversation, working, then done.
    let reads = 0;
    handRow = (id) => {
      if (id !== "conv_build_2") return { id, work_state: "done", is_live: false };
      reads++;
      return reads <= 3 ? { id, work_state: "needs_input", is_live: false } : { id, work_state: reads <= 5 ? "working" : "done", is_live: true };
    };

    gateAnswer = "S";
    const outcome = await runWorkflow(graph(), options({ resume: row({ current_node_id: "build" }), reviveGraceMs: 10_000 }));
    expect(outcome).toBe("completed");
    expect(calls.some((c) => c.route === "/cli/spawn" || c.route === "/cli/sessions/kill")).toBe(false);
    expect(progress().some((c) => c.body.node_id === "build" && c.body.node_status === "completed" && c.body.session_id === "jxbuild2")).toBe(true);
    // It settled on the revived hand's own done (its sixth read), not on a dead read.
    const settle = calls.findIndex((c) => c.route === "/cli/sessions/state/get");
    expect(calls.slice(0, settle).filter((c) => c.route === "/cli/inbox" && c.body.session_ids?.[0] === "conv_build_2").length).toBeGreaterThanOrEqual(6);
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

  test("a row moved off the checkpoint's node keeps the values the run made, and counts each finished node once (a stale card rebuilt from fresh)", () => {
    const p = resumePoint(graph(), {
      status: "running", current_node_id: "build",
      node_statuses: [{ node_id: "start", status: "completed", outcome: "partial_success", completed_at: 1 }, { node_id: "build", status: "completed", outcome: "success", completed_at: 2 }],
    }, {
      run_id: "r", node_id: "decide", started: true, visit_counts: { build: 3, decide: 1 }, completed: ["start", "build"],
      node_outcomes: { build: "success" }, context: { worktree: "agentwatch-trial-ct-1", "red.json": "{\"dir\":\"/x\"}", "start.outcome": "success" }, at: 1,
    })!;
    expect(p.node_id).toBe("build");
    expect(p.context.worktree).toBe("agentwatch-trial-ct-1");
    expect(p.context["red.json"]).toBe('{"dir":"/x"}');
    expect(p.context["start.outcome"]).toBe("partial_success");
    expect(p.visit_counts).toEqual({ start: 1 });
    expect(p.from).toBe("row");
  });

  test("a row stands mid-run once a runner reported past its start, and not before", () => {
    expect(isMidRun({ status: "pending", node_statuses: [] })).toBe(false);
    expect(isMidRun({ status: "running", current_node_id: "decide", node_statuses: [{ node_id: "start", status: "completed" }] })).toBe(true);
    expect(isMidRun({ status: "completed", current_node_id: "exit", node_statuses: [{ node_id: "exit", status: "completed" }] })).toBe(false);
    expect(resumePoint(graph(), { status: "running", current_node_id: "gone" }, null)).toBeNull();
    expect(checkpointPath("/x", "r1")).toBe("/x/runs/r1.json");
  });
});

describe("workflow/runResume readCheckpoint", () => {
  test("a run whose graph was renamed finds its checkpoint in the run directory the old graph gave it", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cp-"));
    fs.mkdirSync(path.join(root, "agentwatch-trial-r3-ct-1", "runs"), { recursive: true });
    fs.writeFileSync(path.join(root, "agentwatch-trial-r3-ct-1", "runs", "th7.json"), JSON.stringify({ run_id: "th7", node_id: "decide", context: { worktree: "agentwatch-trial-r3-ct-1" } }));
    expect(readCheckpoint(path.join(root, "agentwatch-trial-ct-1"), "th7")?.context.worktree).toBe("agentwatch-trial-r3-ct-1");
    expect(readCheckpoint(path.join(root, "agentwatch-trial-ct-1"), "other")).toBeNull();
  });
});

describe("workflow/runResume paneReplaceable (one run, one pane)", () => {
  test("a pane running its runner, or created moments ago, is never replaced; a pane back at its shell is", () => {
    expect(paneReplaceable(null, 1000)).toBe(true);
    expect(paneReplaceable({ command: "bun", createdS: 0 }, 10_000)).toBe(false);
    expect(paneReplaceable({ command: "bash", createdS: 1000 }, 1000 + PANE_CLAIM_GRACE_S - 1)).toBe(false);
    expect(paneReplaceable({ command: "-zsh", createdS: 1000 }, 1000 + PANE_CLAIM_GRACE_S)).toBe(true);
  });
});

describe("workflow/runResume runPaneLaunchLine", () => {
  // A pane whose runner exited used to sit at its shell, holding its own tmux
  // server forever (247 of them on 2026-10-23).
  test("the run's pane, and its tmux server, end when the runner exits", async () => {
    const { execFileSync } = await import("child_process");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "launchline-"));
    const tmux = (...args: string[]) => execFileSync("tmux", ["-S", path.join(dir, "s"), "-f", "/dev/null", ...args], { encoding: "utf-8" });
    try {
      tmux("new-session", "-d", "-s", "wf-test", "/bin/bash", "--norc", "--noprofile");
      tmux("send-keys", "-t", "wf-test", "-l", runPaneLaunchLine(["true"], "th_test"));
      tmux("send-keys", "-t", "wf-test", "Enter");
      const deadline = Date.now() + 10_000;
      let alive = true;
      while (alive && Date.now() < deadline) {
        try { tmux("has-session", "-t", "wf-test"); await new Promise((r) => setTimeout(r, 100)); } catch { alive = false; }
      }
      expect(alive).toBe(false);
    } finally {
      try { tmux("kill-server"); } catch {}
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("workflow/runResume deadRunPanes", () => {
  test("a run pane back at an idle shell closes; a live runner, a fresh shell and other sessions stay", () => {
    const now = 1_800_000_000;
    const old = now - DEAD_RUN_PANE_IDLE_S - 1;
    expect(deadRunPanes([
      { session: "wf-8h0tdw", command: "bash", activityS: old },
      { session: "wf-8h0tdw", command: "bash", activityS: old },
      { session: "wf-8gwa6d", command: "-zsh", activityS: old },
      { session: "wf-8h01x4", command: "cast", activityS: old },
      { session: "wf-8h0ek6", command: "bash", activityS: now - 60 },
      { session: "cc-claude-abc", command: "bash", activityS: old },
    ], now)).toEqual(["wf-8h0tdw", "wf-8gwa6d"]);
  });

  test("closing kills each dead pane's session through the daemon's tmux, and a listing that fails closes nothing", () => {
    const now = 1_800_000_000;
    const calls: string[][] = [];
    const tmux = (args: string[]) => { calls.push(args); return args[0] === "list-panes" ? `wf-aaaaaa|bash|${now - DEAD_RUN_PANE_IDLE_S - 5}\nwf-bbbbbb|cast|${now - 99_999}\n` : ""; };
    closeDeadRunPanes(tmux, () => {}, now);
    expect(calls.slice(1)).toEqual([["kill-session", "-t", "=wf-aaaaaa"]]);
    const none: string[][] = [];
    closeDeadRunPanes((args) => { none.push(args); throw new Error("no server"); }, () => {}, now);
    expect(none).toHaveLength(1);
  });
});
