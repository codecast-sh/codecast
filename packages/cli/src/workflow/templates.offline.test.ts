// line.cast driven offline through the runner's session path with a fake API,
// so the routing on the task's ground fields, handoff, verdict and node JSON is
// exercised without a daemon. The template's parse and station script tests
// live in templates.test.ts.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawnSync } from "child_process";
import { parseWorkflowSource } from "./parser";
import { PRESENTER_BASE, lineRunDir, runWorkflow } from "./runner";
import { BUILTIN_WORKFLOW_TEMPLATES } from "./templates";
import { unattendedOpening } from "../unattended";
import { isolateCodecastDirEachTest } from "../test-helpers/codecastDir.js";
import { UNION_PROFILE } from "../test-helpers/unionLineProfile";
isolateCodecastDirEachTest("cast-wf-state-");

// ── Offline runs through the session path ────────────────────────────────────
// Every hand settles at once and writes what the real hand would through the
// CLI; command nodes that reach git, evals or the server are stubbed with the
// output their scripts print (their own behavior is tested above).
const offlineLine = (dir: string) => {
  const graph = parseWorkflowSource(BUILTIN_WORKFLOW_TEMPLATES.line);
  const stub = (id: string, script: string) => { graph.nodes.get(id)!.script = script; };
  stub("red", `echo '{"red": true, "dir": "${dir}"}'`);
  stub("green", "true");
  stub("eval", "true");
  stub("card_draft", `echo '{"card": {"wrong": ""}}'`);
  for (const id of ["card", "ship", "watch", "park", "dissolve", "unproven", "reopen", "drop"]) stub(id, "true");
  graph.nodes.get("verify")!.script = "true";
  return graph;
};

type Station = "ground" | "plan" | "analyze" | "prove" | "implement" | "review" | "card_write";
const STATION_OF: Array<[RegExp, Station]> = [
  [/^You ground one cause/m, "ground"],
  [/^You write the plan/m, "plan"],
  [/acceptance criteria an independent reviewer/, "analyze"],
  [/^You show the miss/m, "prove"],
  [/Implement task/, "implement"],
  [/You are the independent reviewer/, "review"],
  [/^# Presenting a decision/m, "card_write"],
];

describe("line.cast offline run through the session path", () => {
  let tmpDir: string;
  let origFetch: typeof fetch;
  let origLog: typeof console.log;
  let calls: Array<{ route: string; body: any }>;
  let task: any;
  let spawnCount: number;
  let stationOf: Record<string, Station>;
  // What each station's hand pins as its state (the runner reads node JSON from it).
  let pinned: Partial<Record<Station, string>>;
  // The status a hand pinned with it, when not done.
  let pinnedStatus: Partial<Record<Station, string>>;
  let gateAnswers: string[];
  let effects: Partial<Record<Station, () => void>>;

  const grounded = { readiness: "ready", goal_ref: "in-3:activation", category: "code", risk: "low" };
  const opts = (extra: Record<string, any> = {}) => ({ cwd: tmpDir, taskId: "ct-7", apiToken: "tok", convexSiteUrl: "https://convex.test", pollIntervalMs: 1, ...extra });
  const spawns = () => calls.filter((c) => c.route === "/cli/spawn").map((c, i) => ({ station: stationOf[`conv_${i + 1}`], ...c.body }));
  const stations = () => spawns().map((s) => s.station);

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "line-"));
    origFetch = globalThis.fetch;
    origLog = console.log;
    console.log = () => {};
    calls = [];
    spawnCount = 0;
    stationOf = {};
    gateAnswers = [];
    pinnedStatus = {};
    task = { short_id: "ct-7", title: "Add the thing", status: "open", steps: [], assignee: "infra-lead" };
    pinned = {
      prove: 'Showed it failing.\n```json\n{"reproduced": true}\n```',
      card_write: 'Posted sd-1.\n```json\n{"question": "Should the thing be added?", "recommend": "ship", "why": "Y.", "page": "/r/present/page.html"}\n```',
    };
    effects = {
      ground: () => { task = { ...task, ...grounded }; },
      analyze: () => { task = { ...task, steps: [{ title: "A works" }, { title: "B works" }] }; },
      implement: () => { task = { ...task, status: "in_review", execution_status: "done" }; },
      review: () => { task = { ...task, status: "done", review_verdict: { verdict: "approve", at: Date.now() + 1 } }; },
    };
    globalThis.fetch = (async (url: any, init: any) => {
      const route = String(url).replace(/^https?:\/\/[^/]+/, "");
      const body = JSON.parse(init?.body || "{}");
      calls.push({ route, body });
      let out: any = {};
      if (route === "/cli/work/get") out = task;
      else if (route === "/cli/spawn") {
        spawnCount++;
        const id = `conv_${spawnCount}`;
        stationOf[id] = STATION_OF.find(([re]) => re.test(body.prompt))?.[1] ?? ("unknown" as Station);
        out = { conversation_id: id, short_id: `s${spawnCount}` };
      } else if (route === "/cli/inbox") {
        const id = body.session_ids[0];
        effects[stationOf[id]]?.();
        out = { sessions: [{ id, work_state: "done", is_live: false }] };
      } else if (route === "/cli/sessions/state/get") {
        // Each read is a fresh pin, so a presenter the run went back to reads as answering again.
        out = { ok: true, status: pinnedStatus[stationOf[body.session]] ?? "done", state: pinned[stationOf[body.session]] ?? null, at: calls.length };
      } else if (route === "/cli/workflow-runs/poll-gate") {
        out = { status: "paused", gate_response: gateAnswers.shift() ?? null };
      } else if (route === "/cli/work/update" || route === "/cli/work/comment" || route === "/cli/decide") {
        if (route === "/cli/work/update" && body.status) task = { ...task, status: body.status };
        out = { success: true, id: "sd-1" };
      }
      return new Response(JSON.stringify(out), { status: 200 });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
    console.log = origLog;
    fs.rmSync(tmpDir, { recursive: true });
  });

  test("a grounded code cause runs every hand in order, asks Ship on the card, ships and watches", async () => {
    gateAnswers = ["S"];
    const graph = offlineLine(tmpDir);
    const outcome = await runWorkflow(graph, opts({ runId: "run_1", spawnerSession: "owner-sess" }));
    expect(outcome).toBe("completed");
    expect(stations()).toEqual(["ground", "analyze", "prove", "implement", "review", "card_write"]);
    const s = spawns();
    expect(s[0].prompt.startsWith(`${unattendedOpening('the "Ground" step of workflow line (run run_1)')}\n\n`)).toBe(true);
    expect(s[0].prompt).toContain("cast goals --brief");
    expect(s[1].prompt).toContain("cast task update ct-7 --steps -");
    // prove and implement share the line's worktree and branch.
    for (const hand of [s[2], s[3]]) {
      expect(hand.isolated).toBe(true);
      expect(hand.worktree_name).toBe("line-ct-7");
      expect(typeof hand.device).toBe("string");
    }
    // $run_dir is set by the runner before the first node, the same for every station.
    expect(s[3].prompt).toContain(`${lineRunDir(tmpDir, "line-ct-7")}/repro.sh`);
    // The review station is the task's reviewer, never the running role's
    // hand: review_for_task instead of spawner_session (the-line.md L3).
    expect(s[4].review_for_task).toBe("ct-7");
    expect(s[4].spawner_session).toBeUndefined();
    expect(s[3].spawner_session).toBe("owner-sess");
    expect(s[4].prompt).toContain("Branch: codecast/line-ct-7");
    expect(s[4].prompt).toContain("- A works\n- B works");
    expect(s[4].prompt).toContain("Add the thing");
    expect(s[5].prompt).toContain('{"wrong":""}');
    expect(s.every((x) => x.agent_type === "claude_code")).toBe(true);
    const gate = calls.find((c) => c.route === "/cli/workflow-runs/gate")!.body;
    expect(gate).toMatchObject({ node_id: "decide", prompt: "Should the thing be added?", category: "review", asker_session_id: "s6" });
    // The presenting station reads codecast's base presenter, then the line's addendum.
    expect(s[5].prompt).toContain(PRESENTER_BASE);
    expect(gate.stack).toBeUndefined();
    expect(gate.doc_md).toBe("Y.");
    expect(gate.choices.map((c: any) => [c.key, c.target])).toEqual([["S", "rebase"], ["R", "reopen"], ["D", "drop"]]);
    const ran = calls.filter((c) => c.route === "/cli/workflow-runs/progress" && c.body.node_status === "completed").map((c) => c.body.node_id);
    // Offline there is no worktree to rebase: the station says it could not, and ship decides.
    const ended = calls.filter((c) => c.route === "/cli/workflow-runs/progress" && c.body.node_status !== "running").map((c) => c.body.node_id);
    expect(ended.slice(-4)).toEqual(["rebase", "ship", "watch", "exit"]);
  }, 30000);

  test("the runner loads the repo's profile: a project with a ship command ships and watches without the merge step", async () => {
    spawnSync("git", ["init", "-q", tmpDir]);
    fs.mkdirSync(path.join(tmpDir, ".codecast"));
    fs.writeFileSync(path.join(tmpDir, ".codecast", "line.toml"), UNION_PROFILE);
    gateAnswers = ["S"];
    const outcome = await runWorkflow(offlineLine(tmpDir), opts({ runId: "run_1" }));
    expect(outcome).toBe("completed");
    const s = spawns();
    expect(s.find((x) => x.station === "implement")!.prompt).toContain("outreach/docs/line/principles.md");
    const ran = calls.filter((c) => c.route === "/cli/workflow-runs/progress" && c.body.node_status === "completed").map((c) => c.body.node_id);
    expect(ran.slice(-3)).toEqual(["ship", "watch", "exit"]);
    expect(ran).not.toContain("merge");
  }, 30000);

  test("a miss that does not reproduce dissolves, and the dissolve station's line reaches the run as its node's result", async () => {
    pinned.prove = 'No miss.\n```json\n{"reproduced": false}\n```';
    const graph = offlineLine(tmpDir);
    graph.nodes.get("dissolve")!.script = `printf '{"dissolved": "judge_defect", "moments": 2}\\n'; echo "Marked ct-7 done"`;
    expect(await runWorkflow(graph, opts({ runId: "run_1" }))).toBe("completed");
    expect(stations()).toEqual(["ground", "analyze", "prove"]);
    const node = calls.find((c) => c.route === "/cli/workflow-runs/progress" && c.body.node_id === "dissolve" && c.body.node_status === "completed")!.body;
    expect(JSON.parse(node.result_preview.split("\n")[0])).toEqual({ dissolved: "judge_defect", moments: 2 });
  }, 30000);

  // The real unproven script runs, its cast calls logged by a stub, so the
  // test sees the blocker a person would: what Prove said, or, when the hand
  // never spawned and left no output, the run's last error.
  test.each([
    ["settles without its proof", "I could not write a test that shows the miss."],
    ["never spawns", "What Prove tried: spawn failed"],
  ])("a prove that %s parks at unproven with what it tried, and the run completes", async (how, tried) => {
    pinned.prove = "I could not write a test that shows the miss.";
    if (how === "never spawns") {
      const fetchOk = globalThis.fetch;
      globalThis.fetch = (async (url: any, init: any) =>
        String(url).endsWith("/cli/spawn") && /^You show the miss/m.test(JSON.parse(init.body).prompt)
          ? new Response("{}", { status: 200 })
          : fetchOk(url, init)) as typeof fetch;
    }
    // One JSON array per call: Prove's output runs over several lines.
    const castLog = path.join(tmpDir, "cast.log");
    const castStub = path.join(tmpDir, "cast");
    fs.writeFileSync(castStub, `#!/usr/bin/env bun\nrequire("fs").appendFileSync(${JSON.stringify(castLog)}, JSON.stringify(process.argv.slice(2)) + "\\n");\n`, { mode: 0o755 });
    const graph = offlineLine(tmpDir);
    graph.nodes.get("unproven")!.script = parseWorkflowSource(BUILTIN_WORKFLOW_TEMPLATES.line).nodes.get("unproven")!.script!.replaceAll("cast ", `${castStub} `);
    expect(await runWorkflow(graph, opts({ runId: "run_1" }))).toBe("completed");
    const ran = calls.filter((c) => c.route === "/cli/workflow-runs/progress" && c.body.node_status === "completed").map((c) => c.body.node_id);
    expect(ran.slice(-2)).toEqual(["unproven", "exit"]);
    const castCalls: string[][] = fs.readFileSync(castLog, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
    expect(castCalls).toEqual([
      ["task", "update", "ct-7", "-s", "open"],
      ["task", "comment", "ct-7", expect.stringContaining(tried), "-t", "blocker"],
    ]);
    expect(castCalls[1][3]).toStartWith("Parked at prove: Prove wrote no proof, so the miss was neither shown nor ruled out. Rerun the flow once it can be shown. What Prove tried: ");
    // Parked, never closed: no done or drop reached the task.
    expect(castCalls.some((c) => c[1] === "done" || c[1] === "drop")).toBe(false);
    expect(calls.some((c) => c.route === "/cli/work/done" || c.route === "/cli/work/drop")).toBe(false);
  }, 30000);

  test("a malformed profile stops the run before any hand starts", async () => {
    spawnSync("git", ["init", "-q", tmpDir]);
    fs.mkdirSync(path.join(tmpDir, ".codecast"));
    fs.writeFileSync(path.join(tmpDir, ".codecast", "line.toml"), "[line]\nsize_budjet = 400\n");
    const origErr = console.error;
    console.error = () => {};
    try {
      expect(await runWorkflow(offlineLine(tmpDir), opts())).toBe("invalid");
    } finally {
      console.error = origErr;
    }
    expect(spawns()).toEqual([]);
  }, 30000);

  test("a Revise note reaches the builder once, and no later hand sees it", async () => {
    gateAnswers = ["R: keep the old flag", "S"];
    const outcome = await runWorkflow(offlineLine(tmpDir), opts({ runId: "run_1" }));
    expect(outcome).toBe("completed");
    // The second Present goes back to the hand that presented (runner presentsDecision), so it spawns nothing.
    expect(stations()).toEqual(["ground", "analyze", "prove", "implement", "review", "card_write", "implement", "review"]);
    expect(calls.filter((c) => c.route === "/cli/messages/send" && c.body.to === "conv_6")).toHaveLength(1);
    const s = spawns();
    expect(s[6].prompt).toContain("# Human Instructions\nkeep the old flag");
    expect(s.filter((x) => x.prompt.includes("keep the old flag"))).toHaveLength(1);
  }, 30000);

  test("a cause ground parks never builds", async () => {
    effects.ground = () => { task = { ...task, ...grounded, goal_ref: "none" }; };
    const outcome = await runWorkflow(offlineLine(tmpDir), opts());
    expect(outcome).toBe("completed");
    expect(stations()).toEqual(["ground"]);
  });

  test("plan risk plans and builds without asking: the first question is the presenter's, at the end", async () => {
    effects.ground = () => { task = { ...task, ...grounded, risk: "plan" }; };
    pinned.plan = "Approach: one table.";
    gateAnswers = ["S"];
    const outcome = await runWorkflow(offlineLine(tmpDir), opts({ runId: "run_1" }));
    expect(outcome).toBe("completed");
    expect(stations()).toEqual(["ground", "plan", "analyze", "prove", "implement", "review", "card_write"]);
    expect(calls.filter((c) => c.route === "/cli/workflow-runs/gate").map((c) => c.body.node_id)).toEqual(["decide"]);
  }, 30000);

  test("a miss that does not reproduce dissolves the cause", async () => {
    pinned.prove = 'Could not reproduce.\n```json\n{"reproduced": false}\n```';
    const outcome = await runWorkflow(offlineLine(tmpDir), opts());
    expect(outcome).toBe("completed");
    expect(stations()).toEqual(["ground", "analyze", "prove"]);
  });

  test("a review round with no fresh verdict fails the run and returns the task to open with a comment", async () => {
    effects.review = () => { task = { ...task, review_verdict: undefined }; };
    const outcome = await runWorkflow(offlineLine(tmpDir), opts());
    expect(outcome).toBe("failed");
    expect(calls.find((c) => c.route === "/cli/work/update")?.body).toMatchObject({ short_id: "ct-7", status: "open" });
    const comment = calls.find((c) => c.route === "/cli/work/comment")?.body;
    expect(comment?.comment_type).toBe("blocker");
    expect(comment?.text).toContain("the flow had no next step for it");
  });

  test("a run that fails on a problem closed meanwhile leaves the close standing: no reopen, no blocker (ct-59242, ct-59534)", async () => {
    effects.review = () => { task = { ...task, status: "dropped", review_verdict: undefined }; };
    const outcome = await runWorkflow(offlineLine(tmpDir), opts());
    expect(outcome).toBe("failed");
    expect(calls.some((c) => c.route === "/cli/work/update" && c.body.status === "open")).toBe(false);
    expect(calls.some((c) => c.route === "/cli/work/comment" && c.body.comment_type === "blocker")).toBe(false);
  });

  test("a hand that never settles fails its node, which ends the hand, and the task returns to open", async () => {
    const settle = globalThis.fetch;
    globalThis.fetch = (async (url: any, init: any) => {
      if (String(url).endsWith("/cli/inbox")) {
        calls.push({ route: "/cli/inbox", body: JSON.parse(init.body) });
        return new Response(JSON.stringify({ sessions: [{ id: "conv_1", work_state: "working", is_live: true }] }), { status: 200 });
      }
      return settle(url, init);
    }) as typeof fetch;
    const outcome = await runWorkflow(offlineLine(tmpDir), opts({ agentTimeout: 30, runId: "run_1" }));
    expect(outcome).toBe("failed");
    expect(calls.some((c) => c.route === "/cli/workflow-runs/progress" && c.body.node_status === "failed" && c.body.session_id === "s1")).toBe(true);
    expect(calls.find((c) => c.route === "/cli/work/update")?.body).toMatchObject({ short_id: "ct-7", status: "open" });
    expect(calls.find((c) => c.route === "/cli/work/comment")?.body.text).toContain("killed");
    expect(calls.filter((c) => c.route === "/cli/spawn")).toHaveLength(1);
  }, 30000);

  // The blocker comment reaches the session that owns the task, often the
  // station's own hand; posted before the run-over report (which stops the
  // hands), it resumed ct-59998's dead Implement hand after its run ended.
  test("a failed run is reported over, stopping its hands, before the blocker comment goes out", async () => {
    const settle = globalThis.fetch;
    globalThis.fetch = (async (url: any, init: any) => {
      if (String(url).endsWith("/cli/inbox")) {
        calls.push({ route: "/cli/inbox", body: JSON.parse(init.body) });
        return new Response(JSON.stringify({ sessions: [{ id: "conv_1", work_state: "working", is_live: true }] }), { status: 200 });
      }
      return settle(url, init);
    }) as typeof fetch;
    expect(await runWorkflow(offlineLine(tmpDir), opts({ agentTimeout: 30, runId: "run_1" }))).toBe("failed");
    const runOver = calls.findIndex((c) => c.route === "/cli/workflow-runs/progress" && c.body.run_status === "failed");
    const blocker = calls.findIndex((c) => c.route === "/cli/work/comment" && c.body.comment_type === "blocker");
    expect(runOver).toBeGreaterThanOrEqual(0);
    expect(blocker).toBeGreaterThan(runOver);
  }, 30000);

  test("a hand parked on a usage limit is waited out, not read as settled", async () => {
    const settle = globalThis.fetch;
    let parkedPolls = 0;
    globalThis.fetch = (async (url: any, init: any) => {
      const body = JSON.parse(init?.body || "{}");
      if (String(url).endsWith("/cli/inbox") && stationOf[body.session_ids?.[0]] === "prove" && parkedPolls < 3) {
        parkedPolls++;
        calls.push({ route: "/cli/inbox", body });
        return new Response(JSON.stringify({ sessions: [{ id: body.session_ids[0], work_state: "needs_input", is_live: true, blocked_on: "limit" }] }), { status: 200 });
      }
      return settle(url, init);
    }) as typeof fetch;
    gateAnswers = ["S"];
    const outcome = await runWorkflow(offlineLine(tmpDir), opts({ runId: "run_1" }));
    expect(parkedPolls).toBe(3);
    expect(outcome).toBe("completed");
    expect(stations()).toContain("implement");
  });

  test("the review hand receives only the branch, title and criteria: no context or error appendix", async () => {
    const graph = offlineLine(tmpDir);
    // verify fails once so a last_error exists when review runs
    graph.nodes.get("verify")!.script = "test -f ok && exit 0; touch ok; echo boom; exit 1";
    task.description = "SECRET DESCRIPTION";
    effects.review = () => { task = { ...task, status: "open", review_verdict: { verdict: "reject", at: Date.now() + 1 } }; };
    const outcome = await runWorkflow(graph, opts());
    expect(outcome).toBe("failed");
    const review = spawns().find((s) => s.station === "review")!.prompt as string;
    expect(review).toContain("Branch: codecast/line-ct-7");
    expect(review).toContain("Add the thing");
    expect(review).toContain("- A works\n- B works");
    expect(review).not.toContain("SECRET DESCRIPTION");
    expect(review).not.toContain("# Context");
    expect(review).not.toContain("# Last Error");
    expect(review).not.toContain("boom");
    expect(review).not.toContain("session_id");
  }, 30000);

  // A builder that cannot go on ends the run on purpose with its own words:
  // the problem goes back to open with them, and nobody is asked anything.
  for (const status of ["needs_context", "blocked"] as const) {
    test(`a ${status} handoff stops the run with the builder's words and asks nobody`, async () => {
      effects.implement = () => {
        task = { ...task, status: "in_review", execution_status: status, verification_evidence: "The fix needs the release branch, which this checkout does not have." };
      };
      const outcome = await runWorkflow(offlineLine(tmpDir), opts({ runId: "run_1", spawnerSession: "owner-sess" }));
      expect(outcome).toBe("failed");
      expect(stations()).toEqual(["ground", "analyze", "prove", "implement"]);
      expect(calls.some((c) => c.route === "/cli/workflow-runs/gate")).toBe(false);
      expect(calls.some((c) => c.route === "/cli/decide")).toBe(false);
      expect(calls.filter((c) => c.route === "/cli/work/update").at(-1)?.body).toMatchObject({ short_id: "ct-7", status: "open" });
      const blocker = calls.find((c) => c.route === "/cli/work/comment" && c.body.comment_type === "blocker")?.body.text;
      expect(blocker).toBe("Stopped: The fix needs the release branch, which this checkout does not have.");
      const ended = calls.filter((c) => c.route === "/cli/workflow-runs/progress" && c.body.run_status === "failed").at(-1)?.body;
      expect(ended?.fail_reason).toBe(blocker);
    }, 30000);
  }

  test("a planner that pins blocked stops the run with what is missing", async () => {
    effects.ground = () => { task = { ...task, ...grounded, risk: "plan" }; };
    pinnedStatus.plan = "blocked";
    pinned.plan = "No record says which billing provider the new plan uses.";
    const outcome = await runWorkflow(offlineLine(tmpDir), opts({ runId: "run_1", spawnerSession: "owner-sess" }));
    expect(outcome).toBe("failed");
    expect(stations()).toEqual(["ground", "plan"]);
    expect(calls.some((c) => c.route === "/cli/workflow-runs/gate" || c.route === "/cli/decide")).toBe(false);
    expect(calls.find((c) => c.route === "/cli/work/comment" && c.body.comment_type === "blocker")?.body.text)
      .toBe("Stopped: No record says which billing provider the new plan uses.");
  }, 30000);

  test("a hand that ends with no handoff is asked for one once, then returns the task to open", async () => {
    effects.implement = () => { task = { ...task, status: "in_progress", execution_status: undefined }; };
    const outcome = await runWorkflow(offlineLine(tmpDir), opts({ handoffAskGraceMs: 20 }));
    expect(outcome).toBe("failed");
    expect(stations()).toEqual(["ground", "analyze", "prove", "implement"]);
    expect(calls.filter((c) => c.route === "/cli/messages/send").map((c) => c.body.to)).toEqual(["conv_4"]);
    expect(calls.find((c) => c.route === "/cli/work/update")?.body).toMatchObject({ short_id: "ct-7", status: "open" });
  }, 30000);

  test("a reject verdict stops the run with the reviewer's note and asks nobody", async () => {
    effects.review = () => { task = { ...task, status: "open", execution_status: "blocked", review_verdict: { verdict: "reject", note: "criterion B unmet", at: Date.now() + 1 } }; };
    const outcome = await runWorkflow(offlineLine(tmpDir), opts({ spawnerSession: "owner-sess" }));
    expect(outcome).toBe("failed");
    expect(calls.some((c) => c.route === "/cli/decide")).toBe(false);
    expect(calls.find((c) => c.route === "/cli/work/comment")?.body).toMatchObject({ comment_type: "blocker", text: "Stopped: The reviewer rejected the change. criterion B unmet" });
  }, 30000);

  test("rounds exhausted leaves the problem open with why, and asks nobody", async () => {
    const graph = offlineLine(tmpDir);
    graph.nodes.get("verify")!.script = [
      `echo '{"ok":false,"steps":[{"name":"typecheck","ok":false,"detail":"exit 1"},{"name":"tripwires","ok":true,"detail":"passed"}],"logs":"/tmp/run/cast-line"}'`,
      `echo 'check: typecheck' >&2`,
      `echo 'x mobile: 6 errors' >&2`,
      `exit 1`,
    ].join("\n");
    const outcome = await runWorkflow(graph, opts({ spawnerSession: "owner-sess" }));
    expect(outcome).toBe("failed");
    expect(stations()).toEqual(["ground", "analyze", "prove", "implement", "implement", "implement"]);
    expect(calls.some((c) => c.route === "/cli/decide")).toBe(false);
    // Each round back at Implement reopens the work; the run's end leaves it open.
    expect(calls.filter((c) => c.route === "/cli/work/update").map((c) => c.body.status)).toEqual(["in_progress", "in_progress", "open"]);
    const blocker = calls.find((c) => c.route === "/cli/work/comment")?.body;
    expect(blocker?.comment_type).toBe("blocker");
    expect(blocker?.text).toContain("ran the most rounds this flow allows");
    expect(blocker?.text).toContain("Verify sent the last round back");
    expect(blocker?.text).toContain("- ✗ typecheck: exit 1\n- ✓ tripwires");
    expect(blocker?.text).not.toContain('{"ok"');
  }, 30000);
});
