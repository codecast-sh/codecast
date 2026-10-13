import { describe, expect, test } from "bun:test";
import { causeDoubt, finderWords, lineWorkspaceTarget, resolveTraceRef, type TraceRows } from "../lineTrace";
import * as F from "./lineFixtures";

const rows: TraceRows = F.rows;

describe("resolveTraceRef", () => {
  test.each([
    ["ct-101", "cause", "task_a"],
    ["task_a", "cause", "task_a"],
    ["sg-a2", "signal", "sig_a2"],
    ["sig_a3", "signal", "sig_a3"],
    ["aw:c-42", "fingerprint", "sig_a2"],
    ["run_a", "run", "run_a"],
    ["sd-1", "decision", "dec_a1"],
    ["dec_a2", "decision", "dec_a2"],
  ])("%s resolves through its %s", (ref, via, focusId) => {
    const r = resolveTraceRef(ref, rows)!;
    expect(r.cause._id).toBe("task_a");
    expect(r).toMatchObject({ via, focusId });
  });

  test("a fingerprint only the cause row keeps", () => {
    const r = resolveTraceRef("aw:c-42", { ...rows, signals: [] })!;
    expect(r).toMatchObject({ via: "fingerprint", focusId: "task_a" });
  });

  test("a decision without a task finds it through its run", () => {
    const d = { ...F.decisionsA[0], task_id: undefined };
    expect(resolveTraceRef("sd-1", { ...rows, decisions: [d] })?.cause._id).toBe("task_a");
  });

  test("an unknown ref, or one whose cause the rows lack, is null", () => {
    expect(resolveTraceRef("ct-999", rows)).toBeNull();
    expect(resolveTraceRef("  ", rows)).toBeNull();
    expect(resolveTraceRef("sg-a1", { ...rows, tasks: [] })).toBeNull();
  });
});

describe("lineWorkspaceTarget: where a ref opens in the workspace", () => {
  test("a run opens Replay on it", () => {
    expect(lineWorkspaceTarget(resolveTraceRef("run_a", rows)!, rows)).toEqual({ run: "run_a", atCard: false });
  });

  test("a card opens Replay on the run that asked it, at the card", () => {
    expect(lineWorkspaceTarget(resolveTraceRef("sd-1", rows)!, rows)).toEqual({ run: "run_a", atCard: true });
  });

  test("a problem, a finding or a fingerprint opens the problem's Timeline", () => {
    for (const ref of ["ct-101", "sg-a2", "aw:c-42"]) expect(lineWorkspaceTarget(resolveTraceRef(ref, rows)!, rows)).toEqual({ run: null, atCard: false });
  });
});

describe("the finder's words, as a person reads them", () => {
  test("the finding drops markdown's marks", () => {
    expect(finderWords("## Finding\n**An intro reaches both people** (see `ex-1`, [cluster](https://x.test/c))", null)).toBe("An intro reaches both people (see ex-1, cluster)");
  });

  test("a finding that breaks an expectation says what the finder saw, not the expectation again", () => {
    const md = "**An intro reaches both people and says why they fit** (severity 7/10, ex-union-3)\n\nThe intro gave only titles and a vague overlap.";
    expect(finderWords(md, "ex-union-3")).toBe("The intro gave only titles and a vague overlap.");
  });

  test("a tally tail reads in words", () => {
    expect(finderWords("Both sides confirmed (severity 9/10, party_confidence)", null)).toBe("Both sides confirmed (severity 9 of 10)");
  });
});

describe("causeDoubt", () => {
  test("a ground or review note that reads the finding as another problem raises the doubt", () => {
    expect(causeDoubt({ readiness_note: "The signal may not match this cause." })?.words).toBe("The finding may not match this problem");
    expect(causeDoubt({ review_verdict: { verdict: "ok", note: "Not the same problem as the title says." } })?.why).toBe("Not the same problem as the title says.");
  });

  test("grounding that asks a person to confirm raises it; a ready cause does not", () => {
    expect(causeDoubt({ readiness: "needs_context" })?.words).toBe("Grounding asked a person to confirm this problem");
    expect(causeDoubt({ readiness: "ready", readiness_note: "Clear repro." })).toBeNull();
  });
});
