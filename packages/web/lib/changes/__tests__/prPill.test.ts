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

  test("the lifecycle's word stays for the label", () => {
    expect(look({ mergeable_state: "dirty" }).word).toBe("conflicts");
    expect(look({ state: "merged", merged_at: 1 }, "live").word).toBe("live");
  });
});
