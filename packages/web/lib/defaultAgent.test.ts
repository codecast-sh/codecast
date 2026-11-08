import { describe, expect, test } from "bun:test";
import { defaultAgentType, hasNoMachine, newConversationAgentType, onlyHostedAgent, type DefaultAgentState } from "./defaultAgent";

const state = (ui: DefaultAgentState["clientState"]["ui"], roster: unknown[] = [{}], live = true): DefaultAgentState => ({
  clientState: { ui },
  machineRoster: roster,
  machineRosterLive: live,
});

describe("onlyHostedAgent", () => {
  test("an answered empty roster, and nothing else", () => {
    expect(onlyHostedAgent(state({}, []))).toBe(true);
    expect(onlyHostedAgent(state({}))).toBe(false);
    expect(onlyHostedAgent(state({}, [], false))).toBe(false);
  });
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

  test("no machine at all defaults to the hosted assistant, once the roster has answered", () => {
    expect(defaultAgentType(state({ default_agent: "codex" }, []))).toBe("codecast");
    expect(defaultAgentType(state({}, [], false))).toBe("claude_code");
    expect(hasNoMachine({ machineRoster: [], machineRosterLive: false })).toBe(false);
  });
});

describe("newConversationAgentType", () => {
  test("saved default, then last hand pick, then the conversation's own agent", () => {
    expect(newConversationAgentType(state({}), "gemini")).toBe("gemini");
    expect(newConversationAgentType(state({ default_agent: "codex" }), undefined)).toBe("codex");
    expect(newConversationAgentType(state({ default_agent: "codex" }), "bogus")).toBe("codex");
    expect(newConversationAgentType(state({ default_agent: "codex", last_picked_agent: "gemini" }), "claude_code")).toBe("codex");
    expect(newConversationAgentType(state({ default_agent: null, last_picked_agent: "gemini" }), "claude_code")).toBe("gemini");
    expect(newConversationAgentType(state({ last_picked_agent: "bogus" }), "codex")).toBe("codex");
    expect(defaultAgentType(state({ last_picked_agent: "gemini" }))).toBe("gemini");
  });

  test("a machine-less account always starts the hosted assistant", () => {
    expect(newConversationAgentType(state({}, []), "claude_code")).toBe("codecast");
  });
});
