import { describe, expect, test } from "bun:test";
import {
  parseSearchTerms,
  rankConversationsByCoverage,
  conversationMatchesAllTerms,
  contentMatchesAnyTerm,
} from "./searchCore";

// Regression for the `cast context` failure: a 7-word natural-language task
// description ("core funnel cold outreach to introduction conversion") returned
// "No relevant sessions found" even though sessions about cold outreach existed.
// Two compounding causes:
//   1. searchForCLI ran a separate search-index scan per term ("to" alone pulls
//      200 arbitrary huge messages) — long queries timed out the whole Convex
//      query. Fetching now goes through one combined relevance-ranked lookup
//      (fetchMessageSearchPool in conversations.ts).
//   2. A conversation only matched if it contained ALL terms, so one missing
//      word (or a timeout-truncated pool) meant zero results.

const msg = (content: string) => ({ content });

describe("parseSearchTerms", () => {
  test("THE BUG: stop-words are dropped from a natural-language task description", () => {
    const terms = parseSearchTerms("core funnel cold outreach to introduction conversion");
    expect(terms.words).toEqual(["core", "funnel", "cold", "outreach", "introduction", "conversion"]);
    expect(terms.all).not.toContain("to");
  });

  test("a query made entirely of stop-words keeps its original words", () => {
    const terms = parseSearchTerms("how to do it");
    expect(terms.words).toEqual(["how", "to", "do", "it"]);
  });

  test("quoted phrases are preserved verbatim, including inner stop-words", () => {
    const terms = parseSearchTerms('"switch to opus" daemon');
    expect(terms.phrases).toEqual(["switch to opus"]);
    expect(terms.words).toEqual(["daemon"]);
  });

  test("duplicate and single-char words are dropped", () => {
    const terms = parseSearchTerms("auth auth x auth");
    expect(terms.words).toEqual(["auth"]);
  });
});

describe("rankConversationsByCoverage", () => {
  const terms = parseSearchTerms("core funnel cold outreach to introduction conversion");

  test("THE BUG: a conversation matching most-but-not-all words still surfaces", () => {
    const groups = new Map([
      // 4 of 6 meaningful words — the real union-mobile cold-outreach session shape
      ["conv-partial", [msg("the cold outreach funnel died, conversion dropped to zero")]],
    ]);
    const ranked = rankConversationsByCoverage(groups, terms);
    expect(ranked.length).toBe(1);
    expect(ranked[0].convId).toBe("conv-partial");
    expect(ranked[0].coverage).toBeCloseTo(4 / 6);
  });

  test("full-coverage conversations rank above partial ones", () => {
    const groups = new Map([
      ["conv-partial", [msg("cold outreach funnel conversion")]],
      ["conv-full", [msg("core funnel: cold outreach to introduction, conversion rates")]],
    ]);
    const ranked = rankConversationsByCoverage(groups, terms);
    expect(ranked.map((r) => r.convId)).toEqual(["conv-full", "conv-partial"]);
  });

  test("below half the words is not a match", () => {
    const groups = new Map([["conv-weak", [msg("we discussed conversion once")]]]);
    expect(rankConversationsByCoverage(groups, terms)).toEqual([]);
  });

  test("short queries (≤2 words) keep strict AND semantics", () => {
    const short = parseSearchTerms("cold outreach");
    const groups = new Map([
      ["conv-both", [msg("cold outreach engine")]],
      ["conv-one", [msg("cold start latency")]],
    ]);
    const ranked = rankConversationsByCoverage(groups, short);
    expect(ranked.map((r) => r.convId)).toEqual(["conv-both"]);
  });

  test("quoted phrases are always required, even with high word coverage", () => {
    const phrased = parseSearchTerms('"introduction conversion" core funnel cold outreach');
    const groups = new Map([
      ["conv-no-phrase", [msg("core funnel cold outreach work")]],
      ["conv-phrase", [msg("core funnel cold outreach and the introduction conversion step")]],
    ]);
    const ranked = rankConversationsByCoverage(groups, phrased);
    expect(ranked.map((r) => r.convId)).toEqual(["conv-phrase"]);
  });

  test("insertion (relevance) order is preserved within a coverage tier", () => {
    const short = parseSearchTerms("daemon heartbeat");
    const groups = new Map([
      ["conv-a", [msg("daemon heartbeat one")]],
      ["conv-b", [msg("daemon heartbeat two")]],
    ]);
    const ranked = rankConversationsByCoverage(groups, short);
    expect(ranked.map((r) => r.convId)).toEqual(["conv-a", "conv-b"]);
  });
});

describe("web-path helpers stay intact", () => {
  test("conversationMatchesAllTerms requires every term", () => {
    const terms = parseSearchTerms("daemon heartbeat");
    expect(conversationMatchesAllTerms([msg("daemon only")], terms)).toBe(false);
    expect(conversationMatchesAllTerms([msg("daemon"), msg("heartbeat")], terms)).toBe(true);
  });

  test("contentMatchesAnyTerm matches on any single term", () => {
    const terms = parseSearchTerms("daemon heartbeat");
    expect(contentMatchesAnyTerm("the daemon restarted", terms)).toBe(true);
    expect(contentMatchesAnyTerm("unrelated text", terms)).toBe(false);
  });
});
