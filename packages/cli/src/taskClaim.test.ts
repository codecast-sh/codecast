import { describe, expect, test } from "bun:test";
import { buildTaskStartBody } from "./taskClaim.js";

describe("buildTaskStartBody", () => {
  test("a human shell claims by assignee, with no session binding", () => {
    expect(buildTaskStartBody("ct-1", null)).toEqual({ short_id: "ct-1", status: "in_progress", assignee: "me" });
  });

  test("an agent session claims by session binding and never self-assigns the owner", () => {
    const body = buildTaskStartBody("ct-1", "sess-1");
    expect(body).toEqual({ short_id: "ct-1", status: "in_progress", conversation_id: "sess-1" });
    expect("assignee" in body).toBe(false);
  });
});

import {
  buildTaskHandoffBody,
  buildTaskVerdictBody,
  handoffCommentText,
  parseFilesFlag,
  parseHandoffStatus,
  parseReviewVerdict,
  verdictCommentText,
} from "./taskClaim.js";

describe("cast task handoff argument parsing", () => {
  test("a done handoff moves the task to in_review with evidence, files and the session binding", () => {
    const body = buildTaskHandoffBody("ct-9", "sess-1", {
      status: parseHandoffStatus("done"),
      evidence: "bun test green, 12 pass",
      files: parseFilesFlag("a.ts, b.ts,,"),
      pr: "https://github.com/o/r/pull/5",
    });
    expect(body).toEqual({
      short_id: "ct-9",
      status: "in_review",
      execution_status: "done",
      verification_evidence: "bun test green, 12 pass",
      files_changed: ["a.ts", "b.ts"],
      conversation_id: "sess-1",
    });
  });

  test("blocked and needs_context are the other two execution statuses; anything else is refused", () => {
    expect(buildTaskHandoffBody("ct-9", null, { status: "blocked", evidence: "x" }).execution_status).toBe("blocked");
    expect(buildTaskHandoffBody("ct-9", null, { status: "needs_context", evidence: "x" }).execution_status).toBe("needs_context");
    expect(() => parseHandoffStatus("in_review")).toThrow(/--status must be one of/);
    expect(() => parseHandoffStatus(undefined)).toThrow();
  });

  test("evidence is required; --files is optional and blanks are dropped", () => {
    expect(() => buildTaskHandoffBody("ct-9", null, { status: "done", evidence: "  " })).toThrow(/--evidence/);
    expect(parseFilesFlag(undefined)).toBeUndefined();
    expect(parseFilesFlag(" , ")).toBeUndefined();
    expect("files_changed" in buildTaskHandoffBody("ct-9", null, { status: "done", evidence: "ok" })).toBe(false);
  });

  test("the review comment carries status, evidence, files and PR", () => {
    expect(handoffCommentText({ status: "done", evidence: "ran it", files: ["a"], pr: "u" }))
      .toBe("Handoff: done\n\nran it\n\nFiles: a\n\nPR: u");
    expect(handoffCommentText({ status: "blocked", evidence: "no key" })).toBe("Handoff: blocked\n\nno key");
    // Pages attached as evidence (the-line.md L6) are listed for the reviewer.
    expect(handoffCommentText({ status: "done", evidence: "ran it", pages: ["Ab12", "Cd34"] }))
      .toBe("Handoff: done\n\nran it\n\nPages: /a/Ab12, /a/Cd34");
  });
});

describe("cast task verdict argument parsing", () => {
  test("approve closes, changes reopens to in_progress, reject reopens as blocked", () => {
    expect(buildTaskVerdictBody("ct-9", "sess-r", "approve", "all criteria met")).toEqual({
      short_id: "ct-9", status: "done", review_verdict: "approve", review_note: "all criteria met", conversation_id: "sess-r",
    });
    expect(buildTaskVerdictBody("ct-9", null, "changes")).toEqual({ short_id: "ct-9", status: "in_progress", review_verdict: "changes" });
    expect(buildTaskVerdictBody("ct-9", null, "reject")).toEqual({
      short_id: "ct-9", status: "open", review_verdict: "reject", execution_status: "blocked",
    });
  });

  test("only the three verdict words parse", () => {
    expect(parseReviewVerdict("approve")).toBe("approve");
    expect(() => parseReviewVerdict("approved")).toThrow(/verdict must be one of/);
  });

  test("the review comment leads with the verdict", () => {
    expect(verdictCommentText("changes", "step 2 unmet")).toBe("Verdict: changes\n\nstep 2 unmet");
    expect(verdictCommentText("approve")).toBe("Verdict: approve");
  });
});
