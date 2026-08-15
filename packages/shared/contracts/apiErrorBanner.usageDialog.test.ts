import { describe, expect, it } from "bun:test";
import { isUsageLimitDialog } from "./apiErrorBanner";

// Real option rows captured from Claude Code's usage/billing interstitials.
// These reach the web as ordinary AskUserQuestion polls, so the decision queue
// needs to recognize them by their options and refuse to offer them: the digit
// that "answers" one of these commits a billing change.
describe("isUsageLimitDialog", () => {
  it("catches the usage-limit interstitial seen in the live queue", () => {
    expect(
      isUsageLimitDialog([
        "Stop and wait for limit to reset",
        "Switch to usage credits",
        "Switch to Team plan",
      ])
    ).toBe(true);
  });

  it("catches the monthly-spend variant the daemon converts to a banner", () => {
    expect(
      isUsageLimitDialog(["Adjust monthly spend limit", "Wait for limit to reset"])
    ).toBe(true);
  });

  it("catches a model-switch-on-limit prompt", () => {
    expect(
      isUsageLimitDialog(["Switch model to continue", "Wait until the limit resets"])
    ).toBe(true);
  });

  // The two-match rule is what protects real questions. A genuine design
  // decision may mention one of these words in passing and must survive.
  it("keeps a real question that merely mentions switching models once", () => {
    expect(
      isUsageLimitDialog([
        "Switch model for the summarizer",
        "Keep the current prompt",
        "Rewrite the prompt instead",
      ])
    ).toBe(false);
  });

  it("keeps an ordinary two-option decision", () => {
    expect(isUsageLimitDialog(["Frontmatter wins", "Path wins"])).toBe(false);
  });

  it("is false for an empty or missing option list", () => {
    expect(isUsageLimitDialog([])).toBe(false);
    expect(isUsageLimitDialog(undefined)).toBe(false);
    expect(isUsageLimitDialog(null)).toBe(false);
  });
});
