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
    const [what, next] = approvalLines(res);
    expect(what).toContain("a, b wait on a person's approval for this session (sd-1, sd-2)");
    expect(next).toContain(`cast state --status dormant "Waiting on sd-1, sd-2 to use a, b"`);
  });
});
