import { describe, expect, test } from "bun:test";
import { deadEndWords, failReasonWords, lineCommentWords } from "./lineWords";
import { groundedWords, needsWords } from "./goalsBrief";

describe("the line's notes in plain words (learning-loop.md LL6)", () => {
  test("a station that finished with no route after it", () => {
    expect(failReasonWords("no outgoing edge from prove (outcome success, review_verdict none)", (id) => id === "prove" ? "Prove" : id))
      .toBe("Prove finished, and the line had no next step for it. The problem is open again.");
    expect(failReasonWords("hand jx79c63 killed after 30m at dissolve"))
      .toBe("Dissolve ran out of time after 30 minutes and was stopped. The problem is open again.");
    expect(lineCommentWords("Workflow failed (hand jx79c63 killed after 30m at dissolve); task returned to open."))
      .toBe("Dissolve ran out of time after 30 minutes and was stopped. The problem is open again.");
    expect(lineCommentWords("The run stopped: hand jx79c63 killed after 30m at dissolve. The problem is open again."))
      .toBe("Dissolve ran out of time after 30 minutes and was stopped. The problem is open again.");
    expect(lineCommentWords("The run stopped: the runner lost its machine. The problem is open again."))
      .toBe("The run stopped: the runner lost its machine. The problem is open again.");
    expect(deadEndWords("Investigate", "failure")).toBe("Investigate failed, and the line had no next step for it. The problem is open again.");
  });

  test("an old comment reads in today's words and keeps the body under its summary", () => {
    expect(lineCommentWords("Workflow failed (no outgoing edge from prove (outcome success, review_verdict none)); task returned to open.\n\nProve session: jx7"))
      .toBe("Prove finished, and the line had no next step for it. The problem is open again.\n\nProve session: jx7");
    expect(lineCommentWords("Grounded: goal Agent Quality, code, risk plan, ready."))
      .toBe("Grounded: serves Agent Quality. Needs a code change; the plan should be approved first. Ready to build.");
    expect(lineCommentWords("A person's note.\n\nWith a second paragraph.")).toBe("A person's note.\n\nWith a second paragraph.");
  });

  test("what a problem needs, and the ground note", () => {
    expect(needsWords("code", "plan")).toBe("A code change; the plan should be approved first");
    expect(needsWords("prompt", "low")).toBe("A prompt change");
    expect(groundedWords({ goal_ref: "none", category: "data", risk: "review", readiness: "needs_context" }))
      .toBe("Grounded: serves no goal in the brief. Needs a data fix; the change should be reviewed before it ships. Needs more context first.");
  });
});
