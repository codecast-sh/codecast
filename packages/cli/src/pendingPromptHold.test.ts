import { afterEach, describe, expect, test } from "bun:test";
import { PROMPT_HOLD_MS, clearPromptHolds, holdConversationForPrompt, promptHoldRemainingMs, releasePromptHold } from "./pendingPromptHold.js";

afterEach(() => clearPromptHolds());

describe("prompt hold", () => {
  test("a refusal holds the conversation for the window", () => {
    holdConversationForPrompt("c1", 1_000);
    expect(promptHoldRemainingMs("c1", 1_000)).toBe(PROMPT_HOLD_MS);
    expect(promptHoldRemainingMs("c1", 2_000)).toBe(PROMPT_HOLD_MS - 1_000);
  });

  test("an expired hold is forgotten", () => {
    holdConversationForPrompt("c1", 1_000);
    expect(promptHoldRemainingMs("c1", 1_000 + PROMPT_HOLD_MS + 1)).toBe(0);
    expect(promptHoldRemainingMs("c1", 1_000)).toBe(0);
  });

  test("releasing the prompt clears the hold", () => {
    holdConversationForPrompt("c1");
    expect(releasePromptHold("c1")).toBe(true);
    expect(promptHoldRemainingMs("c1")).toBe(0);
    expect(releasePromptHold("c1")).toBe(false);
  });
});
