import { describe, expect, test } from "bun:test";
import { buildForkSeedBody, previewDirection } from "./forkSeed";

// Regression for the duplicate-fleet incident: forks inherited the parent's
// "I will launch N forks" history, got restarted, and resumed as orchestrators
// launching their own fleets. The seed body is the branch's tail-of-transcript
// contract that prevents this — it must survive restarts because it is part of
// the transcript itself.

const roster = [
  { short_id: "jx7aaa1", direction: "Explore discussion depth ranking" },
  { short_id: "jx7bbb2", direction: "Freshness and timeline UX" },
  { short_id: "jx7ccc3", direction: "Line one of a long brief\nLine two with detail" },
];

describe("buildForkSeedBody fan-out", () => {
  test("names the branch's own direction in full", () => {
    const body = buildForkSeedBody(2, roster);
    expect(body).toContain("Line one of a long brief\nLine two with detail");
  });

  test("lists every sibling with its short id, not itself", () => {
    const body = buildForkSeedBody(0, roster);
    expect(body).toContain("jx7bbb2 — Freshness and timeline UX");
    expect(body).toContain("jx7ccc3 — Line one of a long brief");
    expect(body).not.toContain("jx7aaa1 —");
  });

  test("states the fan-out already ran and forbids re-orchestration", () => {
    const body = buildForkSeedBody(1, roster);
    expect(body).toContain("that plan already ran");
    expect(body).toContain("Do not fork, spawn, or coordinate siblings");
    expect(body).toContain("restart");
  });

  test("sibling rows collapse multi-line directions to their first line", () => {
    const body = buildForkSeedBody(0, roster);
    expect(body).not.toContain("Line two with detail");
  });
});

describe("buildForkSeedBody single branch", () => {
  test("frames the fork without a sibling roster or fleet language", () => {
    const body = buildForkSeedBody(0, [roster[0]]);
    expect(body).toContain("Explore discussion depth ranking");
    expect(body).toContain("The parent thread continues separately");
    expect(body).not.toContain("Sibling branches");
  });
});

describe("previewDirection", () => {
  test("takes the first non-empty line and truncates long ones", () => {
    expect(previewDirection("\n\n  headline  \nrest")).toBe("headline");
    const long = "x".repeat(200);
    const preview = previewDirection(long);
    expect(preview.length).toBe(120);
    expect(preview.endsWith("…")).toBe(true);
  });
});
