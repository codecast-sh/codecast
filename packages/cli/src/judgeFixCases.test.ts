import { describe, expect, test } from "bun:test";
import { abRunLines, isDraw, readHeldOut, repeatsOutcome, readRunFound, ruledByMessage, ruledQuotesByMoment, rulingsWithheld } from "./judgeFixCommand";
import { dissolveClose } from "./lineDissolveCommand";

describe("ruled cases are counted per message (tc-34)", () => {
  // tc-34's shape: one Oct 7 email ruled on a contact moment and a match moment, one Sep 28 email the same way.
  const cases = [
    { moment: "mo-383", finding: "sg-2664", expectation: "ex-3" },
    { moment: "mo-382", finding: "sg-2561", expectation: "ex-3" },
    { moment: "mo-16", finding: "sg-2650", expectation: "ex-3" },
    { moment: "mo-652", finding: "sg-2621", expectation: "ex-3" },
    { moment: "mo-849", finding: "sg-2700", expectation: "ex-3" },
  ];
  const message: Record<string, string | null> = { "mo-383": "sefi|oct7", "mo-382": "sefi|oct7", "mo-16": "italo|sep28", "mo-652": "italo|sep28", "mo-849": null };

  test("twin moments of one email are one case, the first standing for the rest", () => {
    const out = ruledByMessage(cases, (c) => message[c.moment]!);
    expect(out.map((c) => c.moment)).toEqual(["mo-383", "mo-16", "mo-849"]);
    expect(out[0]!.twins).toEqual([{ moment: "mo-382", finding: "sg-2561" }]);
    expect(out[1]!.twins).toEqual([{ moment: "mo-652", finding: "sg-2621" }]);
    expect(out[2]!.twins).toEqual([]);
  });

  test("the same email under another expectation is another case", () => {
    const out = ruledByMessage([...cases.slice(0, 2), { moment: "mo-382", finding: "sg-9", expectation: "ex-40" }], (c) => message[c.moment]!);
    expect(out.map((c) => `${c.moment} ${c.expectation}`)).toEqual(["mo-383 ex-3", "mo-382 ex-40"]);
  });

  test("a case whose quote places no message is its own", () => {
    const out = ruledByMessage([{ moment: "mo-1", finding: "a", expectation: "ex-3" }, { moment: "mo-2", finding: "b", expectation: "ex-3" }], () => null);
    expect(out).toHaveLength(2);
  });
});

describe("a judge run's findings, cached before and after quotes were kept", () => {
  test("an older cache line reads as its expectations alone", () => {
    expect(readRunFound(["ex-3", "ex-40"])).toEqual([{ expectation: "ex-3", quote: "" }, { expectation: "ex-40", quote: "" }]);
    expect(readRunFound([{ expectation: "ex-3", quote: "Sorry" }])).toEqual([{ expectation: "ex-3", quote: "Sorry" }]);
    expect(readRunFound(null)).toEqual([]);
  });
});

describe("draws: what the published judge does not repeat", () => {
  test("at most one in five is a draw; a case that never ran is not", () => {
    expect(isDraw({ runs: 5, hits: 0 })).toBe(true);
    expect(isDraw({ runs: 5, hits: 1 })).toBe(true);
    expect(isDraw({ runs: 10, hits: 2 })).toBe(true);
    expect(isDraw({ runs: 5, hits: 2 })).toBe(false);
    expect(isDraw({ runs: 15, hits: 5 })).toBe(false);
    expect(isDraw({ runs: 0, hits: 0 })).toBe(false);
  });
  test("a problem of draws closes dropped, saying the judge does not repeat them", () => {
    expect(dissolveClose("draw", "", "0 of 10.", null)).toEqual({ outcome: "dropped", note: "Dropped: the judge does not repeat these findings. 0 of 10." });
  });
});

describe("the A/B keeps the judge's words (ab-runs.jsonl)", () => {
  test("a run's findings keep what the judge said and its severity", () => {
    const found = readRunFound([{ expectation: "ex-3", quote: "I'm sorry about that.", what_happened: "The email apologizes for delay.", severity: 5 }]);
    expect(found).toEqual([{ expectation: "ex-3", quote: "I'm sorry about that.", what_happened: "The email apologizes for delay.", severity: 5 }]);
  });

  test("a run cached before words were kept still reads, without them", () => {
    expect(readRunFound([{ expectation: "ex-3", quote: "q" }, "ex-4"])).toEqual([{ expectation: "ex-3", quote: "q" }, { expectation: "ex-4", quote: "" }]);
  });

  test("each run is one line, cached and unparsed runs included", () => {
    const text = abRunLines([
      { side: "base", moment: "mo-1", judge: "match", rep: 0, cached: true, findings: [{ expectation: "ex-3", quote: "q" }] },
      { side: "arm", moment: "mo-1", judge: "match", rep: 0, findings: [] },
      { side: "arm", moment: "mo-1", judge: "match", rep: 1, findings: null },
    ]);
    const rows = text.trim().split("\n").map((l) => JSON.parse(l));
    expect(rows.map((r) => [r.side, r.rep, r.cached ?? false, r.findings === null ? null : r.findings.length])).toEqual([["base", 0, true, 1], ["arm", 0, false, 0], ["arm", 1, false, null]]);
    expect(abRunLines([])).toBe("");
  });
});

describe("a ruled case's request carries no ruling on its own message", () => {
  // mo-216's shape: the team ruled Fatima's NDA email fine; another message in the same moment carries a ruling of its own.
  const where: Record<string, string> = { "I'm sorry about that.": "mark|oct1", "Mark, thanks for sticking with it": "mark|oct1", "See you Thursday.": "mark|sep30" };
  const messageOf = (q: string) => where[q] ?? null;
  const rulings = [
    { expectation: "ex-3", quote: "I'm sorry about that.", ruling: "owning a broken promise is not narrating effort" },
    { expectation: "ex-3", quote: "See you Thursday.", ruling: "a confirmation, not activity" },
  ];

  test("a ruled moment withholds rulings on the ruled message, by any quote that places in it, and keeps the rest", () => {
    expect(rulingsWithheld(rulings, ["Mark, thanks for sticking with it"], messageOf).map((r) => r.quote)).toEqual(["See you Thursday."]);
  });

  test("a control's request keeps every ruling (nothing withheld for it)", () => {
    const withhold = ruledQuotesByMoment([{ moment: "mo-216", quote: "Mark, thanks for sticking with it" }]);
    expect(withhold.get("mo-993")).toBeUndefined();
    expect(withhold.get("mo-216")).toEqual(["Mark, thanks for sticking with it"]);
  });

  test("a ruling whose quote places no message is withheld only when its words are a ruled quote's", () => {
    const loose = [{ expectation: "ex-3", quote: "unplaced words" }, { expectation: "ex-3", quote: "other words" }];
    expect(rulingsWithheld(loose, ["unplaced words"], () => null).map((r) => r.quote)).toEqual(["other words"]);
  });

  test("twins of one email each withhold on their own moment; a case with no quote withholds nothing", () => {
    const m = ruledQuotesByMoment([{ moment: "mo-383", quote: "a" }, { moment: "mo-382", quote: "a" }, { moment: "mo-849" }]);
    expect([...m.keys()]).toEqual(["mo-383", "mo-382"]);
  });
});

describe("held-out cases (held-out.json)", () => {
  test("reads findings with why, bare ids, and drops anything that is not a finding", () => {
    expect(readHeldOut([{ finding: "sg-1", why: "same apology for a broken promise" }, "sg-2", { finding: "mo-3" }, null])).toEqual([
      { finding: "sg-1", why: "same apology for a broken promise" }, { finding: "sg-2", why: "" },
    ]);
    expect(readHeldOut({})).toEqual([]);
  });
});

describe("repeatsOutcome: a judge fix is worth trying only where one could be measured", () => {
  test("cases the judge files at most once in five are draws", () => {
    expect(repeatsOutcome([{ runs: 5, hits: 1 }, { runs: 5, hits: 0 }])).toBe("draws");
  });
  test("one case filed 2 of 5 cannot separate from a fix that ends it: draws (ct-59568)", () => {
    expect(repeatsOutcome([{ runs: 5, hits: 2 }])).toBe("draws");
    expect(repeatsOutcome([{ runs: 5, hits: 3 }])).toBe("draws");
  });
  test("a case filed 4 of 5, or weaker ones pooled, can: repeats (ct-60174's 7 of 10)", () => {
    expect(repeatsOutcome([{ runs: 5, hits: 4 }])).toBe("repeats");
    expect(repeatsOutcome([{ runs: 5, hits: 2 }, { runs: 5, hits: 5 }])).toBe("repeats");
    expect(repeatsOutcome([{ runs: 5, hits: 3 }, { runs: 5, hits: 3 }])).toBe("repeats");
  });
  test("a case that did not run leaves it to be fixed", () => {
    expect(repeatsOutcome([{ runs: 0, hits: 0 }, { runs: 5, hits: 1 }])).toBe("repeats");
  });
});
