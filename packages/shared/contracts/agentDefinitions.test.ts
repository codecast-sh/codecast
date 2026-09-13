import { describe, expect, test } from "bun:test";
import {
  renderChainStepPrompt,
  resolveAgentLaunch,
  splitModelEffortSuffix,
  validateAgentChain,
  validateAgentDefinition,
  type AgentDefinitionSpec,
} from "./agentDefinitions";

const reviewer: AgentDefinitionSpec = {
  name: "reviewer",
  description: "Reviews a diff",
  agent: "claude",
  model: "sonnet",
  effort: "high",
  tools: ["Read", "Grep"],
  disallowed_tools: ["Write"],
  system_prompt: "You review.",
  mode: "propose",
};

describe("validateAgentDefinition", () => {
  test("accepts a launchable definition", () => {
    expect(validateAgentDefinition(reviewer)).toEqual([]);
  });
  test("rejects a bad name, a foreign model and a foreign effort", () => {
    const problems = validateAgentDefinition({ ...reviewer, name: "Reviewer!", model: "gpt-5.5", effort: "ultra" });
    expect(problems.some((p) => p.includes("name must be"))).toBe(true);
    expect(problems.some((p) => p.includes('model "gpt-5.5"'))).toBe(true);
    expect(problems.some((p) => p.includes('effort "ultra"'))).toBe(true);
  });
  test("a definition without a client cannot be checked against a model list", () => {
    expect(validateAgentDefinition({ name: "x", description: "y", model: "anything" })).toEqual([]);
  });
});

describe("resolveAgentLaunch", () => {
  test("explicit flags beat the definition, the definition beats the fallback", () => {
    const r = resolveAgentLaunch(reviewer, { model: "opus" }, "codex");
    expect(r.agent).toBe("claude");
    expect(r.model).toBe("opus");
    expect(r.effort).toBe("high");
    expect(r.appendSystemPrompt).toBe("You review.");
    expect(r.mode).toBe("propose");
    expect(r.dropped).toEqual([]);
  });
  test("forcing a client the definition's model does not fit drops the model and says so", () => {
    const r = resolveAgentLaunch(reviewer, { agent: "codex" }, "claude");
    expect(r.agent).toBe("codex");
    expect(r.model).toBeUndefined();
    expect(r.dropped[0]).toContain("model sonnet");
    expect(r.effort).toBe("high");
  });
  test("an effort the client has no flag for is dropped", () => {
    const r = resolveAgentLaunch({ ...reviewer, agent: "opencode", model: undefined }, {}, "claude");
    expect(r.effort).toBeUndefined();
    expect(r.dropped[0]).toContain("no effort flag");
  });
  test("replace mode moves the prompt to systemPrompt", () => {
    const r = resolveAgentLaunch({ ...reviewer, prompt_mode: "replace" }, {}, "claude");
    expect(r.systemPrompt).toBe("You review.");
    expect(r.appendSystemPrompt).toBeUndefined();
  });
  test("no definition is the surface default", () => {
    const r = resolveAgentLaunch(undefined, {}, "pi");
    expect(r).toMatchObject({ agent: "pi", mode: "apply", isolated: false, dropped: [] });
  });
});

describe("splitModelEffortSuffix", () => {
  test("pi's model:effort form splits when the suffix is a real level", () => {
    expect(splitModelEffortSuffix("claude-sonnet-4-5:high", "claude")).toEqual({ model: "claude-sonnet-4-5", effort: "high" });
    expect(splitModelEffortSuffix("anthropic/claude:xhigh", "pi")).toEqual({ model: "anthropic/claude", effort: "xhigh" });
  });
  test("a colon that is not an effort stays in the model", () => {
    expect(splitModelEffortSuffix("provider:model", "claude")).toEqual({ model: "provider:model" });
    expect(splitModelEffortSuffix("opus", "claude")).toEqual({ model: "opus" });
  });
});

describe("renderChainStepPrompt", () => {
  test("fills both placeholders", () => {
    expect(renderChainStepPrompt("Do {task} with {previous}", { task: "T", previous: "P" })).toBe("Do T with P");
  });
  test("appends the previous output when the template never names it", () => {
    expect(renderChainStepPrompt("Do {task}", { task: "T", previous: "P" })).toBe("Do T\n\n## Previous step\n\nP");
  });
  test("the first step has no previous output and the placeholder vanishes", () => {
    expect(renderChainStepPrompt("Do {task} {previous}", { task: "T" })).toBe("Do T ");
  });
});

describe("validateAgentChain", () => {
  test("flags unknown definitions and empty prompts", () => {
    const problems = validateAgentChain(
      { name: "impl", description: "d", steps: [{ agent: "scout", prompt: "{task}" }, { agent: "ghost", prompt: " " }] },
      new Set(["scout"]),
    );
    expect(problems).toEqual(['step 2: no definition named "ghost"', "step 2: prompt is required"]);
  });
});
