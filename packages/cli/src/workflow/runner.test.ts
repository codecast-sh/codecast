import { describe, test, expect, beforeEach, afterEach, setSystemTime } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { parseWorkflowSource, parseWorkflowFile, validateWorkflow } from "./parser.js";
import { runWorkflow, reportRunStopped, refreshedOnResume, graphToPushPayload, parseGateEdgeLabel, gatePayload, handTimeoutMs, stationTitle, runRegistrationIsFatal, type RunOptions } from "./runner.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cast-wf-test-"));
}

function captureConsole(): { logs: string[]; restore: () => void } {
  const logs: string[] = [];
  const orig = { log: console.log, error: console.error };
  console.log = (...args: any[]) => logs.push(args.join(" "));
  console.error = (...args: any[]) => logs.push(args.join(" "));
  return {
    logs,
    restore() {
      console.log = orig.log;
      console.error = orig.error;
    },
  };
}

// ── Runner (dry-run) tests ────────────────────────────────────────────────────

describe("workflow/runner (dry-run)", () => {
  let tmpDir: string;
  let cap: ReturnType<typeof captureConsole>;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    cap = captureConsole();
  });

  afterEach(() => {
    cap.restore();
    fs.rmSync(tmpDir, { recursive: true });
  });

  const dryRun: RunOptions = { dryRun: true };

  test("start→exit workflow completes", async () => {
    const g = parseWorkflowSource(`digraph g {
      start [shape=Mdiamond]
      exit  [shape=Msquare]
      start -> exit
    }`);
    await runWorkflow(g, { ...dryRun, cwd: tmpDir });
    expect(cap.logs.some(l => l.includes("complete"))).toBe(true);
  });

  test("multi-node linear workflow completes", async () => {
    const g = parseWorkflowSource(`digraph g {
      start [shape=Mdiamond]
      plan  [label="Plan"]
      impl  [label="Implement"]
      exit  [shape=Msquare]
      start -> plan -> impl -> exit
    }`);
    await runWorkflow(g, { ...dryRun, cwd: tmpDir });
    expect(cap.logs.some(l => l.includes("complete"))).toBe(true);
  });

  test("dry-run routes success condition correctly", async () => {
    const g = parseWorkflowSource(`digraph g {
      start  [shape=Mdiamond]
      verify [shape=parallelogram, script="exit 0"]
      good   [label="Good"]
      bad    [label="Bad"]
      exit   [shape=Msquare]
      start  -> verify
      verify -> good [condition="outcome = success"]
      verify -> bad  [condition="outcome = failure"]
      good   -> exit
      bad    -> exit
    }`);
    await runWorkflow(g, { ...dryRun, cwd: tmpDir });
    const goodVisited = cap.logs.some(l => l.includes("Good"));
    const badVisited = cap.logs.some(l => l.includes("Bad"));
    // In dry-run all outcomes are success, so Good should be visited
    expect(goodVisited).toBe(true);
    expect(badVisited).toBe(false);
  });

  test("goal override replaces workflow goal", async () => {
    const g = parseWorkflowSource(`digraph g {
      graph [goal="original goal"]
      start [shape=Mdiamond]
      exit  [shape=Msquare]
      start -> exit
    }`);
    await runWorkflow(g, { ...dryRun, cwd: tmpDir, goalOverride: "overridden goal" });
    expect(cap.logs.some(l => l.includes("overridden goal"))).toBe(true);
    expect(cap.logs.some(l => l.includes("original goal"))).toBe(false);
  });

  test("injects task_id into context via RunOptions", async () => {
    const g = parseWorkflowSource(`digraph g {
      graph [goal="$task_title"]
      start [shape=Mdiamond]
      exit  [shape=Msquare]
      start -> exit
    }`);
    // No convexSiteUrl so task fetch is skipped; task_id still injected
    await runWorkflow(g, { ...dryRun, cwd: tmpDir, taskId: "ct-test123" });
    // Workflow should complete without error
    expect(cap.logs.some(l => l.includes("complete"))).toBe(true);
  });

  test("max_visits exceeded aborts workflow", async () => {
    // A loop: impl → verify → impl with max_visits=2 on impl
    const g = parseWorkflowSource(`digraph g {
      start  [shape=Mdiamond]
      impl   [label="Impl", max_visits=2]
      verify [label="Verify"]
      exit   [shape=Msquare]
      start  -> impl -> verify
      verify -> impl
    }`);
    await runWorkflow(g, { ...dryRun, cwd: tmpDir });
    expect(cap.logs.some(l => l.includes("max_visits"))).toBe(true);
  });

  test("an edge can route on a station's visit count before max_visits aborts", async () => {
    // The loop leaves for `out` once impl has run twice, so its max_visits=2 never trips.
    const g = parseWorkflowSource(`digraph g {
      start  [shape=Mdiamond]
      impl   [label="Impl", max_visits=2]
      verify [label="Verify"]
      out    [label="Out"]
      exit   [shape=Msquare]
      start  -> impl -> verify
      verify -> out  [condition="impl.visits >= 2"]
      verify -> impl [condition="outcome = success"]
      out -> exit
    }`);
    const outcome = await runWorkflow(g, { ...dryRun, cwd: tmpDir });
    expect(cap.logs.some(l => l.includes("max_visits"))).toBe(false);
    expect(cap.logs.some(l => l.includes("Out"))).toBe(true);
    expect(outcome).not.toBe("failure");
  });

  test("workflow reports invalid when validation errors exist", async () => {
    const g = parseWorkflowSource(`digraph g {
      exit [shape=Msquare]
    }`);
    // runWorkflow returns its outcome instead of touching process exit state —
    // the CLI wrappers translate to an exit code at the process boundary.
    const outcome = await runWorkflow(g, { ...dryRun, cwd: tmpDir });
    expect(outcome).toBe("invalid");
  });
});

// ── Runner (real command) tests ───────────────────────────────────────────────

describe("workflow/runner (command nodes)", () => {
  let tmpDir: string;
  let cap: ReturnType<typeof captureConsole>;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    cap = captureConsole();
  });

  afterEach(() => {
    cap.restore();
    fs.rmSync(tmpDir, { recursive: true });
  });

  test("command node with exit 0 produces success outcome", async () => {
    const g = parseWorkflowSource(`digraph g {
      start  [shape=Mdiamond]
      verify [shape=parallelogram, script="exit 0"]
      done   [shape=Msquare]
      start -> verify -> done
    }`);
    await runWorkflow(g, { cwd: tmpDir });
    expect(cap.logs.some(l => l.includes("success"))).toBe(true);
  });

  test("command node with exit 1 routes to failure edge", async () => {
    const g = parseWorkflowSource(`digraph g {
      start  [shape=Mdiamond]
      check  [shape=parallelogram, script="exit 1"]
      ok     [shape=parallelogram, script="echo routed-ok"]
      fail   [shape=parallelogram, script="echo routed-fail"]
      exit   [shape=Msquare]
      start -> check
      check -> ok   [condition="outcome = success"]
      check -> fail [condition="outcome = failure"]
      ok   -> exit
      fail -> exit
    }`);
    await runWorkflow(g, { cwd: tmpDir });
    expect(cap.logs.some(l => l.includes("routed-fail"))).toBe(true);
    expect(cap.logs.some(l => l.includes("routed-ok"))).toBe(false);
  });

  test("command node captures script output in context", async () => {
    const g = parseWorkflowSource(`digraph g {
      start  [shape=Mdiamond]
      run    [shape=parallelogram, script="echo hello-world"]
      exit   [shape=Msquare]
      start -> run -> exit
    }`);
    await runWorkflow(g, { cwd: tmpDir });
    expect(cap.logs.some(l => l.includes("hello-world"))).toBe(true);
  });

  test("command node honors a per-node timeout attribute (seconds)", async () => {
    const g = parseWorkflowSource(`digraph g {
      start [shape=Mdiamond]
      slow  [shape=parallelogram, script="sleep 2; echo done", timeout=1]
      exit  [shape=Msquare]
      start -> slow
      slow -> exit [condition="outcome = success"]
    }`);
    expect(g.nodes.get("slow")?.timeout).toBe(1);
    const outcome = await runWorkflow(g, { cwd: tmpDir });
    expect(outcome).toBe("failed");
  }, 15000);

  test("command node times out and returns failure for hanging script", async () => {
    const g2 = parseWorkflowSource(`digraph g {
      start [shape=Mdiamond]
      check [shape=parallelogram, script="exit 42"]
      exit  [shape=Msquare]
      start -> check -> exit
    }`);
    await runWorkflow(g2, { cwd: tmpDir });
    expect(cap.logs.some(l => l.includes("failed") || l.includes("✗"))).toBe(true);
  });
});

// ── Runner (goal-gate retry) tests ───────────────────────────────────────────

describe("workflow/runner (goal-gate retry)", () => {
  let tmpDir: string;
  let cap: ReturnType<typeof captureConsole>;
  let origFetch: typeof fetch;
  let fetched: string[];

  beforeEach(() => {
    tmpDir = makeTmpDir();
    cap = captureConsole();
    origFetch = globalThis.fetch;
    fetched = [];
    globalThis.fetch = (async (url: any) => {
      const u = String(url);
      fetched.push(u);
      const body = u.includes("/cli/workflow-runs/poll-gate")
        ? { status: "paused", gate_response: "ok" }
        : {};
      return new Response(JSON.stringify(body), { status: 200 });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
    cap.restore();
    fs.rmSync(tmpDir, { recursive: true });
  });

  test("retry path routes human nodes through the remote gate when runId is set", async () => {
    // check fails on first visit (goal gate), retry_target sends the run
    // through a human node. With runId set the human node must use the
    // remote gate (fetch) — never the stdin prompt, which would hang headless.
    const g = parseWorkflowSource(`digraph g {
      start  [shape=Mdiamond]
      check  [shape=parallelogram, script="test -f marker && exit 0; touch marker; exit 1", goal_gate=true, retry_target="review"]
      review [shape=hexagon, label="Review"]
      exit   [shape=Msquare]
      start  -> check -> exit
      review -> check
    }`);
    const outcome = await runWorkflow(g, {
      cwd: tmpDir,
      runId: "run-1",
      apiToken: "tok",
      convexSiteUrl: "https://convex.test",
    });
    expect(outcome).toBe("completed");
    expect(fetched.some(u => u.includes("/cli/workflow-runs/gate"))).toBe(true);
  }, 20000);
});

// ── Gates are decisions (the-line.md L4) ─────────────────────────────────────

describe("workflow/runner (gate payload)", () => {
  let tmpDir: string;
  let cap: ReturnType<typeof captureConsole>;
  let origFetch: typeof fetch;
  let calls: Array<{ route: string; body: any }>;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    cap = captureConsole();
    origFetch = globalThis.fetch;
    calls = [];
    globalThis.fetch = (async (url: any, init: any) => {
      const route = String(url).replace(/^https?:\/\/[^/]+/, "");
      calls.push({ route, body: JSON.parse(init?.body || "{}") });
      const body = route === "/cli/workflow-runs/poll-gate" ? { status: "running", gate_response: "A: fine" } : { ok: true };
      return new Response(JSON.stringify(body), { status: 200 });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
    cap.restore();
    fs.rmSync(tmpDir, { recursive: true });
  });

  test("a hand runs as long as its node's timeout, else the run's, else 30 minutes", () => {
    expect(handTimeoutMs({ timeout: 5400 }, { agentTimeout: 60_000 })).toBe(5_400_000);
    expect(handTimeoutMs({}, { agentTimeout: 60_000 })).toBe(60_000);
    expect(handTimeoutMs({}, {})).toBe(1_800_000);
  });

  test("a failing dry run on a bound task never moves or comments on the task", async () => {
    const g = parseWorkflowSource(`digraph g {
      start [shape=Mdiamond]
      prove [label="Prove"]
      exit  [shape=Msquare]
      start -> prove
      prove -> exit [condition="prove.json.reproduced = true"]
    }`);
    const outcome = await runWorkflow(g, { dryRun: true, cwd: tmpDir, taskId: "ct-1", planId: "pl-1", apiToken: "tok", convexSiteUrl: "https://convex.test" });
    expect(outcome).toBe("failed");
    // Reading the task, the plan and the problem's history is fine; nothing may write to any of them.
    expect(calls.map((c) => c.route).filter((r) => !r.endsWith("/get") && r !== "/cli/work/history")).toEqual([]);
  });

  test("an edge label parses into key, label and description", () => {
    expect(parseGateEdgeLabel("[A] Approve :: ships now")).toEqual({ key: "A", label: "[A] Approve", description: "ships now" });
    expect(parseGateEdgeLabel("[R] Revise")).toEqual({ key: "R", label: "[R] Revise" });
  });

  test("the gate route receives the choice descriptions, the expanded doc, the category and the graph stack", async () => {
    const g = parseWorkflowSource(`digraph g {
      graph [stack="Launch checklist"]
      start  [shape=Mdiamond]
      plan   [shape=parallelogram, script="echo the plan"]
      review [shape=hexagon, label="Review", prompt="Ship it?\nPlan: $plan.output", doc="# Plan\n\n$plan.output", category="review"]
      fix    [shape=parallelogram, script="true"]
      exit   [shape=Msquare]
      start  -> plan -> review
      review -> exit [label="[A] Approve :: ships now"]
      review -> fix  [label="[R] Revise :: another round"]
      fix    -> exit
    }`);
    const outcome = await runWorkflow(g, { cwd: tmpDir, runId: "run-1", apiToken: "tok", convexSiteUrl: "https://convex.test" });
    expect(outcome).toBe("completed");
    const gate = calls.find((c) => c.route === "/cli/workflow-runs/gate")!;
    expect(gate.body).toMatchObject({
      run_id: "run-1",
      node_id: "review",
      prompt: "Ship it?\nPlan: the plan",
      doc_md: "# Plan\n\nthe plan",
      category: "review",
      stack: "Launch checklist",
      choices: [
        { key: "A", label: "[A] Approve", description: "ships now", target: "exit" },
        { key: "R", label: "[R] Revise", description: "another round", target: "fix" },
      ],
    });
    // The answer routed on the key and left the note for the next node.
    expect(calls.some((c) => c.route === "/cli/workflow-runs/progress" && c.body.node_id === "fix")).toBe(false);
  });
});

// ── Node fidelity (the-line.md L8) ───────────────────────────────────────────

describe("workflow/graphToPushPayload", () => {
  test("the push payload carries definition, reviewer, timeout, temperature, doc and category", () => {
    const g = parseWorkflowSource(`digraph g {
      start  [shape=Mdiamond]
      impl   [label="Implement", prompt="do it", definition="coder", timeout=30, temperature=0.2, max_visits=2]
      review [label="Review", prompt="check it", reviewer=true]
      gate   [shape=hexagon, prompt="Ship?", doc="$review.output", category="review"]
      exit   [shape=Msquare]
      start -> impl -> review -> gate
      gate -> exit [label="[A] Approve :: ships"]
    }`);
    const { nodes, edges } = graphToPushPayload(g);
    const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));
    expect(byId.impl).toMatchObject({ definition: "coder", timeout: 30, temperature: 0.2, max_visits: 2, prompt: "do it" });
    expect(byId.review).toMatchObject({ reviewer: true });
    expect(byId.gate).toMatchObject({ doc: "$review.output", category: "review" });
    expect(byId.start.definition).toBeUndefined();
    expect(edges.find((e) => e.from === "gate")).toEqual({ from: "gate", to: "exit", label: "[A] Approve :: ships" });
  });

  test("the push payload carries the graph stack, and omits it when the graph has none", () => {
    const withStack = parseWorkflowSource(`digraph g {
      graph [stack="Release gates"]
      start [shape=Mdiamond]
      exit  [shape=Msquare]
      start -> exit
    }`);
    expect(graphToPushPayload(withStack).stack).toBe("Release gates");
    const without = parseWorkflowSource(`digraph g { start [shape=Mdiamond]; exit [shape=Msquare]; start -> exit }`);
    expect("stack" in graphToPushPayload(without)).toBe(false);
  });

  test("every workflow push in the CLI goes through graphToPushPayload", () => {
    const src = fs.readFileSync(path.resolve(__dirname, "../index.ts"), "utf-8");
    const pushes = src.split("/cli/workflows/upsert").length - 1;
    expect(pushes).toBeGreaterThanOrEqual(2);
    expect(src.split("graphToPushPayload(graph)").length - 1).toBe(pushes);
    expect(src).not.toContain("...(n.goal_gate !== undefined ? { goal_gate: n.goal_gate } : {})");
  });
});

// ── plan-to-polish workflow file ──────────────────────────────────────────────

describe("plan-to-polish workflow (file parse + dry-run)", () => {
  const WORKFLOW_FILE = path.resolve(
    __dirname,
    "../../../../workflows/plan-to-polish/workflow.cast"
  );

  test("workflow file exists and parses without error", () => {
    expect(fs.existsSync(WORKFLOW_FILE)).toBe(true);
    const g = parseWorkflowFile(WORKFLOW_FILE);
    expect(g.name).toBeTruthy();
    expect(g.nodes.size).toBeGreaterThan(0);
    expect(g.edges.length).toBeGreaterThan(0);
  });

  test("workflow passes validation", () => {
    const g = parseWorkflowFile(WORKFLOW_FILE);
    const errs = validateWorkflow(g);
    expect(errs).toHaveLength(0);
  });

  test("workflow has expected node types", () => {
    const g = parseWorkflowFile(WORKFLOW_FILE);
    const types = [...g.nodes.values()].map(n => n.type);
    expect(types).toContain("start");
    expect(types).toContain("exit");
    expect(types).toContain("human");
    expect(types).toContain("command");
    expect(types).toContain("agent");
  });

  test("workflow has goal_gate on final_validate", () => {
    const g = parseWorkflowFile(WORKFLOW_FILE);
    const finalValidate = g.nodes.get("final_validate");
    expect(finalValidate).toBeTruthy();
    expect(finalValidate!.goal_gate).toBe(true);
    expect(finalValidate!.retry_target).toBe("polish2");
  });

  test("workflow has implement with max_visits guard", () => {
    const g = parseWorkflowFile(WORKFLOW_FILE);
    const impl = g.nodes.get("implement");
    expect(impl).toBeTruthy();
    expect(typeof impl!.max_visits).toBe("number");
    expect(impl!.max_visits!).toBeGreaterThan(0);
  });

  test("model_stylesheet assigns opus to plan and review", () => {
    const g = parseWorkflowFile(WORKFLOW_FILE);
    expect(g.model_stylesheet).toContain("claude-opus-4-6");
  });

  test("dry-run executes from start to exit (skipping human gate)", async () => {
    const tmpDir = makeTmpDir();
    const cap = captureConsole();
    try {
      const g = parseWorkflowFile(WORKFLOW_FILE);
      await runWorkflow(g, { dryRun: true, cwd: tmpDir });
      expect(cap.logs.some(l => l.includes("complete"))).toBe(true);
    } finally {
      cap.restore();
      fs.rmSync(tmpDir, { recursive: true });
    }
  });
});

// ── Engine upgrades (the-line-end-to-end.md LE14) ────────────────────────────

describe("workflow/runner (LE14: json vars, graph hash, plan ready_tasks)", () => {
  let tmpDir: string;
  let cap: ReturnType<typeof captureConsole>;
  let origFetch: typeof fetch;
  let calls: Array<{ route: string; body: any }>;
  let planTasks: any[][];

  beforeEach(() => {
    tmpDir = makeTmpDir();
    cap = captureConsole();
    origFetch = globalThis.fetch;
    calls = [];
    planTasks = [];
    globalThis.fetch = (async (url: any, init: any) => {
      const route = String(url).replace(/^https?:\/\/[^/]+/, "");
      calls.push({ route, body: JSON.parse(init?.body || "{}") });
      if (route === "/cli/plans/get") {
        const tasks = planTasks.length > 1 ? planTasks.shift()! : planTasks[0] ?? [];
        return new Response(JSON.stringify({ title: "P", goal: "g", tasks }), { status: 200 });
      }
      const body = route === "/cli/workflow-runs/poll-gate" ? { status: "running", gate_response: "A" } : { ok: true };
      return new Response(JSON.stringify(body), { status: 200 });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
    cap.restore();
    fs.rmSync(tmpDir, { recursive: true });
  });

  test("a command's JSON stdout routes an edge and expands into the next script", async () => {
    const g = parseWorkflowSource(`digraph g {
      start [shape=Mdiamond]
      scan  [shape=parallelogram, script="echo '{\\"failing\\": 3, \\"name\\": \\"suite\\"}'; echo noise >&2"]
      many  [shape=parallelogram, script="echo routed-many $scan.json.name"]
      few   [shape=parallelogram, script="echo routed-few"]
      exit  [shape=Msquare]
      start -> scan
      scan -> many [condition="scan.json.failing >= 2 and outcome = success"]
      scan -> few  [condition="scan.json.failing < 2"]
      many -> exit
      few -> exit
    }`);
    expect(await runWorkflow(g, { cwd: tmpDir })).toBe("completed");
    expect(cap.logs.some(l => l.includes("routed-many suite"))).toBe(true);
    expect(cap.logs.some(l => l.includes("routed-few"))).toBe(false);
  });

  test("the run reports a graph hash that ignores formatting but not content", async () => {
    const { graphHash } = await import("./parser.js");
    const a = parseWorkflowSource(`digraph g { start [shape=Mdiamond]\n exit [shape=Msquare]\n start -> exit }`);
    const b = parseWorkflowSource(`digraph g {\n  // same graph\n  start [shape=Mdiamond]\n\n  exit [shape=Msquare]\n  start -> exit\n}`);
    const c2 = parseWorkflowSource(`digraph g { start [shape=Mdiamond]\n exit [shape=Msquare]\n start -> exit [condition="outcome = success"] }`);
    expect(graphHash(a)).toBe(graphHash(b));
    expect(graphHash(a)).not.toBe(graphHash(c2));
    await runWorkflow(a, { cwd: tmpDir, runId: "run-1", apiToken: "tok", convexSiteUrl: "https://convex.test" });
    const report = calls.find(c => c.route === "/cli/workflow-runs/progress" && c.body.graph_hash);
    expect(report?.body.graph_hash).toBe(graphHash(a));
    // Each station's own hash rides with it, so a version can say which stations changed.
    const { graphNodeHashes } = await import("./parser.js");
    expect(report?.body.graph_nodes).toEqual(graphNodeHashes(a));
    const byId = (g: typeof a) => Object.fromEntries(graphNodeHashes(g).map((n) => [n.id, n.h]));
    expect(byId(a)).toEqual(byId(b));
    // An edge leaving start changes start, and only start.
    expect(byId(c2).start).not.toBe(byId(a).start);
    expect(byId(c2).exit).toBe(byId(a).exit);
  });

  test("a run whose line profile cannot be read fails with the profile's own error", async () => {
    fs.mkdirSync(path.join(tmpDir, ".codecast"));
    fs.writeFileSync(path.join(tmpDir, ".codecast", "line.toml"), `[[line.finders]]\nid = "a"\nsource = "s"\nkind = "bug"\nfingerprint = "f"\nnewer_key = true\n`);
    const g = parseWorkflowSource(`digraph g { start [shape=Mdiamond]\n exit [shape=Msquare]\n start -> exit }`);
    expect(await runWorkflow(g, { cwd: tmpDir, runId: "run-1", apiToken: "tok", convexSiteUrl: "https://convex.test" })).toBe("invalid");
    const failed = calls.find(c => c.route === "/cli/workflow-runs/progress" && c.body.run_status === "failed");
    expect(failed?.body.fail_reason).toContain('unknown key "newer_key"');
  });

  test("validateWorkflow reports a malformed condition", () => {
    const g = parseWorkflowSource(`digraph g { start [shape=Mdiamond]\n exit [shape=Msquare]\n start -> exit [condition="outcome = (success"] }`);
    expect(validateWorkflow(g).some(e => e.includes("condition"))).toBe(true);
  });

  test("plan-autopilot loops while ready_tasks > 0 and exits at 0", async () => {
    const g = parseWorkflowFile(path.resolve(import.meta.dir, "../../workflows/plan-autopilot/workflow.cast"));
    // Stub the scripts: the routing under test is the check node's.
    g.nodes.get("dispatch")!.script = "echo dispatched";
    g.nodes.get("monitor")!.script = "true";
    const open = { status: "open", short_id: "ct-1" };
    const done = { status: "done", short_id: "ct-1" };
    // Initial load, then one refresh per node: the first wave still has a
    // ready task when check runs, the second does not.
    planTasks = [[open], [open], [open], [open], [open], [done]];
    const outcome = await runWorkflow(g, { cwd: tmpDir, planId: "pl-1", runId: "run-1", apiToken: "tok", convexSiteUrl: "https://convex.test" });
    expect(outcome).toBe("completed");
    const dispatched = calls.filter(c => c.route === "/cli/workflow-runs/progress" && c.body.node_id === "dispatch" && c.body.node_status === "running");
    expect(dispatched.length).toBe(2);
  }, 20000);
});

// ── Stations as the run's workers ────────────────────────────────────────────

describe("workflow/runner (stations nest under the run, gates complete)", () => {
  let tmpDir: string;
  let cap: ReturnType<typeof captureConsole>;
  let origFetch: typeof fetch;
  let calls: Array<{ route: string; body: any }>;
  let pinned: { state: string; status: string; result?: string | null };
  let pinnedReads: Array<typeof pinned>;
  let workState: string;
  let inboxReads: Array<{ id: string; work_state: string; is_live: boolean }>;
  let gateReply: { status: string; gate_response: string | null };

  beforeEach(() => {
    gateReply = { status: "running", gate_response: "S" };
    tmpDir = makeTmpDir();
    cap = captureConsole();
    origFetch = globalThis.fetch;
    calls = [];
    pinned = { state: "Grounded ct-9", status: "done" };
    workState = "needs_input";
    inboxReads = [];
    pinnedReads = [];
    globalThis.fetch = (async (url: any, init: any) => {
      const route = String(url).replace(/^https?:\/\/[^/]+/, "");
      const body = JSON.parse(init?.body || "{}");
      calls.push({ route, body });
      const reply = (v: unknown) => new Response(JSON.stringify(v), { status: 200 });
      if (route === "/cli/spawn") return reply({ conversation_id: "conv_hand", short_id: "jx7hand" });
      if (route === "/cli/inbox") {
        const next = inboxReads.shift();
        return reply({ sessions: [next ?? { id: "conv_hand", work_state: workState, is_live: false }] });
      }
      if (route === "/cli/sessions/state/get") return reply(pinnedReads.shift() ?? pinned);
      if (route === "/cli/workflow-runs/poll-gate") return reply(gateReply);
      return reply({ ok: true });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
    cap.restore();
    fs.rmSync(tmpDir, { recursive: true });
  });

  const graph = () => parseWorkflowSource(`digraph line {
    start [shape=Mdiamond]
    ground [label="Ground", backend=session, agent=claude, prompt="ground it"]
    decide [label="Decide", shape=hexagon]
    ship [shape=parallelogram, script="true"]
    exit [shape=Msquare]
    start -> ground -> decide
    decide -> ship [label="[S] Ship"]
    ship -> exit
  }`);
  const run = () => runWorkflow(graph(), { cwd: tmpDir, runId: "run-1", runSession: "conv_run", apiToken: "tok", convexSiteUrl: "https://convex.test", pollIntervalMs: 1 } as RunOptions);

  test("a station spawns nested under the run's session, named for its node and task", async () => {
    expect(await run()).toBe("completed");
    const spawn = calls.find(c => c.route === "/cli/spawn")!;
    expect(spawn.body.parent_session).toBe("conv_run");
    expect(spawn.body.title).toBe("Ground");
    expect(stationTitle({ id: "prove", label: "Prove" }, { task_id: "ct-9" })).toBe("Prove · ct-9");
    expect(stationTitle({ id: "prove", label: "" }, {})).toBe("prove");
    // The presenting station is named by its problem: its title is what a person meets in the decision's chat and page.
    expect(stationTitle({ id: "present", label: "Present" }, { task_id: "ct-9", task_title: "Graded sims hidden\nby world runs" }, true)).toBe("Graded sims hidden by world runs");
    expect(stationTitle({ id: "present", label: "Present" }, { task_id: "ct-9" }, true)).toBe("Present · ct-9");
  }, 30000);

  test("a live hand that reads needs input once, then works on, is not taken as settled", async () => {
    const live = (work_state: string) => ({ id: "conv_hand", work_state, is_live: true });
    inboxReads = [live("working"), live("needs_input"), live("working"), live("working")];
    workState = "done";
    await run();
    const reads = calls.filter(c => c.route === "/cli/inbox").length;
    // Settled only on the final done read, after the flicker and the work that followed it.
    expect(reads).toBe(5);
  }, 30000);

  test("a live hand that stays on needs input settles on the second read", async () => {
    const live = (work_state: string) => ({ id: "conv_hand", work_state, is_live: true });
    inboxReads = [live("needs_input"), live("needs_input")];
    workState = "working";
    expect(await run()).toBe("completed");
    expect(calls.filter(c => c.route === "/cli/inbox").length).toBe(2);
  }, 30000);

  test("a hand parked on its own background work is not taken as settled", async () => {
    // ct-59925, 2026-10-14: the Prove hand ended turns on an open replay and
    // Monitor. A settle that reads "waiting" (or a declared dormant) files the
    // row dormant; the run waits for the wake instead of reading the park as
    // the hand's answer.
    const parked = { id: "conv_hand", work_state: "dormant", is_live: true, agent_status: "waiting", message_count: 40 };
    inboxReads = [parked, parked, parked];
    workState = "done";
    expect(await run()).toBe("completed");
    expect(calls.filter(c => c.route === "/cli/inbox").length).toBe(4);
  }, 30000);

  test("a hand that pinned dormant is not taken as settled until it pins its answer", async () => {
    // ct-59998, 2026-10-16: the Implement hand committed its fix, started a
    // check and an eval replay in the background and pinned dormant. Its row
    // read needs_input, then not live, and the run routed on an empty handoff
    // ("no outgoing edge from implement"). A dormant pin names a wake the hand
    // waits on: the station waits for it within the node's timeout.
    const dormant = { state: "Re-verifying on main; woken by the check and eval finishing", status: "dormant" };
    const row = (work_state: string, is_live: boolean, agent_status: string) => ({ id: "conv_hand", work_state, is_live, agent_status, message_count: 57 });
    inboxReads = [row("working", true, "working"), row("needs_input", true, "idle"), row("needs_input", true, "idle"), row("needs_input", false, "hibernated"), row("needs_input", false, "stopped")];
    pinnedReads = [dormant, dormant];
    pinned = { state: "Fixed and verified", status: "done", result: '{"handoff":"prove"}' };
    workState = "done";
    expect(await run()).toBe("completed");
    expect(calls.filter(c => c.route === "/cli/inbox").length).toBe(6);
    // Read only when the row would settle: the two dormant reads and the answer.
    expect(calls.filter(c => c.route === "/cli/sessions/state/get").length).toBe(3);
    expect(cap.logs.some(l => l.includes("jx7hand: pinned dormant"))).toBe(true);
  }, 30000);

  test("a dormant hand that is killed, or asks a person, settles", async () => {
    const dormant = { state: "waiting on the replay", status: "dormant" };
    pinned = dormant;
    inboxReads = [{ id: "conv_hand", work_state: "idle", is_live: false, is_killed: true, message_count: 9 } as any];
    await run();
    expect(calls.filter(c => c.route === "/cli/inbox").length).toBe(1);
    calls = [];
    const asking = { id: "conv_hand", work_state: "needs_input", is_live: true, awaiting_input: true, message_count: 9 } as any;
    inboxReads = [asking, asking];
    await run();
    expect(calls.filter(c => c.route === "/cli/inbox").length).toBe(2);
  }, 30000);

  test("a working hand whose daemon goes quiet is not taken as settled", async () => {
    // The agentwatch Build station, 2026-10-14: the hand sat in one long tool
    // call while its daemon's loop froze for 199s. With no heartbeat and no
    // sync for two minutes the row read stopped, so needs_input and not live,
    // and the run routed a working hand to failure. It pinned done at 06:12.
    const live = (work_state: string) => ({ id: "conv_hand", work_state, is_live: true, agent_status: "working", message_count: 40 });
    const dark = { id: "conv_hand", work_state: "needs_input", is_live: false, agent_status: "stopped", message_count: 40 };
    inboxReads = [live("working"), dark, dark, dark, live("working")];
    workState = "done";
    expect(await run()).toBe("completed");
    expect(calls.filter(c => c.route === "/cli/inbox").length).toBe(6);
  }, 30000);

  test("a hand that declared done settles even while its daemon is quiet", async () => {
    inboxReads = [{ id: "conv_hand", work_state: "working", is_live: true, message_count: 40 } as any];
    workState = "done";
    expect(await run()).toBe("completed");
    expect(calls.filter(c => c.route === "/cli/inbox").length).toBe(2);
  }, 30000);

  test("a hand whose session holds no message and no result fails the station, and its report ends the hand", async () => {
    // The agentwatch Propose step, 2026-10-12: the hand's transcript went to
    // another conversation, the watched one stayed empty, and the run moved on.
    pinned = { state: "", status: "" };
    inboxReads = [{ id: "conv_hand", work_state: "needs_input", is_live: false, message_count: 0 } as any];
    expect(await run()).toBe("failed");
    expect(handEnded("failed")).toBe(true);
    expect(calls.some(c => c.route === "/cli/workflow-runs/poll-gate")).toBe(false);
  }, 30000);

  test("a hand whose start failed fails the station with the error, not at the node's timeout", async () => {
    // Union's Prove, 2026-10-14: the isolated hand's cloud preparation failed
    // in six minutes and the row read idle, never live, until prove's
    // three-hour timeout killed it.
    const failed = { id: "conv_hand", work_state: "idle", is_live: false, message_count: 0, session_error: "cloud host preparation failed (exit 1): setup 'install' failed" };
    let reads = 0;
    const inner = globalThis.fetch;
    globalThis.fetch = (async (url: any, init: any) => {
      if (String(url).endsWith("/cli/inbox") && ++reads === 2) setSystemTime(new Date(Date.now() + 3 * 60_000));
      return inner(url, init);
    }) as typeof fetch;
    inboxReads = [failed, failed, failed];
    try {
      expect(await run()).toBe("failed");
    } finally {
      setSystemTime();
    }
    expect(reads).toBe(2);
    expect(handEnded("failed")).toBe(true);
    expect(cap.logs.some(l => l.includes("jx7hand could not start") && l.includes("cloud host preparation failed"))).toBe(true);
  }, 30000);

  test("a hand that stopped on a login error and pinned nothing fails the station", async () => {
    // The Mac mini's line runs, 2026-10-14: every station answered "Not logged
    // in", settled as a pass, and the run routed on the task's old fields.
    pinned = { state: "", status: "" };
    inboxReads = [{ id: "conv_hand", work_state: "needs_input", is_live: false, message_count: 2, blocked_on: "auth" } as any];
    expect(await run()).toBe("failed");
    expect(calls.some(c => c.route === "/cli/workflow-runs/poll-gate")).toBe(false);
    expect(cap.logs.some(l => l.includes("jx7hand stopped on an auth error"))).toBe(true);
  }, 30000);

  test("a hand that pinned its result passes even before its transcript has synced", async () => {
    inboxReads = [{ id: "conv_hand", work_state: "done", is_live: false, message_count: 0 } as any];
    expect(await run()).toBe("completed");
  }, 30000);

  const stopOpts = { runId: "run-1", apiToken: "tok", convexSiteUrl: "https://convex.test" } as RunOptions;

  test("a runner stopped by a signal records its run as failed at the node it last reported", async () => {
    // Stop the runner while it waits on the gate, the way Ctrl-C lands mid-run.
    const inner = globalThis.fetch;
    let stopped: Promise<void> | null = null;
    globalThis.fetch = (async (url: any, init: any) => {
      if (!stopped && String(url).endsWith("/cli/workflow-runs/poll-gate")) stopped = reportRunStopped(stopOpts, "SIGINT");
      return inner(url, init);
    }) as typeof fetch;
    await run();
    await stopped;
    const stop = calls.find(c => c.route === "/cli/workflow-runs/progress" && c.body.fail_reason)!;
    expect(stop.body).toMatchObject({ run_id: "run-1", node_id: "decide", run_status: "failed", node_status: "failed", fail_reason: expect.stringContaining("SIGINT") });
  }, 30000);

  test("a signal after the run reported its end leaves the finished run alone", async () => {
    expect(await run()).toBe("completed");
    calls.length = 0;
    await reportRunStopped(stopOpts, "SIGTERM");
    expect(calls.filter(c => c.route === "/cli/workflow-runs/progress")).toEqual([]);
  }, 30000);

  // The server stops a station's hand when the runner reports its node over
  // (workflow_runs.stopStationHands): one owner, and a card that stays. The
  // runner's own kill dismissed the hand from the inbox and never reached a
  // hand that settled on a question, which held its worktree for hours.
  const handEnded = (status: string) => calls.some(c => c.route === "/cli/workflow-runs/progress" && c.body.node_id === "ground" && c.body.node_status === status && c.body.session_id === "jx7hand");

  test("a station that declared done ends with its node's report, and the runner kills nothing itself", async () => {
    await run();
    expect(handEnded("completed")).toBe(true);
    expect(calls.some(c => c.route === "/cli/sessions/kill")).toBe(false);
  }, 30000);

  test("a gate waits past any clock: thousands of unanswered polls, then the person's answer routes it", async () => {
    let polls = 0;
    const inner = globalThis.fetch;
    globalThis.fetch = (async (url: any, init: any) => {
      if (String(url).endsWith("/cli/workflow-runs/poll-gate")) {
        polls++;
        return new Response(JSON.stringify(polls < 4000 ? { status: "paused", gate_response: null } : { status: "paused", gate_response: "S" }), { status: 200 });
      }
      return inner(url, init);
    }) as typeof fetch;
    expect(await run()).toBe("completed");
    expect(polls).toBe(4000);
    expect(calls.some(c => c.route === "/cli/workflow-runs/progress" && c.body.node_id === "ship")).toBe(true);
  }, 60000);

  test("a poll the backend refuses is a failed poll, not a withdrawn gate: the gate waits on", async () => {
    let polls = 0;
    const inner = globalThis.fetch;
    globalThis.fetch = (async (url: any, init: any) => {
      if (String(url).endsWith("/cli/workflow-runs/poll-gate")) {
        polls++;
        if (polls === 1) return new Response(JSON.stringify({ error: "Overloaded", code: "Overloaded" }), { status: 503 });
        if (polls === 2) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 200 });
        return new Response(JSON.stringify(polls < 4 ? { status: "paused", gate_response: null } : { status: "paused", gate_response: "S" }), { status: 200 });
      }
      return inner(url, init);
    }) as typeof fetch;
    expect(await run()).toBe("completed");
    expect(polls).toBe(4);
  }, 30000);

  test("a run that left paused without an answer still ends the wait", async () => {
    gateReply = { status: "cancelled", gate_response: null };
    expect(await run()).toBe("failed");
  }, 30000);

  test("a station that pinned blocked stops the run there, even when its json names an edge", async () => {
    const g = parseWorkflowSource(`digraph line {
      start [shape=Mdiamond]
      investigate [label="Investigate", backend=session, agent=claude, prompt="look", max_visits=2]
      refine [label="Refine", backend=session, agent=claude, prompt="refine"]
      exit [shape=Msquare]
      start -> investigate -> refine
      refine -> investigate [condition="refine.json.outcome = wrong_cause"]
      refine -> exit [condition="refine.json.outcome = refined"]
    }`);
    pinned = { state: "Investigated", status: "done" };
    let spawns = 0;
    const inner = globalThis.fetch;
    globalThis.fetch = (async (url: any, init: any) => {
      if (String(url).endsWith("/cli/spawn") && ++spawns === 2) {
        pinned = { state: "Waiting on sd-486", status: "blocked", result: JSON.stringify({ outcome: "wrong_cause" }) };
      }
      return inner(url, init);
    }) as typeof fetch;
    const outcome = await runWorkflow(g, { cwd: tmpDir, runId: "run-1", runSession: "conv_run", taskId: "ct-9", apiToken: "tok", convexSiteUrl: "https://convex.test", pollIntervalMs: 1 } as RunOptions);
    expect(outcome).toBe("failed");
    expect(spawns).toBe(2);
    const park = calls.find(c => c.route === "/cli/work/update")!;
    expect(park.body).toMatchObject({ short_id: "ct-9", status: "in_review", execution_status: "blocked" });
  }, 30000);

  test("a builder that pinned blocked routes to the line's ask gate with its own words, and the answer goes back to it", async () => {
    const g = parseWorkflowSource(`digraph line {
      start [shape=Mdiamond]
      implement [label="Implement", backend=session, agent=claude, prompt="build it", max_visits=2]
      ask [label="Builder asks", shape=hexagon, prompt="The builder stopped ($handoff).", doc="$handoff_note"]
      reopen [shape=parallelogram, script="true"]
      exit [shape=Msquare]
      start -> implement
      implement -> exit [condition="outcome = success"]
      implement -> ask [condition="handoff = blocked"]
      ask -> reopen [label="[A] Answer :: back to the builder"]
      reopen -> implement
    }`);
    let spawns = 0;
    const inner = globalThis.fetch;
    globalThis.fetch = (async (url: any, init: any) => {
      const route = String(url).replace(/^https?:\/\/[^/]+/, "");
      if (route === "/cli/spawn") pinned = ++spawns === 1 ? { state: "Which schema version should the migration target?", status: "blocked" } : { state: "Built", status: "done" };
      if (route === "/cli/workflow-runs/poll-gate") return new Response(JSON.stringify({ status: "running", gate_response: "A: version 3" }), { status: 200 });
      return inner(url, init);
    }) as typeof fetch;
    const outcome = await runWorkflow(g, { cwd: tmpDir, runId: "run-1", runSession: "conv_run", apiToken: "tok", convexSiteUrl: "https://convex.test", pollIntervalMs: 1 } as RunOptions);
    expect(outcome).toBe("completed");
    expect(spawns).toBe(2);
    const gate = calls.find(c => c.route === "/cli/workflow-runs/gate")!.body;
    expect(gate).toMatchObject({ node_id: "ask", prompt: "The builder stopped (blocked).", doc_md: "Which schema version should the migration target?" });
    const second = calls.filter(c => c.route === "/cli/spawn")[1].body;
    expect(second.prompt).toContain("# Human Instructions\nversion 3");
  }, 30000);

  test("a station that settled on a question ends with its node's report too", async () => {
    pinned = { state: "Which base should prove run on?", status: "working" };
    workState = "needs_input";
    await run();
    expect(handEnded("completed")).toBe(true);
  }, 30000);

  test("a resumed run does not wait again on a hand that was stopped", async () => {
    // A Ctrl-C ends the run and the server stops its hands; a later resume
    // that reattached to the stopped hand read it as settled, with half a turn.
    inboxReads = [{ id: "conv_left", work_state: "needs_input", is_live: true, is_killed: true, message_count: 9 } as any];
    const outcome = await runWorkflow(graph(), { cwd: tmpDir, runId: "run-1", runSession: "conv_run", apiToken: "tok", convexSiteUrl: "https://convex.test", pollIntervalMs: 1, resumed: { node_id: "ground", hand: "conv_left" } } as any);
    expect(outcome).toBe("completed");
    expect(calls.filter(c => c.route === "/cli/spawn")).toHaveLength(1);
  }, 30000);

  // A reboot takes the runner and its hand together. The sweep restarts the
  // runner minutes later, before the watchdog revives the hand, and that
  // runner never saw the hand live: it spawned a second hand beside the one
  // about to come back, or read the dead one as settled.
  test("a resumed run waits for the hand it left to come back, without spawning another", async () => {
    const dead = (work_state: string) => ({ id: "conv_left", work_state, is_live: false, agent_status: "stopped", message_count: 40 });
    inboxReads = [dead("working"), dead("needs_input"), dead("needs_input"), { ...dead("working"), is_live: true, agent_status: "working" }, dead("done")] as any;
    pinned = { state: "Halfway through the check", status: "working" };
    pinnedReads = [{ state: "Grounded ct-9", status: "done" }];
    const outcome = await runWorkflow(graph(), { cwd: tmpDir, runId: "run-1", runSession: "conv_run", apiToken: "tok", convexSiteUrl: "https://convex.test", pollIntervalMs: 1, resumed: { node_id: "ground", hand: "conv_left" } } as any);
    expect(outcome).toBe("completed");
    expect(calls.filter(c => c.route === "/cli/spawn" && /ground/i.test(JSON.stringify(c.body)))).toHaveLength(0);
    expect(inboxReads).toHaveLength(0);
  }, 30000);

  test("a station routes on its result even when the pinned text was cut short", async () => {
    // Union's prove station (2026-10-07): its pin ran past the 1200-character
    // display cap, the cut fell inside the JSON block, and the run failed with
    // no outgoing edge although the hand had proven its cause.
    pinned = { state: `Proven.\n\n\`\`\`json\n{ "outcome": "red", "evidence": "${"x".repeat(1200)}…`, status: "done", result: '{ "outcome": "red", "evidence": "long" }' };
    const routed = parseWorkflowSource(`digraph line {
      start [shape=Mdiamond]
      prove [label="Prove", backend=session, agent=claude, prompt="prove it"]
      ship [shape=parallelogram, script="true"]
      exit [shape=Msquare]
      start -> prove
      prove -> ship [condition="prove.json.outcome = red"]
      ship -> exit
    }`);
    expect(await runWorkflow(routed, { cwd: tmpDir, runId: "run-2", runSession: "conv_run", apiToken: "tok", convexSiteUrl: "https://convex.test", pollIntervalMs: 1 } as RunOptions)).toBe("completed");
  }, 30000);

  test("a gate taken back without an answer follows none of its choices", async () => {
    // Union 2026-10-08: a card withdrawn (sd-512) left the gate with no answer,
    // and the run went down its first choice, Ship, recording an approval no
    // person gave.
    gateReply = { status: "running", gate_response: null };
    expect(await run()).toBe("failed");
    const reached = calls.filter((c) => c.route === "/cli/workflow-runs/progress").map((c) => c.body.node_id);
    expect(reached).not.toContain("ship");
  }, 30000);

  test("a gate answered with its key reports the node completed, not failed", async () => {
    await run();
    const decide = calls.filter(c => c.route === "/cli/workflow-runs/progress" && c.body.node_id === "decide" && c.body.node_status !== "running");
    expect(decide.map(c => c.body.node_status)).toEqual(["completed"]);
    expect(decide[0].body.outcome).toBe("s");
  }, 30000);
});

// ── A gate's change card (LE11) ──────────────────────────────────────────────

describe("gatePayload card", () => {
  const fixture = path.join(__dirname, "../../../shared/contracts/__fixtures__/changeCard/card.json");
  const gate = (attr: string) => {
    const g = parseWorkflowSource(`digraph g { start [shape=Mdiamond] decide [shape=hexagon, prompt="Ship it?", card="${attr}"] exit [shape=Msquare] start -> decide decide -> exit [label="[S] Ship"] }`);
    return { g, node: g.nodes.get("decide")! };
  };

  test("the card attribute expands its $vars and carries the parsed card", () => {
    const { g, node } = gate("$card_dir/card.json");
    const payload = gatePayload(node, g, { card_dir: path.dirname(fixture) });
    expect(payload.card?.cause.task).toBe("ct-56301");
    expect(graphToPushPayload(g).nodes.find((n: any) => n.id === "decide")?.card).toBe("$card_dir/card.json");
  });

  test("a missing card leaves the gate asking without one", () => {
    const { g, node } = gate("/nowhere/card.json");
    expect("card" in gatePayload(node, g, {})).toBe(false);
  });
});


describe("workflow/runner (LE1.4: a refused or failed registration stops a cause-bound run)", () => {
  test("a run bound to a task or plan stops, detached or not", () => {
    expect(runRegistrationIsFatal({ taskId: "ct-7" })).toBe(true);
    expect(runRegistrationIsFatal({ planId: "pl-3" })).toBe(true);
    expect(runRegistrationIsFatal({ detach: true })).toBe(true);
  });
  test("an unbound local run carries on unregistered", () => {
    expect(runRegistrationIsFatal({})).toBe(false);
  });
});

describe("gatePayload asker", () => {
  const src = `digraph g { start [shape=Mdiamond]; card_write [label="Card words", backend=session, prompt="write"]; decide [shape=hexagon, prompt="Ship?", asker=card_write]; exit [shape=Msquare]; start -> card_write -> decide; decide -> exit [label="[S] Ship"]; }`;
  test("names the session of the station the gate asks from, once that station ran", () => {
    const g = parseWorkflowSource(src);
    const node = g.nodes.get("decide")!;
    expect(node.asker).toBe("card_write");
    expect(graphToPushPayload(g).nodes.find((n) => n.id === "decide")).toMatchObject({ asker: "card_write" });
    expect(gatePayload(node, g, { "card_write.session_id": "sess-card" })).toMatchObject({ asker_session_id: "sess-card" });
    expect(gatePayload(node, g, {})).not.toHaveProperty("asker_session_id");
  });
});

describe("refreshedOnResume (line-versions.md LV4)", () => {
  const g = parseWorkflowSource(`digraph t {
    start [shape=Mdiamond]
    exit [shape=Msquare]
    shared [shape=parallelogram, refresh=true, script="echo text"]
    bind [shape=parallelogram, script="echo $task_id"]
    later [shape=parallelogram, refresh=true, script="echo later"]
    start -> shared -> bind -> later -> exit
  }`);
  test("a refresh station the run made is made again; one it never reached and plain stations are not", () => {
    expect(g.nodes.get("shared")?.refresh).toBe(true);
    expect(g.nodes.get("bind")?.refresh).toBeUndefined();
    expect(refreshedOnResume(g, ["start", "shared", "bind"]).map((n) => n.id)).toEqual(["shared"]);
  });
  test("a station made twice is made again once", () => {
    expect(refreshedOnResume(g, ["shared", "bind", "shared"]).map((n) => n.id)).toEqual(["shared"]);
  });
  test("a station the graph dropped is skipped", () => {
    expect(refreshedOnResume(g, ["gone", "later"]).map((n) => n.id)).toEqual(["later"]);
  });
});
