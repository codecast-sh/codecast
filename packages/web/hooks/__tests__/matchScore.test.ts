import { describe, expect, it } from "bun:test";
import { matchScore, score } from "../useMentionQuery";

const DOC = "Union Outreach — The Roadmap, in Plain Language";

describe("matchScore", () => {
  it("is identical to score() for a single-word query (ranking unchanged)", () => {
    // Both call sites guard with `if (q)`, so the empty query never reaches
    // either matcher — only real single-word queries need to stay in lockstep.
    for (const q of ["plain", "union", "road", "xyz", "outreach"]) {
      expect(matchScore(DOC, q)).toBe(score(DOC, q.trim().toLowerCase()));
    }
  });

  it("matches a mid-title word the way the old substring path did", () => {
    // "plain" is finite (substring hit) — this case already worked; the doc not
    // showing was scope/coverage, not matching.
    expect(matchScore(DOC, "plain")).toBeLessThan(Infinity);
  });

  it("matches multiple words in any order, with gaps between them", () => {
    expect(matchScore(DOC, "plain road")).toBeLessThan(Infinity);
    expect(matchScore(DOC, "road plain")).toBeLessThan(Infinity); // order-independent
    expect(matchScore(DOC, "union language")).toBeLessThan(Infinity);
  });

  it("treats each word as a prefix, so partial words still match", () => {
    expect(matchScore(DOC, "road plain")).toBeLessThan(Infinity); // "road" prefixes "roadmap"
    expect(matchScore(DOC, "out road")).toBeLessThan(Infinity);   // "out" prefixes "outreach"
  });

  it("requires EVERY word to match — one absent word fails the whole query", () => {
    expect(matchScore(DOC, "plain banana")).toBe(Infinity);
    expect(matchScore(DOC, "roadmap missing")).toBe(Infinity);
  });

  it("ranks tighter (more exact/earlier) matches ahead of looser ones", () => {
    // exact word + prefix should beat two loose substring hits
    const tight = matchScore(DOC, "plain language"); // both exact words
    const loose = matchScore(DOC, "lai uag");         // mid-word substrings
    expect(tight).toBeLessThan(loose);
  });

  it("splits the title on punctuation and dashes, not just spaces", () => {
    // "—" and "," must not glue words together
    expect(matchScore("Foo—Bar, Baz", "bar baz foo")).toBeLessThan(Infinity);
  });

  it("ignores surrounding and repeated whitespace in the query", () => {
    expect(matchScore(DOC, "  plain   road  ")).toBeLessThan(Infinity);
  });
});
