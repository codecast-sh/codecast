import { describe, expect, test } from "bun:test";
import { assignFamiliesPrompt, labelKey, parseAssignments, parseFamilies, parseProblemScore, problemFamiliesPrompt, problemScorePrompt, sampleFindings } from "./problemScore";

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
