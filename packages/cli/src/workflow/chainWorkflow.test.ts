import { describe, expect, test } from "bun:test";
import type { AgentChainSpec, AgentDefinitionSpec } from "@codecast/shared/contracts";
import {
  compileChainWorkflow,
  compileParallelWorkflow,
  renderDotSource,
  resultPreview,
  unrecordedRun,
  workflowUpsertPayload,
} from "./chainWorkflow.js";
import { parseWorkflowSource, validateWorkflow } from "./parser.js";

const defs: Record<string, AgentDefinitionSpec> = {
  planner: { name: "planner", description: "", agent: "claude", model: "opus", effort: "high" },
  coder: { name: "coder", description: "", agent: "codex", isolated: true },
  reviewer: { name: "reviewer", description: "" },
};

const chain: AgentChainSpec = {
  name: "implement",
  description: "Plan, code, review",
  steps: [
    { agent: "planner", prompt: "Plan: {task}" },
    { agent: "coder", prompt: "Do: {previous}" },
    { agent: "reviewer", prompt: "Review: {previous}" },
  ],
};

describe("compileChainWorkflow (the-line.md L7)", () => {
  test("a 3 step chain is start, one box per step, exit, edges in order", () => {
    const g = compileChainWorkflow(chain, defs);
    expect(g.name).toBe("chain-implement");
    expect(g.goal).toBe("Plan, code, review");
    expect([...g.nodes.keys()]).toEqual(["start", "step-1", "step-2", "step-3", "exit"]);
    expect(g.nodes.get("start")).toMatchObject({ shape: "Mdiamond", type: "start" });
    expect(g.nodes.get("exit")).toMatchObject({ shape: "Msquare", type: "exit" });
    expect(g.nodes.get("step-1")).toEqual({
      id: "step-1", label: "planner", shape: "box", type: "agent",
      prompt: "Plan: {task}", definition: "planner", agent: "claude", model: "opus", reasoning_effort: "high",
    });
    expect(g.nodes.get("step-2")).toMatchObject({ label: "coder", definition: "coder", agent: "codex", isolated: true, prompt: "Do: {previous}" });
    expect(g.nodes.get("step-3")).toEqual({ id: "step-3", label: "reviewer", shape: "box", type: "agent", prompt: "Review: {previous}", definition: "reviewer" });
    expect(g.edges).toEqual([
      { from: "start", to: "step-1" },
      { from: "step-1", to: "step-2" },
      { from: "step-2", to: "step-3" },
      { from: "step-3", to: "exit" },
    ]);
    expect(validateWorkflow(g)).toEqual([]);
  });

  test("the DOT source parses back to the same nodes and edges", () => {
    const g = compileChainWorkflow(chain, defs);
    const parsed = parseWorkflowSource(renderDotSource(g));
    expect(parsed.name).toBe("chain-implement");
    expect([...parsed.nodes.keys()]).toEqual([...g.nodes.keys()]);
    expect(parsed.nodes.get("step-2")).toMatchObject({ type: "agent", definition: "coder", prompt: "Do: {previous}" });
    expect(parsed.edges.map((e) => [e.from, e.to])).toEqual(g.edges.map((e) => [e.from, e.to]));
  });

  test("the upsert payload carries the definition attribute and the slug", () => {
    const payload = workflowUpsertPayload(compileChainWorkflow(chain, defs)) as any;
    expect(payload.slug).toBe("chain-implement");
    expect(payload.nodes.map((n: any) => n.id)).toEqual(["start", "step-1", "step-2", "step-3", "exit"]);
    expect(payload.nodes[1]).toEqual({
      id: "step-1", label: "planner", shape: "box", type: "agent",
      prompt: "Plan: {task}", model: "opus", agent: "claude", reasoning_effort: "high", definition: "planner",
    });
    expect(payload.nodes[0]).toEqual({ id: "start", label: "Start", shape: "Mdiamond", type: "start" });
    expect(payload.edges).toHaveLength(4);
    expect(typeof payload.source).toBe("string");
  });
});

describe("compileParallelWorkflow (the-line.md L7, cast exec -j)", () => {
  test("two inputs become a component fanout, one node each, and a tripleoctagon fanin", () => {
    const g = compileParallelWorkflow(["write the tests\nmore", "write the docs"]);
    expect(g.name).toBe("exec-parallel");
    expect([...g.nodes.keys()]).toEqual(["start", "fanout", "input-1", "input-2", "fanin", "exit"]);
    expect(g.nodes.get("fanout")).toMatchObject({ shape: "component", type: "parallel_fanout" });
    expect(g.nodes.get("fanin")).toMatchObject({ shape: "tripleoctagon", type: "parallel_fanin" });
    expect(g.nodes.get("input-1")).toEqual({ id: "input-1", label: "write the tests", shape: "box", type: "agent", prompt: "write the tests\nmore" });
    expect(g.edges).toEqual([
      { from: "start", to: "fanout" },
      { from: "fanout", to: "input-1" },
      { from: "input-1", to: "fanin" },
      { from: "fanout", to: "input-2" },
      { from: "input-2", to: "fanin" },
      { from: "fanin", to: "exit" },
    ]);
    expect(validateWorkflow(g)).toEqual([]);
  });

  test("a definition names the workflow and every input node", () => {
    const g = compileParallelWorkflow(["a", "b"], defs.coder);
    expect(g.name).toBe("exec-parallel-coder");
    expect(g.nodes.get("input-2")).toMatchObject({ definition: "coder", agent: "codex" });
  });
});

describe("resultPreview", () => {
  test("is the trimmed head of the output, 800 chars at most, and undefined when empty", () => {
    expect(resultPreview("  hi \n")).toBe("hi");
    expect(resultPreview("x".repeat(1000))).toHaveLength(800);
    expect(resultPreview("   ")).toBeUndefined();
  });
});

describe("unrecordedRun", () => {
  test("notes once and accepts every report without posting", async () => {
    const notes: string[] = [];
    const run = unrecordedRun("not signed in", (l) => notes.push(l));
    await run.node("input-1", "running");
    await run.finish("exit", "completed");
    expect(run.runId).toBeUndefined();
    expect(notes).toEqual(["cast exec: run not recorded (not signed in)"]);
  });
});
