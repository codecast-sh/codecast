import { describe, expect, test } from "bun:test";
import {
  parseSearchTerms,
  rankConversationsByCoverage,
  groupMessagesByConversation,
  conversationMatchesAllTerms,
  contentMatchesAnyTerm,
  relevanceWithFields,
  bestMessages,
  searchFieldsOf,
  originMatch,
  earlierTitlesAfter,
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

describe("groupMessagesByConversation", () => {
  test("keeps messages holding any term, per conversation, and honors userOnly", () => {
    const terms = parseSearchTerms("jon stewart crossfire");
    const pool = [
      { conversation_id: "a", role: "assistant", content: "Jon Stewart on Crossfire" },
      { conversation_id: "a", role: "user", content: "unrelated" },
      { conversation_id: "b", role: "user", content: "call Jon back" },
    ];
    const all = groupMessagesByConversation(pool, terms);
    expect([...all.keys()]).toEqual(["a", "b"]);
    expect(all.get("a")).toHaveLength(1);
    expect([...groupMessagesByConversation(pool, terms, true).keys()]).toEqual(["b"]);
    // b covers 1 of 3 words, below the half a three-word query needs.
    expect(rankConversationsByCoverage(all, terms).map((r) => r.convId)).toEqual(["a"]);
  });
});

// "k pop warm intro video" could not find the session that made the video: it
// had been retitled "Warmintro landing site", its rows showed late messages
// about domain names, and newer sessions that said "popped" and "introduce"
// tied with it. Ranking now reads how each word matched, whose words they are,
// and what the session was before its title moved on.
describe("ranking a drifted session", () => {
  const terms = parseSearchTerms("k pop warm intro video");
  const drifted = {
    title: "Warmintro landing site",
    subtitle: "Deploy the landing page",
    first_prompt: "build e2e a music video that will advertise Union, with an amazing k pop song",
    earlier_titles: ["Union K-pop music video"],
  };
  const groups = new Map([
    ["noise", [{ role: "assistant", content: "the modal popped up; introduce a warmup, see the video" }]],
    ["made", [
      { role: "assistant", content: "Brainstorm warm intro names and check domain prices" },
      { role: "user", content: "make the k-pop warm intro video the centre of the page" },
      { role: "user", content: "tool output mentioning video", tool_results_count: 1 },
    ]],
  ]);
  const ranked = new Map(rankConversationsByCoverage(groups, terms).map((r) => [r.convId, r]));

  test("the session about it outranks one that only holds the letters", () => {
    const made = relevanceWithFields(ranked.get("made")!, searchFieldsOf(drifted), terms);
    const noise = relevanceWithFields(ranked.get("noise")!, ["Modal polish"], terms);
    expect(made).toBeGreaterThan(noise + 0.3);
  });

  test("its own fields lift it, and do not change what the messages said", () => {
    const before = relevanceWithFields(ranked.get("made")!, [], terms);
    const after = relevanceWithFields(ranked.get("made")!, searchFieldsOf(drifted), terms);
    expect(after).toBeGreaterThanOrEqual(before);
    expect(relevanceWithFields(ranked.get("made")!, [], terms)).toBe(before);
  });

  test("the row shows the person's own message that holds the most of the query", () => {
    expect(bestMessages(ranked.get("made")!, 1)[0].content).toContain("k-pop warm intro video");
  });

  test("a result says what the session began as when that is what matched", () => {
    expect(originMatch(drifted, terms)).toEqual({
      started_as: drifted.first_prompt,
      earlier_titles: ["Union K-pop music video"],
    });
    expect(originMatch({ title: "x", first_prompt: "unrelated" }, terms)).toBeUndefined();
  });
});

describe("earlierTitlesAfter", () => {
  test("keeps the replaced title, distinct and bounded, and nothing when unchanged", () => {
    expect(earlierTitlesAfter({ title: "A" }, "B")).toEqual(["A"]);
    expect(earlierTitlesAfter({ title: "B", earlier_titles: ["A"] }, "A")).toEqual(["B"]);
    expect(earlierTitlesAfter({ title: "A", earlier_titles: ["Z"] }, "A")).toBeUndefined();
    expect(earlierTitlesAfter({}, "A")).toBeUndefined();
    const many = earlierTitlesAfter({ title: "T7", earlier_titles: ["T1", "T2", "T3", "T4", "T5", "T6"] }, "T8")!;
    expect(many).toEqual(["T2", "T3", "T4", "T5", "T6", "T7"]);
  });
});
