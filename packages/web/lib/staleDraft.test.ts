import { describe, it, expect } from "bun:test";
import { isResentCopyOfSentMessage, STALE_DRAFT_MIN_LENGTH } from "./staleDraft";

const LONG = "please drive a plan with a deep workflow to build and validate fixes to everything";

describe("isResentCopyOfSentMessage", () => {
  it("flags a draft identical to a sent user message", () => {
    expect(isResentCopyOfSentMessage([{ role: "user", content: LONG }], LONG)).toBe(true);
    expect(isResentCopyOfSentMessage([{ role: "human", content: LONG }], LONG)).toBe(true);
  });

  it("ignores whitespace differences", () => {
    expect(isResentCopyOfSentMessage([{ role: "user", content: `  ${LONG}\n` }], `${LONG} `)).toBe(true);
  });

  it("never flags short drafts, even exact matches (deliberate re-sends)", () => {
    expect("continue".length).toBeLessThan(STALE_DRAFT_MIN_LENGTH);
    expect(isResentCopyOfSentMessage([{ role: "user", content: "continue" }], "continue")).toBe(false);
  });

  it("does not match assistant messages", () => {
    expect(isResentCopyOfSentMessage([{ role: "assistant", content: LONG }], LONG)).toBe(false);
  });

  it("does not flag a draft that merely resembles a sent message", () => {
    expect(isResentCopyOfSentMessage([{ role: "user", content: LONG }], `${LONG} and then some`)).toBe(false);
  });

  it("handles empty inputs", () => {
    expect(isResentCopyOfSentMessage([], LONG)).toBe(false);
    expect(isResentCopyOfSentMessage(undefined, LONG)).toBe(false);
    expect(isResentCopyOfSentMessage([{ role: "user", content: LONG }], null)).toBe(false);
    expect(isResentCopyOfSentMessage([{ role: "user" }], "")).toBe(false);
  });
});
