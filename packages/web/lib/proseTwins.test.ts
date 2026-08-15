import { describe, expect, it } from "bun:test";
import { dropScrapedProseTwins, isScrapedProseTwin } from "./proseTwins";

const PROSE = "Tokens minted and stashed. Now seed them into the isolated browser.";

const real = (content: string, uuid = "ec4ad6ca-9bf4-4ccd-a6d7-8e16e7428e73") => ({
  role: "assistant",
  content,
  message_uuid: uuid,
});
const scrapedProse = (content: string) => ({
  role: "assistant",
  content,
  message_uuid: "interactive-prompt-880d616a-0c9a-48b8-8a0a-6f3b2c1d4e5a-prose",
});
const scrapedCard = () => ({
  role: "assistant",
  content: "",
  message_uuid: "interactive-prompt-880d616a-0c9a-48b8-8a0a-6f3b2c1d4e5a",
});

describe("isScrapedProseTwin", () => {
  it("matches only the -prose sidecar, not the card it accompanies", () => {
    expect(isScrapedProseTwin(scrapedProse(PROSE).message_uuid)).toBe(true);
    expect(isScrapedProseTwin(scrapedCard().message_uuid)).toBe(false);
    expect(isScrapedProseTwin("ec4ad6ca-9bf4-4ccd-a6d7-8e16e7428e73")).toBe(false);
    expect(isScrapedProseTwin(null)).toBe(false);
  });
});

describe("dropScrapedProseTwins", () => {
  // The reported shape: the turn flushed, so both copies exist.
  it("drops the scrape once the real turn carries the same text", () => {
    const out = dropScrapedProseTwins([scrapedProse(PROSE), real(PROSE)]);
    expect(out).toHaveLength(1);
    expect(out[0].message_uuid).toBe("ec4ad6ca-9bf4-4ccd-a6d7-8e16e7428e73");
  });

  // While the question is still pending the scrape is the ONLY copy of the
  // reasoning — dropping it would leave the card with no context at all.
  it("keeps a scrape that has no real counterpart yet", () => {
    const out = dropScrapedProseTwins([scrapedProse(PROSE), scrapedCard()]);
    expect(out).toHaveLength(2);
  });

  it("ignores whitespace differences between the two copies", () => {
    const out = dropScrapedProseTwins([scrapedProse(`  ${PROSE}\n`), real(PROSE)]);
    expect(out).toHaveLength(1);
  });

  it("leaves a different scraped paragraph alone", () => {
    const out = dropScrapedProseTwins([scrapedProse("Something else entirely."), real(PROSE)]);
    expect(out).toHaveLength(2);
  });

  it("does not match a user message that happens to quote the prose", () => {
    const quoted = { role: "user", content: PROSE, message_uuid: "u1" };
    const out = dropScrapedProseTwins([scrapedProse(PROSE), quoted]);
    expect(out).toHaveLength(2);
  });

  // Array identity must stay stable when there is nothing to do — the caller
  // memoizes on it, so a fresh ref every render would re-push the whole list.
  it("returns the same array when no twin is present", () => {
    const input = [real(PROSE), scrapedCard()];
    expect(dropScrapedProseTwins(input)).toBe(input);
  });
});
