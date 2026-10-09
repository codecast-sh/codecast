import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { READY_LIST_LIMIT, buildTaskClaimBody, buildTaskStartBody, foldStaleTasks, readyCountLine, startedLines, taskClaimant, taskHintBody, unclaimedLine } from "./taskClaim.js";
import { readTaskPulseFor, recordTaskStart } from "./taskPulse.js";
import { resolveTaskModelFull } from "./agents/prompts.js";
import { ASSIGNEE_MEANS } from "@codecast/shared/contracts/orgAssignee";

describe("buildTaskStartBody", () => {
  test("a human shell claims by assignee, with no session binding", () => {
    expect(buildTaskStartBody("ct-1", null)).toEqual({ short_id: "ct-1", status: "in_progress", assignee: "me" });
  });

  test("an agent session claims by session binding and never self-assigns the owner", () => {
    const body = buildTaskStartBody("ct-1", "sess-1");
    expect(body).toEqual({ short_id: "ct-1", status: "in_progress", conversation_id: "sess-1" });
    expect("assignee" in body).toBe(false);
  });

  test("--take asks the server to move ownership from a working session", () => {
    expect(buildTaskStartBody("ct-1", "sess-1", { take: true })).toMatchObject({ take: true });
    expect("take" in buildTaskStartBody("ct-1", "sess-1")).toBe(false);
  });
});

describe("task start names the sessions it took ownership from", () => {
  test("a working owner gets a tell-it line, a quiet one a plain note, both before the role line", () => {
    const lines = startedLines({ released_owners: [{ short_id: "jx7aaaa", live: true }, { short_id: "jx7bbbb", live: false }] });
    expect(lines[0]).toContain("cast send jx7aaaa");
    expect(lines[1]).toBe("Took ownership from jx7bbbb, which had gone quiet");
    expect(lines.at(-1)).toBe(ASSIGNEE_MEANS);
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

  test("a guide rides the update as change_guide and is named in the review comment", () => {
    const guide = { summary: "Data first.", steps: [{ title: "Store it", why: "The page reads it.", file: "a.ts", start: 3, end: 3, hunk: "@@ -1,1 +1,1 @@\n-a\n+b" }] };
    const input = { status: "done" as const, evidence: "ok", guide };
    expect(buildTaskHandoffBody("ct-9", null, input).change_guide).toEqual(guide);
    expect(handoffCommentText(input)).toContain("Guide: 1 step, on the task's evidence");
    expect("change_guide" in buildTaskHandoffBody("ct-9", null, { status: "done", evidence: "ok" })).toBe(false);
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

import { groupTasksByAssignee, startedForRoleLine } from "./taskClaim.js";
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

describe("cast task ready --claim and the execution hints (task-graph.md TG7-TG9)", () => {
  test("a claim is for the session, else the person; it never sends an assignee, which filters the frontier", () => {
    expect(taskClaimant("sess-1")).toEqual({ conversation_id: "sess-1" });
    expect(taskClaimant(null)).toEqual({ assignee: "me" });
    expect(buildTaskClaimBody({ plan_id: "pl-1" }, "sess-1")).toEqual({ plan_id: "pl-1", conversation_id: "sess-1" });
    expect(buildTaskClaimBody({ plan_id: "pl-1" }, null, { stale: true })).toEqual({ plan_id: "pl-1", stale: true });
  });

  test("a claim that took nothing says when more ready tasks wait past those tried", () => {
    expect(unclaimedLine({ skipped: [] })).toBe("No ready tasks to claim.");
    expect(unclaimedLine({ skipped: [{}, {}], more: true })).toMatch(/^No task claimed, passed over 2\. More ready tasks exist/);
    expect(unclaimedLine({ skipped: [], stale_passed: 3 })).toBe("No ready tasks to claim. 3 untouched 30+ days passed over (claim with --stale).");
    expect(unclaimedLine({ skipped: [], others_passed: 2 })).toBe("No ready tasks to claim. 2 ready tasks are assigned to others or held by a decision (cast task ready lists them).");
    // Both counts on both wordings: the path where candidates were left
    // untried is exactly where an autopilot judges whether the queue is
    // workable, so withholding whose the rest are there would be the worst
    // place to withhold it.
    expect(unclaimedLine({ skipped: [{}], more: true, stale_passed: 1, others_passed: 2 }))
      .toBe("No task claimed, passed over 1. More ready tasks exist past those tried: narrow with --plan, --project or -q. 1 untouched 30+ days passed over (claim with --stale). 2 ready tasks are assigned to others or held by a decision (cast task ready lists them).");
    // The count is of rows THIS scope returned, so the command that lists them
    // keeps the scope (readScopeFlags): bare, run from a checkout mapped
    // elsewhere, it answers about other work entirely.
    expect(unclaimedLine({ skipped: [], others_passed: 1 }, " --team Codecast -q graph"))
      .toBe("No ready tasks to claim. 1 ready task is assigned to others or held by a decision (cast task ready --team Codecast -q graph lists them).");
  });

  test("a start records the pulse and binds the plan whatever the output mode", async () => {
    const dir = mkdtempSync(join(tmpdir(), "claim-pulse-"));
    const prev = process.env.CODECAST_DIR;
    process.env.CODECAST_DIR = dir;
    try {
      const binds: string[][] = [];
      expect(await recordTaskStart("sess-1", "ct-7", "pl-2", async (plan, session) => { binds.push([plan, session]); })).toBe("pl-2");
      expect(readTaskPulseFor("sess-1")).toEqual({ task: "ct-7", plan: "pl-2", started: true });
      expect(binds).toEqual([["pl-2", "sess-1"]]);
      // A failed bind keeps the pulse; a person's start has no session to record.
      expect(await recordTaskStart("sess-2", "ct-8", "pl-3", async () => { throw new Error("offline"); })).toBeNull();
      expect(readTaskPulseFor("sess-2")).toEqual({ task: "ct-8", plan: "pl-3", started: true });
      expect(await recordTaskStart(null, "ct-9", undefined, async () => {})).toBeNull();
    } finally {
      if (prev === undefined) delete process.env.CODECAST_DIR;
      else process.env.CODECAST_DIR = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("ready --claim --json records the start before printing it", () => {
    // Agents claim with --json, and the pulse is how a session finds its task
    // again after compaction (TG10): the JSON path must not skip it.
    const src = readFileSync(join(import.meta.dir, "index.ts"), "utf8");
    const at = src.indexOf(`work\n  .command("ready")`);
    expect(at).toBeGreaterThan(-1);
    const action = src.slice(at, src.indexOf("\nwork\n", at + 1));
    const json = action.slice(action.indexOf("if (options.json)"));
    const started = json.indexOf("afterTaskStarted(");
    expect(started).toBeGreaterThan(-1);
    expect(started).toBeLessThan(json.indexOf("printJson(claim)"));
  });

  test("--effort is checked by name and '' clears; --ephemeral only ever sets", () => {
    expect(taskHintBody({ model: "sonnet", effort: "xhigh", ephemeral: true })).toEqual({ model: "sonnet", effort: "xhigh", ephemeral: true });
    expect(taskHintBody({ effort: "", model: "" })).toEqual({ effort: "", model: "" });
    expect(taskHintBody({})).toEqual({});
    expect(() => taskHintBody({ effort: "huge" })).toThrow(/Unknown --effort "huge"/);
  });

  test("stale rows fold into a count unless --stale", () => {
    const rows = [{ id: 1 }, { id: 2, stale: true }, { id: 3, stale: false }];
    expect(foldStaleTasks(rows, false)).toEqual({ shown: [{ id: 1 }, { id: 3, stale: false }], folded: 1 });
    expect(foldStaleTasks(rows, true)).toEqual({ shown: rows, folded: 0 });
  });

  test("a frontier cut at the list limit reports floors, not counts", () => {
    expect(readyCountLine(2, 1, 3)).toBe("2 ready, 1 more untouched 30+ days (--stale lists them)");
    expect(readyCountLine(4, 0, 4)).toBe("4 ready");
    expect(readyCountLine(290, 10, READY_LIST_LIMIT)).toBe("290+ ready, 10+ more untouched 30+ days (--stale lists them)");
    // Every ready task folded away: the count IS the whole output (no rows
    // above it), so it says where to go, and words the folded rows as ready
    // rather than as "more" than a zero count.
    expect(readyCountLine(0, 182, 182)).toBe("All 182 ready tasks here are untouched 30+ days: cast task ready --stale lists them, --stale --claim takes one.");
    expect(readyCountLine(0, 1, 1)).toBe("The one ready task here is untouched 30+ days: cast task ready --stale lists it, --stale --claim takes it.");
    expect(readyCountLine(0, 300, READY_LIST_LIMIT)).toBe("All 300+ ready tasks here are untouched 30+ days: cast task ready --stale lists them, --stale --claim takes one.");
    expect(readyCountLine(0, 0, 0)).toBe("0 ready");
    // The pointer keeps the read's own filters, for the reason every other
    // printed read does (readScopeFlags).
    expect(readyCountLine(0, 2, 2, " -p 'Codecast: Product'"))
      .toBe("All 2 ready tasks here are untouched 30+ days: cast task ready -p 'Codecast: Product' --stale lists them, --stale --claim takes one.");
  });

  test("a task's own effort wins over the plan stylesheet's; a model alone keeps none", () => {
    const plan = { model_stylesheet: "* { model: sonnet; reasoning_effort: low; }" };
    expect(resolveTaskModelFull(plan, { effort: "max" })).toMatchObject({ model: "sonnet", reasoning_effort: "max" });
    expect(resolveTaskModelFull(plan, {})).toMatchObject({ model: "sonnet", reasoning_effort: "low" });
    expect(resolveTaskModelFull({}, { model: "opus", effort: "high" })).toMatchObject({ model: "opus", reasoning_effort: "high" });
  });
});
