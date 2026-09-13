import { describe, expect, test } from "bun:test";
import {
  isAgentChainFile,
  parseAgentChainFile,
  parseAgentDefinitionFile,
  serializeAgentChainFile,
  serializeAgentDefinitionFile,
} from "./index";

const CLAUDE_CODE_FILE = `---
name: reviewer
description: Reviews a completed task's implementation for correctness.
model: sonnet
disallowedTools: Write, Edit, NotebookEdit
---

You are a reviewer agent. Return a verdict.
`;

const PI_FILE = `---
name: scout
description: Fast codebase recon
tools: read, grep, find, ls, bash
model: claude-haiku-4-5:high
agent: pi
---
You are a scout.
`;

describe("parseAgentDefinitionFile", () => {
  test("reads a Claude Code agents/*.md file", () => {
    const def = parseAgentDefinitionFile(CLAUDE_CODE_FILE);
    expect(def).toEqual({
      name: "reviewer",
      description: "Reviews a completed task's implementation for correctness.",
      model: "sonnet",
      disallowed_tools: ["Write", "Edit", "NotebookEdit"],
      system_prompt: "You are a reviewer agent. Return a verdict.",
    });
  });
  test("reads a pi agent file, splitting model:effort and the tools list", () => {
    const def = parseAgentDefinitionFile(PI_FILE);
    expect(def.agent).toBe("pi");
    expect(def.model).toBe("claude-haiku-4-5");
    expect(def.effort).toBe("high");
    expect(def.tools).toEqual(["read", "grep", "find", "ls", "bash"]);
    expect(def.system_prompt).toBe("You are a scout.");
  });
  test("falls back to the file stem for the name and maps isolation and safe", () => {
    const def = parseAgentDefinitionFile("---\ndescription: d\nisolation: worktree\nmode: safe\n---\nbody", "worker");
    expect(def.name).toBe("worker");
    expect(def.isolated).toBe(true);
    expect(def.mode).toBe("propose");
  });
  test("a file with no frontmatter is all prompt", () => {
    const def = parseAgentDefinitionFile("Just a prompt.", "plain");
    expect(def).toEqual({ name: "plain", description: "", system_prompt: "Just a prompt." });
  });
});

describe("serializeAgentDefinitionFile", () => {
  test("round trips through the parser", () => {
    const def = {
      name: "critic",
      description: "Finds bugs: the last sweep",
      agent: "codex" as const,
      model: "gpt-5.5",
      effort: "high",
      tools: ["Read", "Grep"],
      disallowed_tools: ["Write"],
      system_prompt: "Be thorough.\n\nList every issue.",
      prompt_mode: "replace" as const,
      mode: "propose" as const,
      isolated: true,
    };
    const text = serializeAgentDefinitionFile(def);
    expect(text.startsWith("---\nname: critic\n")).toBe(true);
    expect(parseAgentDefinitionFile(text)).toEqual(def);
  });
});

const CHAIN_FILE = `---
name: implement
description: scout, plan, build
---

## scout

Find the code relevant to: {task}

## planner

Plan: {task}

{previous}

## worker

Do it.
`;

describe("chain files", () => {
  test("parses one step per ## section", () => {
    const chain = parseAgentChainFile(CHAIN_FILE);
    expect(chain.name).toBe("implement");
    expect(chain.steps).toEqual([
      { agent: "scout", prompt: "Find the code relevant to: {task}" },
      { agent: "planner", prompt: "Plan: {task}\n\n{previous}" },
      { agent: "worker", prompt: "Do it." },
    ]);
  });
  test("is recognized as a chain, and a definition file is not", () => {
    expect(isAgentChainFile(CHAIN_FILE)).toBe(true);
    expect(isAgentChainFile(CLAUDE_CODE_FILE)).toBe(false);
  });
  test("round trips", () => {
    const chain = parseAgentChainFile(CHAIN_FILE);
    expect(parseAgentChainFile(serializeAgentChainFile(chain))).toEqual(chain);
  });
});
