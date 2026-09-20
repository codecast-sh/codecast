import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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

import { groupTasksByAssignee, startedForRoleLine, startedLines } from "./taskClaim.js";
import { ASSIGNEE_MEANS } from "@codecast/shared/contracts/orgAssignee";
import { snippetSection } from "@codecast/shared/contracts";

describe("a role as assignee in the CLI (org-roles-run-work.md R5)", () => {
  test("task start says which role took the task, and says nothing otherwise", () => {
    expect(startedForRoleLine({ assigned_role: { handle: "growth", name: "Head of Growth" } }))
      .toBe("Assigned to @growth (Head of Growth), the role this session works for");
    expect(startedForRoleLine({})).toBeNull();
    expect(startedForRoleLine(null)).toBeNull();
  });

  test("what an assignee means (R7) reaches the agent at start and in the system text", () => {
    expect(ASSIGNEE_MEANS).toMatch(/never who may work on it/);
    expect(startedLines({})).toEqual([ASSIGNEE_MEANS]);
    expect(startedLines({ assigned_role: { handle: "growth", name: "Growth" } })[1]).toBe(ASSIGNEE_MEANS);
    expect(snippetSection("tasks").body).toContain(ASSIGNEE_MEANS);
  });

  test("--chain groups by assignee: the person first, then each role by handle, told apart by the contract's kind", () => {
    const role = (handle: string) => ({ kind: "role" as const, name: handle, handle, avatar: "fox" as any, role_id: handle, role_short_id: `or-${handle}` });
    const rows = [
      { short_id: "ct-3", assignee: "r2", assignee_name: "@seo", assignee_info: role("seo") },
      { short_id: "ct-1", assignee: "u1", assignee_name: "Ashot", assignee_info: { name: "Ashot" } },
      { short_id: "ct-2", assignee: "r1", assignee_name: "@ads", assignee_info: role("ads") },
      { short_id: "ct-4", assignee: "u1", assignee_name: "Ashot", assignee_info: { name: "Ashot" } },
      // A person whose display name starts with "@" is still a person.
      { short_id: "ct-5", assignee: "u2", assignee_name: "@dawn", assignee_info: { name: "@dawn" } },
    ];
    expect(groupTasksByAssignee(rows).map((g) => [g.label, g.role, g.tasks.map((t) => t.short_id)])).toEqual([
      ["@dawn", false, ["ct-5"]],
      ["Ashot", false, ["ct-1", "ct-4"]],
      ["@ads", true, ["ct-2"]],
      ["@seo", true, ["ct-3"]],
    ]);
  });
});

describe("the task verbs never guess the session", () => {
  // detectCurrentSessionId falls back to "the one transcript active in the
  // last five minutes". The server reads a session's role off the id it is
  // handed, so a person at a plain terminal would hand a task to a hand's role
  // (start) or be refused as a hand (verdict, done). These verbs read the
  // caller's own id or nothing.
  test("start, done, handoff, verdict and drop read ownSessionId, not detectCurrentSessionId", () => {
    const src = readFileSync(join(import.meta.dir, "index.ts"), "utf8");
    for (const verb of ["start", "done", "handoff", "verdict", "drop"]) {
      const at = src.indexOf(`work\n  .command("${verb}")`);
      expect(at, `work.command("${verb}") is defined`).toBeGreaterThan(-1);
      const action = src.slice(at, src.indexOf("\nwork\n", at + 1));
      expect(action.includes("detectCurrentSessionId("), `${verb} must not guess the session`).toBe(false);
      expect(action.includes("ownSessionId(getRealCwd())"), `${verb} reads the caller's own session`).toBe(true);
    }
  });
});
