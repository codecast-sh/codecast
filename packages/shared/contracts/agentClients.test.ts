import { describe, expect, it } from "bun:test";
import { fromConvexAgentType, toConvexAgentType } from "./agentClients";

// fromConvexAgentType is the single convex-spelling -> daemon-spelling translation.
// The daemon launch/resume mutations (users.startSession, conversations.switchSessionAgent,
// tasks.assignToAgent) delegate their daemon-agent decision to it — those sites are
// mutation-wrapped and have no plain-function seam, so this unit test is the guard.
// Two load-bearing cases: (1) "cursor" must pass through — a 2-branch ternary
// (codex/gemini else claude) used to collapse it to "claude", so cursor sessions
// resumed as `claude --resume`; (2) opencode/pi are valid ConvexAgentType values
// with no descriptor yet (plan phases 1-2), so they must resolve to "claude", NOT
// fall through to some other client. tsc can't catch a wrong-but-valid AgentClientId.
describe("fromConvexAgentType", () => {
  it("maps every current convex spelling to its daemon id", () => {
    expect(fromConvexAgentType("claude_code")).toBe("claude");
    expect(fromConvexAgentType("codex")).toBe("codex");
    expect(fromConvexAgentType("cursor")).toBe("cursor");
    expect(fromConvexAgentType("gemini")).toBe("gemini");
  });

  it("maps the not-yet-supported opencode/pi to claude (temporary phase-0 fallback)", () => {
    expect(fromConvexAgentType("opencode")).toBe("claude");
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
  });
});
