import { describe, expect, it } from "bun:test";
import { isResentCopyOfSentMessage, STALE_DRAFT_MIN_LENGTH } from "../staleDraft";

const LONG = "i mean a person can be in multiple markets right?\n\nalso markets should be created bottoms up from semantic space of needs - why would we have any people with explicit needs not in a market it doesn't make sense to me";

describe("isResentCopyOfSentMessage", () => {
  it("matches a byte-identical sent user message", () => {
    expect(isResentCopyOfSentMessage([{ role: "user", content: LONG }], LONG)).toBe(true);
  });

  it("matches a mid-typing prefix of a sent message (debounce race residue)", () => {
    const prefix = LONG.slice(0, 170) + " ";
    expect(isResentCopyOfSentMessage([{ role: "user", content: LONG }], prefix)).toBe(true);
  });

  it("keeps a draft that extends a sent message (new input, not residue)", () => {
    const extended = LONG + " and one more thought I want to add";
    expect(isResentCopyOfSentMessage([{ role: "user", content: LONG }], extended)).toBe(false);
  });

  it("keeps short drafts even when they prefix-match (deliberate re-sends)", () => {
    const short = "continue with the plan we discussed";
    expect(short.length).toBeLessThan(STALE_DRAFT_MIN_LENGTH);
    expect(isResentCopyOfSentMessage([{ role: "user", content: short + " tomorrow morning please" }], short)).toBe(false);
  });

  it("ignores assistant messages", () => {
    expect(isResentCopyOfSentMessage([{ role: "assistant", content: LONG }], LONG.slice(0, 80))).toBe(false);
  });

  it("keeps unrelated drafts", () => {
    expect(isResentCopyOfSentMessage([{ role: "user", content: LONG }], "a completely different pending thought about the roadmap")).toBe(false);
  });

  it("trims both sides before comparing", () => {
    expect(isResentCopyOfSentMessage([{ role: "user", content: `  ${LONG}  ` }], `${LONG.slice(0, 100)}`)).toBe(true);
  });

  it("returns false with no messages loaded", () => {
    expect(isResentCopyOfSentMessage([], LONG)).toBe(false);
    expect(isResentCopyOfSentMessage(undefined, LONG)).toBe(false);
  });
});
