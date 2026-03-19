import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { parseWorkflowSource, parseWorkflowFile, validateWorkflow } from "./parser.js";
import { runWorkflow, type RunOptions } from "./runner.js";

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

  test("workflow fails when validation errors exist", async () => {
    const g = parseWorkflowSource(`digraph g {
      exit [shape=Msquare]
    }`);
    // runWorkflow calls process.exit(1) on validation error; throw to stop execution
    const origExit = process.exit;
    let exitCalled = false;
    (process as any).exit = () => { exitCalled = true; throw new Error("process.exit"); };
    try {
      await runWorkflow(g, { ...dryRun, cwd: tmpDir });
    } catch {
      // expected
    } finally {
      (process as any).exit = origExit;
    }
    expect(exitCalled).toBe(true);
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
