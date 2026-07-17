import { describe, expect, it } from "bun:test";
import { modelOptionKey, findModelOption } from "./agentClients";

// modelOptionKey is the inverse of the launch flag: the conversation row stores
// the full model id, but the pickers, the Cmd+K menu, and — critically — the
// new-session launch path (createSessionFromStub → createSession → daemon
// --model) all key off the contract option key. A regression here silently
// launches the wrong model, so pin the round-trip and the fallbacks.
describe("modelOptionKey", () => {
  it("maps a stored claude model id back to its option key", () => {
    expect(modelOptionKey("claude-opus-4-8", "claude_code")).toBe("opus");
    expect(modelOptionKey("claude-sonnet-5", "claude_code")).toBe("sonnet");
    expect(modelOptionKey("claude-haiku-4-5-20251001", "claude_code")).toBe("haiku");
    expect(modelOptionKey("claude-fable-5", "claude_code")).toBe("fable");
  });

  it("maps the prefix-only requested form the picker stamps", () => {
    // commitModelChange stamps `claude-${optionKey}` optimistically, so the
    // create path reads e.g. "claude-opus" before the daemon echoes the full id.
    expect(modelOptionKey("claude-opus", "claude_code")).toBe("opus");
    expect(modelOptionKey("claude-sonnet", "claude_code")).toBe("sonnet");
  });

  it("returns the option key the launch flag path can resolve", () => {
    // The chain only works if the key round-trips through findModelOption to a
    // launchable cliAlias.
    const key = modelOptionKey("claude-opus-4-8", "claude_code");
    expect(findModelOption("claude_code", key)?.cliAlias).toBe("opus");
  });

  it("falls back to default for no model, unknown ids, and cross-agent mismatch", () => {
    expect(modelOptionKey(undefined, "claude_code")).toBe("default");
    expect(modelOptionKey(null, "claude_code")).toBe("default");
    expect(modelOptionKey("claude-default", "claude_code")).toBe("default");
    // A claude model id read back under the codex agent (after an agent switch on
    // a blank session) must resolve to default, not crash — createSessionFromStub
    // then drops the flag entirely.
    expect(modelOptionKey("claude-opus-4-8", "codex")).toBe("default");
  });

  it("maps codex model ids under the codex agent", () => {
    expect(modelOptionKey("gpt-5.5", "codex")).toBe("gpt-5.5");
    expect(modelOptionKey("gpt-5.4-mini", "codex")).toBe("gpt-5.4-mini");
  });
});
