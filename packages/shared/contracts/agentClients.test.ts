import { describe, expect, it } from "bun:test";
import {
  AGENT_CLIENTS,
  agentSupportsExecutionTransport,
  fromConvexAgentType,
  InvalidExecutionAgentTypeError,
  parseExecutionAgentClientId,
  toConvexAgentType,
} from "./agentClients";

// fromConvexAgentType is the single convex-spelling -> daemon-spelling translation.
// The daemon launch/resume mutations (users.startSession, conversations.switchSessionAgent,
// tasks.assignToAgent) delegate their daemon-agent decision to it — those sites are
// mutation-wrapped and have no plain-function seam, so this unit test is the guard.
// Load-bearing cases: (1) "cursor" must pass through — a 2-branch ternary
// (codex/gemini else claude) used to collapse it to "claude", so cursor sessions
// resumed as `claude --resume`; (2) "opencode" (phase 1) and "pi" (phase 2) are
// first-class and must map to themselves — resuming either as `claude --resume`
// would be wrong. tsc can't catch a wrong-but-valid AgentClientId.
describe("fromConvexAgentType", () => {
  it("maps every current convex spelling to its daemon id", () => {
    expect(fromConvexAgentType("claude_code")).toBe("claude");
    expect(fromConvexAgentType("codex")).toBe("codex");
    expect(fromConvexAgentType("cursor")).toBe("cursor");
    expect(fromConvexAgentType("gemini")).toBe("gemini");
    expect(fromConvexAgentType("opencode")).toBe("opencode");
    expect(fromConvexAgentType("pi")).toBe("pi");
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
    expect(toConvexAgentType("pi")).toBe("pi");
  });
});

describe("parseExecutionAgentClientId", () => {
  it("accepts every canonical execution id and explicit compatibility alias", () => {
    expect(parseExecutionAgentClientId("claude")).toBe("claude");
    expect(parseExecutionAgentClientId("claude_code")).toBe("claude");
    expect(parseExecutionAgentClientId("cowork")).toBe("claude");
    expect(parseExecutionAgentClientId("codex")).toBe("codex");
    expect(parseExecutionAgentClientId("cursor")).toBe("cursor");
    expect(parseExecutionAgentClientId("gemini")).toBe("gemini");
    expect(parseExecutionAgentClientId("opencode")).toBe("opencode");
    expect(parseExecutionAgentClientId("pi")).toBe("pi");
  });

  it("fails closed for unknown, nullish, and non-string execution values", () => {
    for (const value of ["whatever", "", null, undefined, 1, {}]) {
      expect(() => parseExecutionAgentClientId(value)).toThrow(InvalidExecutionAgentTypeError);
    }
  });

  it("does not change the permissive legacy/display parser", () => {
    expect(fromConvexAgentType("whatever")).toBe("claude");
    expect(fromConvexAgentType(null)).toBe("claude");
  });
});

describe("fenced execution transports", () => {
  it("declares the exact implemented transport set for every agent family", () => {
    expect(AGENT_CLIENTS.claude.executionTransports).toEqual(["tmux"]);
    expect(AGENT_CLIENTS.codex.executionTransports).toEqual(["tmux", "app-server"]);
    expect(AGENT_CLIENTS.cursor.executionTransports).toEqual(["tmux"]);
    expect(AGENT_CLIENTS.gemini.executionTransports).toEqual(["tmux"]);
    expect(AGENT_CLIENTS.opencode.executionTransports).toEqual(["tmux"]);
    expect(AGENT_CLIENTS.pi.executionTransports).toEqual(["tmux"]);
  });

  it("rejects unsupported app-server and external routing without fallback", () => {
    expect(agentSupportsExecutionTransport("codex", "app-server")).toBe(true);
    expect(agentSupportsExecutionTransport("claude", "app-server")).toBe(false);
    expect(agentSupportsExecutionTransport("opencode", "app-server")).toBe(false);
    for (const agent of Object.keys(AGENT_CLIENTS) as Array<keyof typeof AGENT_CLIENTS>) {
      expect(agentSupportsExecutionTransport(agent, "external")).toBe(false);
    }
  });
});
