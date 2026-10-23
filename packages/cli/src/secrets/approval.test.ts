import { describe, expect, test } from "bun:test";
import { approvalLines, isNeedsApproval } from "./approval";

describe("approvalLines", () => {
  test("names every decision and the dormant line to end the turn with", () => {
    const res = {
      needs_approval: { decision: "sd-1", secret: "a" },
      approvals: [{ decision: "sd-1", secret: "a" }, { decision: "sd-2", secret: "b" }],
      message: "m",
    };
    expect(isNeedsApproval(res)).toBe(true);
    expect(isNeedsApproval({ secrets: [] })).toBe(false);
    const [what, hint, next] = approvalLines(res);
    expect(what).toContain("a, b wait on a person's approval for this session (sd-1, sd-2)");
    expect(hint).toContain('Add --why "…"');
    expect(next).toContain(`cast state --status dormant "Waiting on sd-1, sd-2 to use a, b"`);
  });

  test("a --why given says it reaches only a decision this read opened", () => {
    const res = { needs_approval: { decision: "sd-1", secret: "a" }, approvals: [], message: "m" };
    expect(approvalLines(res, "run the tests")[1]).toContain("keeps the question it opened with");
  });
});
