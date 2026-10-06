import { describe, expect, test } from "bun:test";
import { defaultAgentType, hasNoMachine, newConversationAgentType, type DefaultAgentState } from "./defaultAgent";

const state = (ui: DefaultAgentState["clientState"]["ui"], roster: unknown[] = [{}], live = true): DefaultAgentState => ({
  clientState: { ui },
  machineRoster: roster,
  machineRosterLive: live,
});

describe("defaultAgentType", () => {
  test("Claude when nothing decides", () => {
    expect(defaultAgentType(state({}))).toBe("claude_code");
    expect(defaultAgentType(state(null))).toBe("claude_code");
  });

  test("the viewer's own pick, in the Convex spelling only", () => {
    expect(defaultAgentType(state({ default_agent: "codex" }))).toBe("codex");
    expect(defaultAgentType(state({ default_agent: "codecast" }))).toBe("codecast");
    expect(defaultAgentType(state({ default_agent: "claude" }))).toBe("claude_code");
    expect(defaultAgentType(state({ default_agent: "nonsense" }))).toBe("claude_code");
  });

  test("hosted mode defaults to the hosted assistant over any pick", () => {
    expect(defaultAgentType(state({ lane: "simple", default_agent: "codex" }))).toBe("codecast");
  });

  test("no machine at all defaults to the hosted assistant, once the roster has answered", () => {
    expect(defaultAgentType(state({ default_agent: "codex" }, []))).toBe("codecast");
    expect(defaultAgentType(state({}, [], false))).toBe("claude_code");
    expect(hasNoMachine({ machineRoster: [], machineRosterLive: false })).toBe(false);
  });
});

describe("newConversationAgentType", () => {
  test("carries the conversation's own agent, else the default", () => {
    expect(newConversationAgentType(state({}), "gemini")).toBe("gemini");
    expect(newConversationAgentType(state({ default_agent: "codex" }), undefined)).toBe("codex");
    expect(newConversationAgentType(state({ default_agent: "codex" }), "bogus")).toBe("codex");
  });

  test("hosted mode and a machine-less account always start the hosted assistant", () => {
    expect(newConversationAgentType(state({ lane: "simple" }), "claude_code")).toBe("codecast");
    expect(newConversationAgentType(state({}, []), "claude_code")).toBe("codecast");
  });
});
