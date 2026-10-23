import { describe, expect, test } from "bun:test";
import { affordable, assignFamiliesPrompt, dueForScoring, labelKey, parseAssignments, parseFamilies, parseProblemScore, problemFamiliesPrompt, problemScorePrompt, sampleFindings, spentToday } from "./problemScore";

describe("problem scoring", () => {
  test("a reply is clamped into range and needs a root cause", () => {
    expect(parseProblemScore('{"score":140,"harm":0,"reach":3,"fixability":9,"reason":" r ","root_cause":" stale match state "}')).toEqual({ score: 100, harm: 1, reach: 3, fixability: 5, reason: "r", root_cause: "stale match state" });
    expect(parseProblemScore('{"score":50,"harm":2,"reach":2,"fixability":2,"reason":"r","root_cause":""}')).toBeNull();
    expect(parseProblemScore("not json")).toBeNull();
  });

  test("the sample takes the most severe first and one per distinct opening", () => {
    const rows = [
      { detail: "A same story", severity: 5, at: 1 },
      { detail: "A same story", severity: 9, at: 2 },
      { detail: "B other", severity: 7, at: 3 },
      { detail: "C low", at: 4 },
    ];
    expect(sampleFindings(rows, 2).map((r) => [r.detail, r.severity])).toEqual([["A same story", 9], ["B other", 7]]);
    expect(sampleFindings(rows).length).toBe(3);
  });

  test("the prompt carries the counts and the findings as data", () => {
    const p = problemScorePrompt({ title: "T", description: "D".repeat(5_000), finding_count: 4, conversation_count: 3, severities: [8, 6], sample: [{ detail: "F1", severity: 8 }] });
    expect(p).toContain('findings="4" conversations="3" severities="8,6"');
    expect(p).toContain('<finding n="1" severity="8">\nF1\n</finding>');
    expect(p).toContain("[cut]");
  });
});

describe("families", () => {
  const families = [{ key: "close-scope", name: "Close-out scope", covers: "x" }];

  test("keys are slugged and unique", () => {
    expect(parseFamilies('{"families":[{"key":"Close Scope!","name":"n","covers":"c"},{"key":"close-scope","name":"dup","covers":"c"}]}')).toEqual([{ key: "close-scope", name: "n", covers: "c" }]);
    expect(parseFamilies('{"families":[]}')).toBeNull();
  });

  test("assignments map label positions, unknown keys go to other", () => {
    const m = parseAssignments('{"assignments":[{"n":1,"key":"close-scope"},{"n":2,"key":"nope"},{"n":9,"key":"close-scope"}]}', families, 2)!;
    expect([...m.entries()]).toEqual([[0, "close-scope"], [1, "other"]]);
  });

  test("prompts list what they are given", () => {
    expect(problemFamiliesPrompt([{ label: "a", count: 3 }])).toContain("3\ta");
    expect(assignFamiliesPrompt(families, ["x", "y"])).toContain("2\ty");
    expect(labelKey("  Stale   Match ")).toBe("stale match");
  });
});

describe("keeping scores current", () => {
  const scored = (at: number, version = "1") => ({ at, version });
  test("unscored problems go first, newest first, then problems with a finding newer than their score, oldest score first", () => {
    const rows = [
      { id: "fresh", scored: scored(500), last_finding_at: 400, created_at: 1 },
      { id: "stale-old", scored: scored(100), last_finding_at: 900, created_at: 2 },
      { id: "new-a", scored: null, last_finding_at: 50, created_at: 10 },
      { id: "stale-new", scored: scored(300), last_finding_at: 900, created_at: 3 },
      { id: "new-b", scored: null, last_finding_at: 50, created_at: 20 },
      { id: "old-version", scored: scored(800, "0"), last_finding_at: 10, created_at: 5 },
    ];
    expect(dueForScoring(rows).map((r) => r.id)).toEqual(["new-b", "new-a", "old-version", "stale-old", "stale-new"]);
  });

  test("the cap counts only the last 24 hours and pays for whole problems", () => {
    const now = 100 * 3_600_000;
    const spend = [{ at: now - 25 * 3_600_000, usd: 5 }, { at: now - 3_600_000, usd: 1.5 }];
    expect(spentToday(spend, now)).toBe(1.5);
    expect(affordable(spend, now, 0.004)).toBe(125);
    expect(affordable([{ at: now, usd: 2.1 }], now, 0.004)).toBe(0);
  });
});
