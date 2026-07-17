import { describe, expect, it } from "bun:test";
import { fromConvexAgentType } from "./agentClients";

// fromConvexAgentType is the single convex-agent_type -> daemon-client-id map
// every resume/move mutation must use. The bug it closes: a 2-branch ternary
// (codex/gemini else claude) silently collapsed "cursor" — a real schema value —
// to "claude", so cursor sessions resumed as `claude --resume`. Only
// codex/cursor/gemini pass through; everything else, including the future/legacy
// spellings, is claude.

describe("fromConvexAgentType", () => {
  it("passes cursor through (the collapse this fixes)", () => {
    expect(fromConvexAgentType("cursor")).toBe("cursor");
  });

  it("passes codex and gemini through", () => {
    expect(fromConvexAgentType("codex")).toBe("codex");
    expect(fromConvexAgentType("gemini")).toBe("gemini");
  });

  it("maps claude_code and cowork to claude", () => {
    expect(fromConvexAgentType("claude_code")).toBe("claude");
    expect(fromConvexAgentType("cowork")).toBe("claude");
  });

  it("maps an unknown/future spelling to claude", () => {
    expect(fromConvexAgentType("opencode")).toBe("claude");
  });

  it("maps missing agent_type to claude", () => {
    expect(fromConvexAgentType(undefined)).toBe("claude");
    expect(fromConvexAgentType(null)).toBe("claude");
  });
});
