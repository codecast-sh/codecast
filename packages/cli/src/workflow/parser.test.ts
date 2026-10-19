import { describe, test, expect } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { parseWorkflowSource, parseWorkflowFile, validateWorkflow } from "./parser.js";

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
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cast-wf-test-"));
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
