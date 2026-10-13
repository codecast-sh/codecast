import { afterEach, describe, expect, test } from "bun:test";
import { PROMPT_HOLD_MS, clearPromptHolds, holdConversationForPrompt, promptHoldRemainingMs, releasePromptHold, setPendingRedrive } from "./pendingPromptHold.js";

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

describe("prompt hold expiry", () => {
  test("a lapsed hold re-drives delivery on its own", () => {
    const realSetTimeout = globalThis.setTimeout;
    let fire: (() => void) | undefined;
    let delay = 0;
    globalThis.setTimeout = ((fn: () => void, ms: number) => { fire = fn; delay = ms; return realSetTimeout(() => {}, 0); }) as typeof setTimeout;
    let redriven = 0;
    try {
      setPendingRedrive(() => { redriven++; });
      holdConversationForPrompt("c1");
      expect(delay).toBe(PROMPT_HOLD_MS);
      fire!();
      expect(redriven).toBe(1);
      expect(promptHoldRemainingMs("c1")).toBe(0);
    } finally {
      globalThis.setTimeout = realSetTimeout;
      setPendingRedrive(null);
    }
  });

  test("a hold renewed before it lapses is not cut short by the older timer", () => {
    const realSetTimeout = globalThis.setTimeout;
    const fires: Array<() => void> = [];
    globalThis.setTimeout = ((fn: () => void) => { fires.push(fn); return realSetTimeout(() => {}, 0); }) as typeof setTimeout;
    let redriven = 0;
    try {
      setPendingRedrive(() => { redriven++; });
      holdConversationForPrompt("c1", 1_000);
      holdConversationForPrompt("c1", 2_000);
      fires[0]!();
      expect(redriven).toBe(0);
      expect(promptHoldRemainingMs("c1", 2_000)).toBe(PROMPT_HOLD_MS);
    } finally {
      globalThis.setTimeout = realSetTimeout;
      setPendingRedrive(null);
    }
  });
});
