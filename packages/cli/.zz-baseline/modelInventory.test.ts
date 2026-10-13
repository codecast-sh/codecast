import { describe, expect, test } from "bun:test";
import { parseOpencodeModels, parsePiModels } from "./modelInventory.js";

// Fixtures mirror the real CLI outputs (opencode 1.18, pi 0.x) — the collectors
// feed these straight into the heartbeat payload, so a format drift should fail
// here, not silently empty the pickers.

describe("parseOpencodeModels", () => {
  test("keeps provider/model lines, drops noise", () => {
    const out = [
      "", // leading blank
      "google/gemini-2.5-pro",
      "opencode/kimi-k2.5",
      "openrouter/anthropic/claude-sonnet-5",
      "some warning without a slash",
      "  openrouter/openai/gpt-5.2  ", // padded
    ].join("\n");
    expect(parseOpencodeModels(out)).toEqual([
      "google/gemini-2.5-pro",
      "opencode/kimi-k2.5",
      "openrouter/anthropic/claude-sonnet-5",
      "openrouter/openai/gpt-5.2",
    ]);
  });
});

describe("parsePiModels", () => {
  test("joins the provider and model columns, skipping the header", () => {
    const out = [
      "provider    model                                          context  max-out  thinking  images",
      "anthropic   claude-sonnet-5                                200K     64K      yes       yes   ",
      "google      gemini-2.5-pro                                 1.0M     66K      yes       yes   ",
      "openrouter  anthropic/claude-opus-4.8                      200K     32K      yes       yes   ",
      "",
    ].join("\n");
    expect(parsePiModels(out)).toEqual([
      "anthropic/claude-sonnet-5",
      "google/gemini-2.5-pro",
      "openrouter/anthropic/claude-opus-4.8",
    ]);
  });
});
