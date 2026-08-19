import { describe, expect, it } from "bun:test";
import { modelOptionKey, findModelOption } from "./agentClients";
import { isDynamicModelKey, dynamicModelOption, featuredModelOptions } from "./modelOptions";

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
    for (const model of ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5", "gpt-5.4-mini"]) {
      expect(modelOptionKey(model, "codex")).toBe(model);
      expect(findModelOption("codex", model)?.cliAlias).toBe(model);
    }
  });
});

// Dynamic model keys (opencode/pi): the wire key IS the `provider/model` string,
// synthesized into an option by findModelOption. This is the seam that lets the
// picker, convex dispatch validation, and the daemon launch flags all accept
// inventory-sourced models — so pin the shape gate, the synthesis, and the
// per-client gating (static clients must NOT accept these keys).
describe("dynamic model options", () => {
  it("accepts well-formed provider/model keys and rejects junk", () => {
    expect(isDynamicModelKey("anthropic/claude-sonnet-5")).toBe(true);
    expect(isDynamicModelKey("openrouter/anthropic/claude-sonnet-5")).toBe(true);
    expect(isDynamicModelKey("google-vertex/claude-sonnet-5@default")).toBe(true);
    expect(isDynamicModelKey("openrouter/meta-llama/llama-3.1-8b:free")).toBe(true);
    expect(isDynamicModelKey("sonnet")).toBe(false); // no provider
    expect(isDynamicModelKey("a/../b")).toBe(false);
    expect(isDynamicModelKey("rm -rf /")).toBe(false);
    expect(isDynamicModelKey("a/b;echo hi")).toBe(false);
    expect(isDynamicModelKey(`x/${"y".repeat(130)}`)).toBe(false);
  });

  it("synthesized options launch as their own cliAlias with a readable label", () => {
    const opt = dynamicModelOption("openrouter/anthropic/claude-sonnet-5");
    expect(opt.cliAlias).toBe("openrouter/anthropic/claude-sonnet-5");
    expect(opt.label).toBe("Claude Sonnet 5");
    expect(opt.hint).toBe("via openrouter/anthropic");
    expect(dynamicModelOption("openai/gpt-5.2").label).toBe("GPT 5.2");
    // date pins drop from the label; dash version runs join with dots
    expect(dynamicModelOption("anthropic/claude-sonnet-4-20250514").label).toBe("Claude Sonnet 4");
    expect(dynamicModelOption("anthropic/claude-haiku-4-5-20251001").label).toBe("Claude Haiku 4.5");
  });

  it("findModelOption synthesizes for dynamic clients only", () => {
    const key = "openrouter/anthropic/claude-sonnet-5";
    expect(findModelOption("opencode", key)?.cliAlias).toBe(key);
    expect(findModelOption("pi", key)?.cliAlias).toBe(key);
    // static clients: unknown keys stay unknown (no accidental pass-through)
    expect(findModelOption("claude_code", key)).toBeUndefined();
    expect(findModelOption("codex", key)).toBeUndefined();
    // malformed keys stay unknown even for dynamic clients
    expect(findModelOption("opencode", "not a model")).toBeUndefined();
  });

  it("modelOptionKey passes dynamic keys through unchanged", () => {
    const key = "openrouter/anthropic/claude-sonnet-5";
    expect(modelOptionKey(key, "opencode")).toBe(key);
    expect(modelOptionKey(key, "pi")).toBe(key);
    // a bare transcript model id still resolves against the static families
    expect(modelOptionKey("claude-sonnet-5", "opencode")).toBe("sonnet");
  });

  it("featuredModelOptions picks the best id per family from a live inventory", () => {
    const inventory = [
      "openrouter/anthropic/claude-sonnet-4.5",
      "openrouter/anthropic/claude-sonnet-5",
      "anthropic/claude-sonnet-5",
      "openrouter/anthropic/claude-opus-4.8",
      "openrouter/anthropic/claude-opus-4.8-fast",
      "openrouter/openai/gpt-5.2",
      "google/gemini-2.5-pro",
      "google-vertex/gemini-2.5-pro",
      "google-vertex/claude-sonnet-5@default",
      "anthropic/claude-haiku-4-5",
      "anthropic/claude-haiku-4-5-20251001",
    ];
    const featured = featuredModelOptions(inventory);
    const keys = featured.map((o) => o.key);
    // direct provider beats the aggregator; higher version beats lower
    expect(keys).toContain("anthropic/claude-sonnet-5");
    expect(keys).not.toContain("openrouter/anthropic/claude-sonnet-4.5");
    // variant/pinned ids (-fast, @date) never make the head
    expect(keys).toContain("openrouter/anthropic/claude-opus-4.8");
    expect(keys).not.toContain("openrouter/anthropic/claude-opus-4.8-fast");
    expect(keys).toContain("openrouter/openai/gpt-5.2");
    // equal version: the shorter id wins (google/ over google-vertex/, undated
    // over date-pinned)
    expect(keys).toContain("google/gemini-2.5-pro");
    expect(keys).not.toContain("google-vertex/gemini-2.5-pro");
    expect(keys).toContain("anthropic/claude-haiku-4-5");
    expect(keys).not.toContain("anthropic/claude-haiku-4-5-20251001");
    // every featured option is launchable through the same synthesis
    for (const o of featured) expect(o.cliAlias).toBe(o.key);
  });

  it("featuredModelOptions returns empty for an empty inventory (callers fall back)", () => {
    expect(featuredModelOptions([])).toEqual([]);
  });
});
