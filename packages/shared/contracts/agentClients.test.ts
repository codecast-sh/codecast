import { describe, expect, it } from "bun:test";
import { fromConvexAgentType, toConvexAgentType } from "./agentClients";

// fromConvexAgentType is the single convex-spelling -> daemon-spelling translation.
// The daemon launch/resume mutations (users.startSession, conversations.switchSessionAgent,
// tasks.assignToAgent) delegate their daemon-agent decision to it — those sites are
// mutation-wrapped and have no plain-function seam, so this unit test is the guard.
// Two load-bearing cases: (1) "cursor" must pass through — a 2-branch ternary
// (codex/gemini else claude) used to collapse it to "claude", so cursor sessions
// resumed as `claude --resume`; (2) "opencode" is now first-class (phase 1) and
// must map to itself — resuming an opencode session as `claude --resume` would be
// wrong; "pi" is still widened-ahead with no descriptor, so it stays "claude" until
// phase 2. tsc can't catch a wrong-but-valid AgentClientId.
describe("fromConvexAgentType", () => {
  it("maps every current convex spelling to its daemon id", () => {
    expect(fromConvexAgentType("claude_code")).toBe("claude");
    expect(fromConvexAgentType("codex")).toBe("codex");
    expect(fromConvexAgentType("cursor")).toBe("cursor");
    expect(fromConvexAgentType("gemini")).toBe("gemini");
    expect(fromConvexAgentType("opencode")).toBe("opencode");
  });

  it("maps the not-yet-supported pi to claude (temporary widened-ahead fallback)", () => {
    expect(fromConvexAgentType("pi")).toBe("claude");
  });

  it("normalizes cowork, unknown, null and undefined to claude", () => {
    expect(fromConvexAgentType("cowork")).toBe("claude");
    expect(fromConvexAgentType("whatever")).toBe("claude");
    expect(fromConvexAgentType(null)).toBe("claude");
    expect(fromConvexAgentType(undefined)).toBe("claude");
  });
});

describe("toConvexAgentType", () => {
  it("round-trips each daemon id back to its convex spelling", () => {
    expect(toConvexAgentType("claude")).toBe("claude_code");
    expect(toConvexAgentType("codex")).toBe("codex");
    expect(toConvexAgentType("cursor")).toBe("cursor");
    expect(toConvexAgentType("gemini")).toBe("gemini");
    expect(toConvexAgentType("opencode")).toBe("opencode");
  });
});
