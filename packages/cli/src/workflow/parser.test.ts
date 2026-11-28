import { describe, test, expect } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { parseWorkflowSource, parseWorkflowFile, validateWorkflow } from "./parser.js";
import { graphNodesPayload } from "./graphPayload.js";

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

  test("fold=true marks a station as bookkeeping; it is otherwise a station like any other", () => {
    const g = parseWorkflowSource(`digraph g {
      start [shape=Mdiamond]
      verdicts [shape=parallelogram, script="echo ok", fold=true]
      merge [shape=parallelogram, script="echo ok"]
      exit [shape=Msquare]
      start -> verdicts -> merge -> exit
    }`);
    expect(g.nodes.get("verdicts")).toMatchObject({ type: "command", script: "echo ok", fold: true });
    expect(g.nodes.get("merge")!.fold).toBeUndefined();
  });

  test("asks_if says what makes a run ask, on a gate and on the gates of a segment it names", () => {
    const plain = parseWorkflowSource(`digraph g {
      start [shape=Mdiamond]
      ask [shape=hexagon, label="Ask", asks_if="it edits CI"]
      exit [shape=Msquare]
      start -> ask -> exit
    }`);
    expect(plain.nodes.get("ask")!.asks_if).toBe("it edits CI");
    const seg = parseWorkflowSource(`digraph g {
      start [shape=Mdiamond]
      decide [flow="decide", asks_if="it edits CI"]
      exit [shape=Msquare]
      start -> decide -> exit
    }`);
    const gates = [...seg.nodes.values()].filter((n) => n.type === "human");
    expect(gates.length).toBeGreaterThan(0);
    expect(gates.every((n) => n.asks_if === "it edits CI")).toBe(true);
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

  test("an arrow written without spaces is still an edge, and a dash stays part of a name", () => {
    const g = parseWorkflowSource(`digraph g {
      start [shape=Mdiamond]
      fix-check [prompt="fix it"]
      exit  [shape=Msquare]
      start->fix-check->exit
    }`);
    expect(g.edges.map(e => `${e.from}>${e.to}`)).toEqual(["start>fix-check", "fix-check>exit"]);
    expect(g.nodes.has("fix-check")).toBe(true);
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

describe("workflow/parser resume=", () => {
  const SEG = `digraph land {
    graph [kind="segment"]
    start [shape=Mdiamond]
    pr [shape=parallelogram, script="true"]
    wait [shape=parallelogram, script="true"]
    done [shape=Msquare]
    red [shape=Msquare, shared=true, resume="pr", stop="main stayed red"]
    start -> pr
    pr -> wait
    wait -> done [condition="outcome = success"]
    wait -> red
  }`;
  const compose = (edges: string) => parseWorkflowSource(`digraph c {
    start [shape=Mdiamond]
    land [flow="land"]
    exit [shape=Msquare]
    stopped [shape=Msquare, stop="$stop_reason"]
    start -> land
    ${edges}
  }`, undefined, { resolveFlow: (slug) => (slug === "land" ? { src: SEG } : null) });

  test("a segment's stop names its own station, renamed with it, on the exit and on the step a routed stop leaves by", () => {
    const kept = compose(`land -> exit`);
    expect(kept.nodes.get("land__red")?.resume).toBe("land__pr");
    expect(validateWorkflow(kept)).toEqual([]);
    const routed = compose(`land -> exit [condition="outcome = success"]\n    land -> stopped [condition="outcome = failure"]`);
    expect(routed.nodes.get("land__red")).toMatchObject({ segment_exit: "stop", shared: true, resume: "land__pr" });
    expect(validateWorkflow(routed)).toEqual([]);
  });

  test("shared= names the breakage, rides onto a routed stop's step, and is spelled in lowercase, digits and _", () => {
    const named = parseWorkflowSource(`digraph c {
      start [shape=Mdiamond]
      land [flow="land"]
      exit [shape=Msquare]
      stopped [shape=Msquare, stop="$stop_reason"]
      start -> land
      land -> exit [condition="outcome = success"]
      land -> stopped [condition="outcome = failure"]
    }`, undefined, { resolveFlow: (slug) => (slug === "land" ? { src: SEG.replace("shared=true", 'shared="main_red"') } : null) });
    expect(named.nodes.get("land__red")?.shared).toBe("main_red");
    expect(graphNodesPayload(named).find((n) => n.id === "land__red")?.shared).toBe("main_red");
    expect(validateWorkflow(named)).toEqual([]);
    const g = (shared: string) => parseWorkflowSource(`digraph g {
      start [shape=Mdiamond]
      x [shape=Msquare, shared=${shared}, stop="red"]
      start -> x
    }`);
    expect(g("true").nodes.get("x")?.shared).toBe(true);
    expect(g("false").nodes.get("x")?.shared).toBeUndefined();
    expect(validateWorkflow(g(`"Main Red"`))).toEqual([`x [shared="Main Red"]: name the breakage in lowercase letters, digits and _ (shared="main_red"), or shared=true for the exit's own id`]);
  });

  test("names a station of the flow, on a stop exit", () => {
    const g = (attrs: string) => parseWorkflowSource(`digraph g {
      start [shape=Mdiamond]
      s [shape=parallelogram, script="true"]
      x [shape=Msquare, ${attrs}]
      exit [shape=Msquare]
      start -> s
      s -> exit [condition="outcome = success"]
      s -> x
    }`);
    expect(validateWorkflow(g(`resume="s", stop="red"`))).toEqual([]);
    expect(validateWorkflow(g(`resume="nowhere", stop="red"`))).toEqual([`x [resume="nowhere"] names no station of this flow`]);
    expect(validateWorkflow(g(`resume="s"`))).toEqual([`x [resume="s"]: only a stop exit (stop=) says where a run stopped there resumes`]);
  });
});
