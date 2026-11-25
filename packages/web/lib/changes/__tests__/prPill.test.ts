import { describe, expect, test } from "bun:test";
import { prPillLook } from "../prPill";
import { changeLifecycle } from "../lifecycle";
import { pullRequestFacts, type ChangePullRequest } from "../pullRequest";

const pr = (p: Partial<ChangePullRequest>): ChangePullRequest => ({ number: 1, state: "open", updated_at: 0, ...p });
const look = (p: Partial<ChangePullRequest>, reach?: "live" | "going_out" | "failed") => {
  const row = pr(p);
  const facts = { vehicle: { kind: "pr" as const, number: 1 }, ...pullRequestFacts(row) };
  const targets = reach ? [{ target: "web", state: reach }] : [];
  return prPillLook(row, changeLifecycle(reach ? { ...facts, reach: { state: reach, targets } as any } : facts));
};

describe("a pull request pill says its state in its glyph", () => {
  test("open, draft, merged and closed each wear their own glyph", () => {
    expect(look({}).glyph).toBe("open");
    expect(look({ draft: true }).glyph).toBe("draft");
    expect(look({ state: "merged", merged_at: 1 }).glyph).toBe("merged");
    expect(look({ state: "closed", closed_at: 1 }).glyph).toBe("closed");
  });

  test("a pull request that stopped moving dims; one still on its way does not", () => {
    expect(look({}).settled).toBe(false);
    expect(look({ state: "merged", merged_at: 1 }, "live").settled).toBe(true);
    expect(look({ state: "merged", merged_at: 1 }).settled).toBe(true);
    expect(look({ state: "closed", closed_at: 1 }).settled).toBe(true);
    expect(look({ state: "merged", merged_at: 1 }, "going_out").settled).toBe(false);
  });

  test("a red dot marks what broke or was sent back, and a broken one never dims", () => {
    expect(look({ mergeable_state: "dirty" }).alert).toBe(true);
    expect(look({ checks_state: "failure" }).alert).toBe(true);
    expect(look({ review_decision: "changes_requested" }).alert).toBe(true);
    expect(look({ checks_state: "pending" }).alert).toBe(false);
    const failed = look({ state: "merged", merged_at: 1 }, "failed");
    expect([failed.alert, failed.settled]).toEqual([true, false]);
  });

  test("the lifecycle's word stays for the label", () => {
    expect(look({ mergeable_state: "dirty" }).word).toBe("conflicts");
    expect(look({ state: "merged", merged_at: 1 }, "live").word).toBe("live");
  });
});
