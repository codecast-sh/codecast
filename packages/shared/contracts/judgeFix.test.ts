import { describe, expect, test } from "bun:test";
import { fisherOneSided, judgeFixGroup, judgeFixVerdict, validateJudgeFixCard } from "./judgeFix";
import { isJudgeCaseKey, isJudgeProblem } from "./judgeReview";

describe("a problem of cases against a judge takes the judge route", () => {
  test("every key it gathers is a case key: by part, by expectation, or a split of one", () => {
    expect(isJudgeProblem({ issue_key: "judge:codecast:call", fingerprints: ["judge:codecast:call"] })).toBe(true);
    expect(isJudgeProblem({ fingerprints: ["extractor:union-moments:contact-conversation"] })).toBe(true);
    expect(isJudgeProblem({ fingerprints: ["judge:codecast:comms:stale-fee-line"] })).toBe(true);
    expect(isJudgeProblem({ fingerprints: ["expectation:codecast:ex-agentwatch-trial-8"] })).toBe(true);
    expect(isJudgeProblem({ fingerprints: ["evidence:contacts/x:ex-agentwatch-trial-3:f369ff45"] })).toBe(false);
    expect(isJudgeProblem({ fingerprints: ["judge:codecast:comms", "evidence:contacts/x:ex-3:aa"] })).toBe(false);
    expect(isJudgeProblem({ fingerprints: [] })).toBe(false);
    expect(isJudgeProblem(undefined)).toBe(false);
    expect(isJudgeCaseKey("aw:cluster-12")).toBe(false);
  });
});

describe("the judge route's A/B", () => {
  test("Fisher's exact test, one-sided: 15 of 15 found before and 0 of 15 after is separated; 2 of 15 and 1 of 15 is not", () => {
    expect(fisherOneSided(0, 15, 15, 15, "less")!).toBeLessThan(1e-6);
    expect(fisherOneSided(1, 15, 2, 15, "less")!).toBeGreaterThan(0.4);
    expect(fisherOneSided(3, 10, 3, 10, "less")).toBeNull();
  });

  test("better only when the ruled cases separate and the kept findings do not drop", () => {
    const ruled = judgeFixGroup(3, 15, 14, 1, "fewer");
    expect(judgeFixVerdict(ruled, judgeFixGroup(10, 50, 40, 39, "more"))).toBe("better");
    expect(judgeFixVerdict(ruled, judgeFixGroup(10, 50, 40, 20, "more"))).toBe("worse");
    expect(judgeFixVerdict(judgeFixGroup(3, 15, 4, 3, "fewer"), judgeFixGroup(10, 50, 40, 40, "more"))).toBe("not_separated");
  });

  test("a card names its problem, question, change, part, diff, measurement and cases", () => {
    expect(validateJudgeFixCard({ kind: "judge_fix" })).toMatchObject({ ok: false });
    const ok = validateJudgeFixCard({
      kind: "judge_fix", problem: "ct-59527", question: "Publish this change to the contact-conversation extractor?", change: "Emails are shown whole.",
      part: { against: "extractor", name: "the contact-conversation extractor", file: ".codecast/moments/contact-conversation.ts" },
      diff: [{ file: ".codecast/moments/contact-conversation.ts", removed: ["const EMAIL_BODY_CAP = 2000;"], added: ["const EMAIL_BODY_CAP = 8000;"] }],
      ab: { reps: 5, model: "m", cost_usd: 4, ruled: judgeFixGroup(3, 15, 14, 1, "fewer"), controls: judgeFixGroup(10, 50, 40, 39, "more"), verdict: "better" },
      cases: [{ finding: "sg-2562", moment: "mo-1", expectation: "ex-3", said: "x", correct: "y", base: 5, arm: 0, reps: 5 }],
    });
    expect(ok.ok).toBe(true);
  });
});
