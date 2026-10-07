import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { parseWorkflowSource, parseWorkflowFile, validateWorkflow } from "./parser.js";
import { runWorkflow, reportRunStopped, graphToPushPayload, parseGateEdgeLabel, gatePayload, handTimeoutMs, stationTitle, runRegistrationIsFatal, type RunOptions } from "./runner.js";

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

// ── Parser tests ──────────────────────────────────────────────────────────────

describe("workflow/parser", () => {
  test("parses minimal start→exit workflow", () => {
    const src = `digraph test {
      start [shape=Mdiamond]
      exit  [shape=Msquare]
      start -> exit
    }`;
    const g = parseWorkflowSource(src);
    expect(g.name).toBe("test");
    expect(g.nodes.size).toBe(2);
    expect(g.nodes.get("start")!.type).toBe("start");
    expect(g.nodes.get("exit")!.type).toBe("exit");
    expect(g.edges).toHaveLength(1);
    expect(g.edges[0]).toMatchObject({ from: "start", to: "exit" });
  });

  test("parses graph-level goal attribute", () => {
    const src = `digraph g {
      graph [goal="build something cool"]
      start [shape=Mdiamond]
      exit  [shape=Msquare]
      start -> exit
    }`;
    const g = parseWorkflowSource(src);
    expect(g.goal).toBe("build something cool");
  });

  test("parses model_stylesheet", () => {
    const src = `digraph g {
      graph [model_stylesheet="* { model: claude-sonnet-4-6; }"]
      start [shape=Mdiamond]
      exit  [shape=Msquare]
      start -> exit
    }`;
    const g = parseWorkflowSource(src);
    expect(g.model_stylesheet).toContain("claude-sonnet-4-6");
  });

  test("parses agent node with prompt", () => {
    const src = `digraph g {
      start [shape=Mdiamond]
      impl  [label="Implement", prompt="do the thing"]
      exit  [shape=Msquare]
      start -> impl -> exit
    }`;
    const g = parseWorkflowSource(src);
    const impl = g.nodes.get("impl")!;
    expect(impl.type).toBe("agent");
    expect(impl.label).toBe("Implement");
    expect(impl.prompt).toBe("do the thing");
  });

  test("parses command node with script", () => {
    const src = `digraph g {
      start [shape=Mdiamond]
      verify [shape=parallelogram, script="echo ok"]
      exit  [shape=Msquare]
      start -> verify -> exit
    }`;
    const g = parseWorkflowSource(src);
    const verify = g.nodes.get("verify")!;
    expect(verify.type).toBe("command");
    expect(verify.script).toBe("echo ok");
  });

  test("parses human gate node", () => {
    const src = `digraph g {
      start  [shape=Mdiamond]
      review [shape=hexagon, label="Review"]
      exit   [shape=Msquare]
      start -> review
      review -> exit [label="[A] Approve"]
    }`;
    const g = parseWorkflowSource(src);
    expect(g.nodes.get("review")!.type).toBe("human");
    expect(g.edges[1].label).toBe("[A] Approve");
  });

  test("parses conditional edges", () => {
    const src = `digraph g {
      start  [shape=Mdiamond]
      verify [shape=parallelogram, script="exit 0"]
      done   [shape=Msquare]
      retry  [label="Retry"]
      start -> verify
      verify -> done  [condition="outcome = success"]
      verify -> retry [condition="outcome = failure"]
      retry  -> done
    }`;
    const g = parseWorkflowSource(src);
    const toSuccess = g.edges.find(e => e.from === "verify" && e.to === "done");
    const toRetry = g.edges.find(e => e.from === "verify" && e.to === "retry");
    expect(toSuccess?.condition).toBe("outcome = success");
    expect(toRetry?.condition).toBe("outcome = failure");
  });

  test("parses max_visits and goal_gate attributes", () => {
    const src = `digraph g {
      start  [shape=Mdiamond]
      impl   [max_visits=5, goal_gate=true]
      exit   [shape=Msquare]
      start -> impl -> exit
    }`;
    const g = parseWorkflowSource(src);
    const impl = g.nodes.get("impl")!;
    expect(impl.max_visits).toBe(5);
    expect(impl.goal_gate).toBe(true);
  });

  test("auto-creates placeholder nodes referenced only in edges", () => {
    const src = `digraph g {
      start [shape=Mdiamond]
      exit  [shape=Msquare]
      start -> middle -> exit
    }`;
    const g = parseWorkflowSource(src);
    expect(g.nodes.has("middle")).toBe(true);
    expect(g.nodes.get("middle")!.type).toBe("agent");
  });

  test("resolves @file reference in prompt", () => {
    const tmpDir = makeTmpDir();
    try {
      fs.writeFileSync(path.join(tmpDir, "myprompt.md"), "do the task");
      const src = `digraph g {
        start [shape=Mdiamond]
        impl  [prompt="@myprompt.md"]
        exit  [shape=Msquare]
        start -> impl -> exit
      }`;
      const g = parseWorkflowSource(src, tmpDir);
      expect(g.nodes.get("impl")!.prompt).toBe("do the task");
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });
});

// ── Validation tests ──────────────────────────────────────────────────────────

describe("workflow/validateWorkflow", () => {
  test("returns no errors for valid workflow", () => {
    const g = parseWorkflowSource(`digraph g {
      start [shape=Mdiamond]
      exit  [shape=Msquare]
      start -> exit
    }`);
    expect(validateWorkflow(g)).toHaveLength(0);
  });

  test("errors on missing start node", () => {
    const g = parseWorkflowSource(`digraph g {
      exit [shape=Msquare]
    }`);
    const errs = validateWorkflow(g);
    expect(errs.some(e => e.includes("start"))).toBe(true);
  });

  test("errors on missing exit node", () => {
    const g = parseWorkflowSource(`digraph g {
      start [shape=Mdiamond]
    }`);
    const errs = validateWorkflow(g);
    expect(errs.some(e => e.includes("exit") || e.includes("Msquare"))).toBe(true);
  });

  test("errors on command node with no script", () => {
    const g = parseWorkflowSource(`digraph g {
      start  [shape=Mdiamond]
      broken [shape=parallelogram]
      exit   [shape=Msquare]
      start -> broken -> exit
    }`);
    const errs = validateWorkflow(g);
    expect(errs.some(e => e.includes("broken") && e.includes("script"))).toBe(true);
  });

  test("errors on edge referencing unknown node", () => {
    const src = `digraph g {
      start [shape=Mdiamond]
      exit  [shape=Msquare]
    }`;
    const g = parseWorkflowSource(src);
    // Manually inject a bad edge
    g.edges.push({ from: "start", to: "ghost" });
    const errs = validateWorkflow(g);
    expect(errs.some(e => e.includes("ghost"))).toBe(true);
  });
});

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
    // Reading the task and the plan is fine; nothing may write to either.
    expect(calls.map((c) => c.route).filter((r) => !r.endsWith("/get"))).toEqual([]);
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
  let pinned: { state: string; status: string };
  let workState: string;
  let inboxReads: Array<{ id: string; work_state: string; is_live: boolean }>;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    cap = captureConsole();
    origFetch = globalThis.fetch;
    calls = [];
    pinned = { state: "Grounded ct-9", status: "done" };
    workState = "needs_input";
    inboxReads = [];
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
      if (route === "/cli/sessions/state/get") return reply(pinned);
      if (route === "/cli/workflow-runs/poll-gate") return reply({ status: "running", gate_response: "S" });
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

  test("a station that declared done is retired, so a later settle cannot file it under needs input", async () => {
    await run();
    expect(calls.filter(c => c.route === "/cli/sessions/kill").map(c => c.body.session)).toEqual(["conv_hand"]);
  }, 30000);

  test("a station that ended on a question is left standing for the person", async () => {
    pinned = { state: "Which base should prove run on?", status: "working" };
    await run();
    expect(calls.some(c => c.route === "/cli/sessions/kill")).toBe(false);
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
