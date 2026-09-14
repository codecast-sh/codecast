import { describe, expect, test } from "bun:test";
import { briefCharterLines, briefHandLine } from "./briefLines";

// The brief's hand line reads the server's BriefHand shape: `state`, not
// `work_state` (the review caught every hand printing "undefined").
describe("briefHandLine", () => {
  test("prints the state, the task's handoff status and its review verdict", () => {
    const line = briefHandLine({ short_id: "jxhand1", title: "Fix the deploy", state: "working", task: { short_id: "ct-5", status: "in_review", execution_status: "done", review_verdict: "changes" } });
    expect(line).toContain("jxhand1");
    expect(line).toContain("· working");
    expect(line).toContain("ct-5 in_review (done) · review changes");
    expect(line).not.toContain("undefined");
  });
  test("a hand with no task prints its state alone", () => {
    const line = briefHandLine({ short_id: "jxhand2", title: "Spike", state: "idle", task: null });
    expect(line).toContain("· idle");
    expect(line).not.toContain("undefined");
  });
});

describe("briefCharterLines", () => {
  test("prints the charter body under its header, and says when there is none", () => {
    const lines = briefCharterLines("# Charter\nOwn the deploys.");
    expect(lines.some((l) => l.includes("## Charter"))).toBe(true);
    expect(lines).toContain("  Own the deploys.");
    expect(briefCharterLines("   ").some((l) => l.includes("no charter yet"))).toBe(true);
  });
});
