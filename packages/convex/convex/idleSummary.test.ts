import { describe, expect, test } from "bun:test";
import { isSummarizableMessage, isUsableIdleSummary } from "./idleSummary";

// Regression: a session whose recent tail was all machine noise got its
// idle_summary overwritten with the model's refusal prose, which then rendered
// verbatim on the inbox card (2026-07-13, "Scheduled rows layout fix").
const OBSERVED_REFUSAL =
  "I don't see a recent conversation to analyze. Please provide the conversation history between the agent and user so I can write the appropriate summary based on the criteria you've outlined.";

describe("isUsableIdleSummary", () => {
  test("rejects the observed refusal", () => {
    expect(isUsableIdleSummary(OBSERVED_REFUSAL)).toBe(false);
  });

  test("rejects first-person openers (refusal signature)", () => {
    expect(isUsableIdleSummary("I need more context to summarize this")).toBe(false);
    expect(isUsableIdleSummary("I'm unable to determine the next action")).toBe(false);
  });

  test("rejects prompt-banned tokens", () => {
    expect(isUsableIdleSummary("Waiting — please confirm the approach")).toBe(false);
    expect(isUsableIdleSummary("Blocked until the user provides the endpoint")).toBe(false);
  });

  test("accepts verb-first completion summaries", () => {
    expect(isUsableIdleSummary("Fixed search timeout and batch overflow hazard in production")).toBe(true);
    expect(isUsableIdleSummary("Deployed auth fix and verified tests pass")).toBe(true);
    // Verbs starting with the letter I must not trip the first-person check.
    expect(isUsableIdleSummary("Identified root cause of image attachment loading delays")).toBe(true);
    expect(isUsableIdleSummary("Implemented service worker caching and IndexedDB hydration")).toBe(true);
  });

  test("accepts blocked-waiting imperatives", () => {
    expect(isUsableIdleSummary("Confirm the exact UI change needed")).toBe(true);
    expect(isUsableIdleSummary("Choose between the two proposed approaches")).toBe(true);
  });

  test("rejects empty and oversized output", () => {
    expect(isUsableIdleSummary("")).toBe(false);
    expect(isUsableIdleSummary("   ")).toBe(false);
    expect(isUsableIdleSummary("x".repeat(300))).toBe(false);
  });
});

describe("isSummarizableMessage", () => {
  test("keeps real user prompts and assistant replies", () => {
    expect(isSummarizableMessage({ role: "user", content: "fix the layout" })).toBe(true);
    expect(isSummarizableMessage({ role: "assistant", content: "Done — two lines now." })).toBe(true);
  });

  test("drops tool-result carriers", () => {
    expect(
      isSummarizableMessage({ role: "user", content: "result text", tool_results: [{}] })
    ).toBe(false);
  });

  test("drops machine noise the model can't summarize", () => {
    expect(
      isSummarizableMessage({ role: "user", content: "<task-notification>\n<task-id>b1</task-id>" })
    ).toBe(false);
    expect(
      isSummarizableMessage({ role: "user", content: "[Request interrupted by user]" })
    ).toBe(false);
    expect(isSummarizableMessage({ role: "user", content: "[image]" })).toBe(false);
  });

  test("drops blank content and non-conversation roles", () => {
    expect(isSummarizableMessage({ role: "user", content: "   " })).toBe(false);
    expect(isSummarizableMessage({ role: "user", content: undefined })).toBe(false);
    expect(isSummarizableMessage({ role: "system", content: "hi" })).toBe(false);
  });
});
