import { describe, expect, test } from "bun:test";
import {
  parseQueryTerms,
  findTerm,
  signalOf,
  emptyEvidence,
  addEvidence,
  coverageOf,
  relevanceOf,
  relevanceTier,
  termSpans,
  snippetAround,
  contentMatchesAnyTerm,
} from "./terms";

// The search that started this: "k pop warm intro video" could not find the
// session where the K-pop warm intro video was made. It had drifted to the
// title "Warmintro landing site", and every session that said "popped",
// "introduce" and "video" somewhere tied with it and won on being newer.
const QUERY = "k pop warm intro video";

const relevance = (query: string, texts: Array<{ content: string; own?: boolean }>, fields: string[] = []) => {
  const terms = parseQueryTerms(query);
  const ev = emptyEvidence(terms);
  for (const t of texts) addEvidence(ev, t.content, terms, { own: t.own, message: true });
  for (const f of fields) addEvidence(ev, f, terms, { own: true });
  return coverageOf(ev, terms) === null ? null : relevanceOf(ev, terms);
};

describe("parseQueryTerms", () => {
  test("a lone letter is no word, but joins its neighbour", () => {
    const terms = parseQueryTerms(QUERY);
    expect(terms.words).toEqual(["pop", "warm", "intro", "video"]);
    expect(terms.joins).toEqual(["k-pop", "pop-warm", "warm-intro", "intro-video"]);
  });

  test("the index lookup carries joined forms ahead of the typed words", () => {
    const tokens = parseQueryTerms(QUERY).lookup.split(" ");
    expect(tokens).toContain("kpop");
    expect(tokens).toContain("warmintro");
    expect(tokens[tokens.length - 1]).toBe("video");
    expect(tokens.length).toBeLessThanOrEqual(16);
  });

  test("a letter after its word joins backwards", () => {
    expect(parseQueryTerms("plan b rollout").joins).toEqual(["plan-b", "b-rollout"]);
  });

  test("stop-words and phrases break a run of neighbours", () => {
    expect(parseQueryTerms("intro to video").joins).toEqual([]);
    expect(parseQueryTerms('warm "exact phrase" intro').joins).toEqual([]);
  });

  test("a hyphenated word is looked up by its parts and its joined form", () => {
    const terms = parseQueryTerms("k-pop");
    expect(terms.words).toEqual(["k-pop"]);
    expect(terms.lookup.split(" ").sort()).toEqual(["k", "kpop", "pop"]);
  });
});

describe("findTerm", () => {
  test("a word's parts may sit together, hyphenated or spaced", () => {
    for (const text of ["a kpop song", "a k-pop song", "a k pop song", "a k_pop song"]) {
      expect(findTerm(text, "k-pop")).not.toBeNull();
    }
    expect(findTerm("a korean pop song", "k-pop")).toBeNull();
  });

  test("a quoted phrase stays literal", () => {
    expect(findTerm("warm-intro", "warm intro")).toBeNull();
    expect(findTerm("a warm intro", "warm intro")).toEqual([2, 12]);
  });
});

describe("match quality", () => {
  const terms = parseQueryTerms("intro video");
  const q = (text: string) => signalOf(text, terms)?.quality;

  test("a whole word beats the start of a longer word beats its inside", () => {
    expect(q("the intro")).toEqual([1, 0]);
    expect(q("introduce me")).toEqual([0.6, 0]);
    expect(q("reintroduce")).toEqual([0.3, 0]);
  });

  test("an inflected word is still the whole word", () => {
    expect(q("two intros, three videos")).toEqual([1, 1]);
  });

  test("query words written as one are each the whole word", () => {
    const warm = parseQueryTerms("warm intro");
    expect(signalOf("Warmintro landing site", warm)).toMatchObject({ quality: [1, 1], pairs: [true] });
  });
});

describe("relevance", () => {
  const made = [
    { content: "Use suno cli to create an amazing k pop song for a music video that advertises Union", own: true },
    { content: "Rendered warm_intro_v3.mp4, the WARM INTRO video, 3:10 at 1080p" },
  ];
  const noise = [
    { content: "The modal popped up after I introduce the warmup step; see the video" },
  ];

  test("THE BUG: words inside longer words no longer tie with the real thing", () => {
    const real = relevance(QUERY, made)!;
    const loose = relevance(QUERY, noise)!;
    expect(loose).not.toBeNull();
    expect(real).toBeGreaterThan(loose);
    expect(relevanceTier(real)).toBeGreaterThan(relevanceTier(loose));
  });

  test("a session's opening prompt and earlier titles count as the person's own words", () => {
    const late = [{ content: "warm intro landing page copy for the video and its k-pop cast" }];
    const without = relevance(QUERY, late)!;
    const withFields = relevance(QUERY, late, ["Warmintro landing site", "build a k pop music video for Union"])!;
    expect(withFields).toBeGreaterThan(without);
  });

  test("words side by side beat the same words scattered", () => {
    const together = relevance("warm intro", [{ content: "the warm intro video" }])!;
    const apart = relevance("warm intro", [{ content: "keep the intro short and the tone warm" }])!;
    expect(together).toBeGreaterThan(apart);
  });

  test("a session with many matching messages beats one passing mention", () => {
    const one = [{ content: "daemon heartbeat" }];
    const many = Array.from({ length: 12 }, () => ({ content: "daemon heartbeat" }));
    expect(relevance("daemon heartbeat", many)!).toBeGreaterThan(relevance("daemon heartbeat", one)!);
  });

  test("coverage rules are unchanged: phrases required, half the words of a long query", () => {
    expect(relevance('"exact phrase" daemon', [{ content: "daemon only" }])).toBeNull();
    expect(relevance("one two three four", [{ content: "one" }])).toBeNull();
    expect(relevance("one two three four", [{ content: "one two" }])).not.toBeNull();
  });
});

describe("marks and snippets", () => {
  test("THE BUG: a dropped letter is not marked inside other words", () => {
    const terms = parseQueryTerms(QUERY);
    const text = "ask about the K-pop look";
    expect(termSpans(text, terms).map(([a, b]) => text.slice(a, b))).toEqual(["K-pop"]);
  });

  test("neighbours found together are one mark", () => {
    const text = "the warm intro video";
    expect(termSpans(text, parseQueryTerms(QUERY)).map(([a, b]) => text.slice(a, b))).toEqual(["warm intro video"]);
  });

  test("a snippet centres on where most of the query sits, not on the first hit", () => {
    const filler = "x ".repeat(400);
    const text = `a video note. ${filler} here is the k-pop warm intro video itself. ${filler}`;
    const snippet = snippetAround(text, parseQueryTerms(QUERY), 200);
    expect(snippet).toContain("k-pop warm intro video");
    expect(snippet.length).toBeLessThanOrEqual(206);
  });

  test("no hit: the opening of the text", () => {
    expect(snippetAround("nothing here", parseQueryTerms("zebra"))).toBe("nothing here");
    expect(contentMatchesAnyTerm("nothing here", parseQueryTerms("zebra"))).toBe(false);
  });
});
