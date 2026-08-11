import { describe, expect, test } from "bun:test";
import { buildForkSeedBody } from "./forkSeed";

// Regression for the duplicate-fleet incident: forks inherited the parent's
// "I will launch N forks" history, got restarted, and resumed as orchestrators
// launching their own fleets. The seed body is the branch's tail-of-transcript
// contract that prevents this — it must survive restarts because it is part of
// the transcript itself.

const directions = [
  "Explore discussion depth ranking",
  "Freshness and timeline UX",
  "Line one of a long brief\nLine two with detail",
];

describe("buildForkSeedBody fan-out", () => {
  test("names the branch's own direction in full, including multi-line briefs", () => {
    const body = buildForkSeedBody(2, directions);
    expect(body).toContain("Line one of a long brief\nLine two with detail");
  });

  test("states the fan-out already ran and forbids re-orchestration", () => {
    const body = buildForkSeedBody(1, directions);
    expect(body).toContain("split into 3 independent parallel branches");
    expect(body).toContain("that plan already ran");
    expect(body).toContain("Do not fork, spawn, or coordinate");
    expect(body).toContain("restart");
  });

  test("branches stay independent: no sibling directions or ids in the seed", () => {
    const body = buildForkSeedBody(0, directions);
    expect(body).not.toContain("Freshness and timeline UX");
    expect(body).not.toContain("Line one of a long brief");
  });
});

describe("buildForkSeedBody single branch", () => {
  test("frames the fork without fleet language", () => {
    const body = buildForkSeedBody(0, [directions[0]]);
    expect(body).toContain("Explore discussion depth ranking");
    expect(body).toContain("The parent thread continues separately");
    expect(body).not.toContain("fan-out");
  });
});
