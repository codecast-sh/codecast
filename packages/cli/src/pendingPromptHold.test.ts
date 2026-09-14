import { afterEach, describe, expect, test } from "bun:test";
import { PROMPT_HOLD_MS, clearPromptHolds, holdConversationForPrompt, promptHoldRemainingMs, releasePromptHold } from "./pendingPromptHold.js";

afterEach(() => clearPromptHolds());

describe("prompt hold", () => {
  test("a machine refusal holds machine messages and lets a person's message through", () => {
    holdConversationForPrompt("c1", {}, 1_000);
    expect(promptHoldRemainingMs("c1", false, 1_000)).toBe(PROMPT_HOLD_MS);
    expect(promptHoldRemainingMs("c1", true, 1_000)).toBe(0);
  });

  test("a refused human message holds human messages too", () => {
    // An unnumbered select dialog takes no typed answer: without this the
    // re-pended row re-fires the delivery scan at once, in a loop.
    holdConversationForPrompt("c1", { humans: true }, 1_000);
    expect(promptHoldRemainingMs("c1", true, 2_000)).toBe(PROMPT_HOLD_MS - 1_000);
  });

  test("a later machine refusal in the same window keeps the human hold", () => {
    holdConversationForPrompt("c1", { humans: true }, 1_000);
    holdConversationForPrompt("c1", {}, 5_000);
    expect(promptHoldRemainingMs("c1", true, 5_000)).toBe(PROMPT_HOLD_MS);
  });

  test("an expired hold forgets that it covered human messages", () => {
    holdConversationForPrompt("c1", { humans: true }, 1_000);
    holdConversationForPrompt("c1", {}, 1_000 + PROMPT_HOLD_MS + 1);
    expect(promptHoldRemainingMs("c1", true, 1_000 + PROMPT_HOLD_MS + 1)).toBe(0);
  });

  test("releasing the prompt clears both", () => {
    holdConversationForPrompt("c1", { humans: true });
    expect(releasePromptHold("c1")).toBe(true);
    expect(promptHoldRemainingMs("c1", true)).toBe(0);
  });
});
