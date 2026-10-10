// Improving a judge (learning-loop.md LL11), against the real schema: a wrong
// finding waits for its line, a diagnosis run starts as a hand of the role
// that leads its project, and the answer files a case against the part of
// the judge at fault, gathering every case against one part into one problem.
import { describe, expect, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { api } from "./_generated/api";
import { hashToken } from "./apiTokens";
import { findingLabeled, markFindingWrong, sweepJudgeReviews } from "./judgeReview";
import { JUDGE_REVIEW_ATTEMPTS, JUDGE_REVIEW_GRAPH } from "@codecast/shared/contracts/judgeReview";

const TOKEN = "cast_judge_review_token";
const T0 = Date.now();

async function setup(o: { lineOn?: boolean } = {}) {
  const t = convexTest(schema, {
    "./_generated/server.ts": () => import("./_generated/server"),
    "./syncOutbox.ts": () => import("./syncOutbox"),
    "./signals.ts": () => import("./signals"),
    "./judgeReview.ts": () => import("./judgeReview"),
    "./notificationRouter.ts": () => import("./notificationRouter"),
  });
  const ids = await t.run(async (ctx) => {
    const user = await ctx.db.insert("users", { name: "Ana" } as any);
    await ctx.db.insert("api_tokens", { user_id: user, token_hash: await hashToken(TOKEN), name: "cli", created_at: T0, last_used_at: T0 } as any);
    const ws = `user:${user}`;
    const standing = await ctx.db.insert("conversations", { session_id: "standing", user_id: user, status: "active", title: "Quality lead", agent_type: "claude_code", message_count: 1, project_path: "/src/union", updated_at: T0 } as any);
    const anchor = await ctx.db.insert("anchors", { bot_user_id: user, host_user_id: user, conversation_id: standing } as any);
    const role = await ctx.db.insert("org_roles", {
      short_id: "or-1", scope_type: "personal", scope_user_id: user, host_user_id: user, name: "Quality lead", handle: "quality",
      scope: { project_ids: [], plan_ids: [] }, reports_to: { kind: "user", user_id: user }, status: "active",
      trust: o.lineOn ? "direct" : "understand", anchor_id: anchor,
      caps: { hands_per_day: 5, wakes_per_day: 10, tokens_per_day: 1_000_000, line_on: !!o.lineOn },
      created_by: user, created_at: T0, updated_at: T0,
    } as any);
    const project = await ctx.db.insert("projects", { user_id: user, workspace: ws, short_id: "pr-1", title: "Agent Quality", status: "active", owner_role_id: role, created_at: T0, updated_at: T0 } as any);
    // The problem the product's finding was filed on (LL3): one AgentWatch issue.
    const problem = await ctx.db.insert("tasks", { user_id: user, workspace: ws, short_id: "ct-100", title: "Not met: calls connect when scheduled", status: "open", priority: "medium", blocks: [], source: "signal", project_id: project, cause: { signal_count: 2, first_seen: T0, last_seen: T0, fingerprints: ["union:cluster:97"], issue_key: "union:cluster:97" }, attempt_count: 0, retry_count: 0, max_retries: 3, created_at: T0, updated_at: T0 } as any);
    const finding = (n: number, extra: Record<string, any> = {}) => ctx.db.insert("signals", {
      user_id: user, workspace: ws, short_id: `sg-10${n}`, source: "agentwatch", kind: "prompt_miss", fingerprint: "union:cluster:97",
      title: `Scheduled call ${n} went to voicemail`, detail_md: `Union finding 2a3bef0b-${n}: the call framed as a scheduled meeting failed to connect.`,
      evidence_url: `https://union.example/admin/agent-watch?finding=2a3bef0b-${n}`, subject: "ex-comms-4",
      observed_at: T0, created_at: T0, task_id: problem, project_id: project, attach: "fingerprint", judge: "comms", judge_version: "7", severity: 6, ...extra,
    } as any);
    const f1 = await finding(1);
    const f2 = await finding(2);
    const f3 = await finding(3);
    const report = await ctx.db.insert("signals", { user_id: user, workspace: ws, short_id: "sg-109", source: "person", kind: "bug", fingerprint: "person:x", title: "A person's report", observed_at: T0, created_at: T0, task_id: problem, project_id: project, attach: "person" } as any);
    return { user, role, project, problem, f1, f2, f3, report };
  });
  const get = (id: any) => t.run(async (ctx) => await ctx.db.get(id)) as Promise<any>;
  const mark = (id: any, extra: Record<string, any> = {}) => t.run(async (ctx) => await markFindingWrong(ctx, (await ctx.db.get(id))!, { trigger: "label", by: ids.user, now: Date.now(), ...extra }));
  const diagnose = (signal: string, answer: string, fact?: string, why?: string) =>
    t.mutation((api as any).judgeReview.diagnosisForCli, { api_token: TOKEN, signal, answer, ...(fact ? { fact } : {}), ...(why ? { why } : {}) });
  const lineOn = () => t.run(async (ctx) => { await ctx.db.patch(ids.role, { trust: "direct", caps: { hands_per_day: 5, wakes_per_day: 10, tokens_per_day: 1_000_000, line_on: true } } as any); });
  return { t, ...ids, get, mark, diagnose, lineOn };
}

describe("marking a finding wrong", () => {
  test("waits, saying why, while the project's line is off; the sweep starts its diagnosis once the line is on", async () => {
    const s = await setup();
    const review = await s.mark(s.f1, { note: "There was no scheduled meeting; the rep's voicemail only said so." });
    expect(review).toMatchObject({ trigger: "label", state: "waiting", attempts: 0, note: "There was no scheduled meeting; the rep's voicemail only said so." });
    expect(review.waiting_on).toMatch(/^The line for .* is off; the diagnosis starts once "Start problems on their own" is on\.$/);
    expect(await s.t.run(async (ctx) => await ctx.db.query("workflow_runs").collect())).toHaveLength(0);

    await s.lineOn();
    expect(await s.t.run(async (ctx) => await sweepJudgeReviews(ctx, Date.now()))).toMatchObject({ started: 1 });
    const f = await s.get(s.f1);
    expect(f.judge_review).toMatchObject({ state: "diagnosing", attempts: 1 });
    expect(f.judge_review.waiting_on).toBeUndefined();
    const run = await s.get(f.judge_review.diagnosis_run_id);
    // A run of the shipped graph, as the role, on its seat, with the finding as its goal and no task of its own.
    expect(run).toMatchObject({ workflow_name: JUDGE_REVIEW_GRAPH, goal_override: "sg-101", project_path: "/src/union", status: "pending" });
    expect(run.task_id).toBeUndefined();
    const commands = await s.t.run(async (ctx) => await ctx.db.query("daemon_commands").collect());
    expect(commands.map((c: any) => JSON.parse(c.args))).toEqual([{ workflow_run_id: run._id, workflow_slug: JUDGE_REVIEW_GRAPH }]);
    // The diagnosis is a hand of the role.
    expect((await s.get(s.role)).counters.hands).toBe(1);
  });

  test("refuses a finding no judge made, and a second mark keeps the review with the newer words", async () => {
    const s = await setup();
    await expect(s.mark(s.report)).rejects.toThrow(/not made by a judge/);
    await s.mark(s.f1, { note: "first" });
    const again = await s.mark(s.f1, { note: "second" });
    expect(again).toMatchObject({ state: "waiting", note: "second" });
  });

  test("a label taken back before the diagnosis starts clears the mark; a right label leaves a diagnosed one alone", async () => {
    const s = await setup();
    await s.t.run(async (ctx) => await findingLabeled(ctx, s.f1, { verdict: "wrong", by: s.user, now: Date.now() }));
    expect((await s.get(s.f1)).judge_review.state).toBe("waiting");
    await s.t.run(async (ctx) => await findingLabeled(ctx, s.f1, { verdict: "right", by: s.user, now: Date.now() }));
    expect((await s.get(s.f1)).judge_review).toBeUndefined();
  });
});

describe("recording a diagnosis", () => {
  test("misread files a case against the judge: one problem per judge, titled for it, gathering every misread case", async () => {
    const s = await setup({ lineOn: true });
    await s.mark(s.f1);
    await s.mark(s.f2);
    const a = await s.diagnose("sg-101", "misread", "No meeting had been scheduled with this contact.", "The judge's input shows only outbound attempts; the rep's own voicemail invented the meeting.");
    const b = await s.diagnose("sg-102", "misread", "The call was a cold dial.");
    expect(a.task_short_id).toBe(b.task_short_id);
    expect(a.task_short_id).not.toBe("ct-100");

    const caseRow = await s.t.run(async (ctx) => await ctx.db.query("signals").withIndex("by_short_id", (q) => q.eq("short_id", a.case_short_id)).first()) as any;
    expect(caseRow).toMatchObject({ source: "judge-review", kind: "prompt_miss", fingerprint: "judge:agentwatch:comms", subject: "judge:agentwatch:comms", judge: "comms", judge_version: "7", case_of: s.f1, project_id: s.project, evidence_url: "https://union.example/admin/agent-watch?finding=2a3bef0b-1" });
    expect(caseRow.detail_md).toContain("Scheduled call 1 went to voicemail (sg-101)");
    expect(caseRow.detail_md).toContain("in what it saw, and it misread it");
    expect(caseRow.detail_md).toContain("The fact: No meeting had been scheduled with this contact.");

    const judgeProblem = await s.get(caseRow.task_id);
    expect(judgeProblem).toMatchObject({ title: "The comms judge misreads what it is shown", source: "signal", project_id: s.project });
    expect(judgeProblem.cause).toMatchObject({ issue_key: "judge:agentwatch:comms", signal_count: 2 });

    const f = await s.get(s.f1);
    expect(f.judge_review).toMatchObject({ state: "diagnosed", answer: "misread", against: "judge", case_id: caseRow._id, fact: "No meeting had been scheduled with this contact." });
    // The finding stays on its problem, which hears where it went.
    expect(f.task_id).toBe(s.problem);
    const notes = await s.t.run(async (ctx) => await ctx.db.query("task_comments").withIndex("by_task_id", (q: any) => q.eq("task_id", s.problem)).collect()) as any[];
    expect(notes.map((n) => n.text)).toContain(`sg-101 was the comms judge's mistake (it misread what it saw). It is a case on ${a.task_short_id}.`);
  });

  test("missing files against the judge's input (bring findings) or the moment's extractor (bring moments), each its own problem", async () => {
    const s = await setup({ lineOn: true });
    const moment = await s.t.run(async (ctx) => {
      const source = await ctx.db.insert("event_sources", { name: "union-app", kind: "custom", workspace: `user:${s.user}`, user_id: s.user, created_at: T0 } as any);
      await ctx.db.insert("moments", { workspace: `user:${s.user}`, source_id: source, short_id: "mo-4", kind: "contact_thread", subject: "contact:1", status: "extracted", events: 1, first_event_at: T0, event_at: T0, due_at: T0, attempts: 1 } as any);
      await ctx.db.patch(s.f3, { source: "judge:comms", moment: "mo-4" } as any);
      return source;
    });
    expect(moment).toBeTruthy();
    await s.mark(s.f2);
    await s.mark(s.f3);
    const input = await s.diagnose("sg-102", "missing", "The call log shows the contact never agreed to a time.");
    const extractor = await s.diagnose("sg-103", "missing", "Whether the meeting was booked in the calendar.");
    expect(input.task_short_id).not.toBe(extractor.task_short_id);
    const rows = await s.t.run(async (ctx) => await ctx.db.query("signals").collect()) as any[];
    const byShort = (id: string) => rows.find((r) => r.short_id === id);
    expect(byShort(input.case_short_id)).toMatchObject({ fingerprint: "judge-input:agentwatch:comms", kind: "bug" });
    expect(byShort(extractor.case_short_id)).toMatchObject({ fingerprint: "extractor:union-app:contact_thread", kind: "bug", moment: "mo-4" });
    expect((await s.get(byShort(input.case_short_id).task_id)).title).toBe("The comms judge is not shown a fact it needs");
    expect((await s.get(byShort(extractor.case_short_id).task_id)).title).toBe("The contact_thread moments leave out facts a judge needs");
    expect((await s.get(s.f3)).judge_review).toMatchObject({ answer: "missing", against: "extractor" });
  });

  test("upheld files no case; recording twice files nothing new; a finding never marked is refused", async () => {
    const s = await setup({ lineOn: true });
    await expect(s.diagnose("sg-101", "misread")).rejects.toThrow(/has not been marked wrong/);
    await s.mark(s.f1);
    const held = await s.diagnose("sg-101", "upheld", undefined, "The contact had booked the call through Calendly.");
    expect(held.case_short_id).toBe("");
    expect((await s.get(s.f1)).judge_review).toMatchObject({ state: "diagnosed", answer: "upheld" });
    expect(held.review.against).toBeUndefined();

    await s.mark(s.f2);
    const first = await s.diagnose("sg-102", "misread");
    const again = await s.diagnose("sg-102", "missing");
    expect(again.case_short_id).toBe(first.case_short_id);
    const cases = await s.t.run(async (ctx) => (await ctx.db.query("signals").collect()).filter((r: any) => r.case_of)) as any[];
    expect(cases).toHaveLength(1);
  });
});

describe("recording a diagnosis once", () => {
  test("an upheld diagnosis recorded again adds no second note, and a later answer files no case", async () => {
    const s = await setup({ lineOn: true });
    await s.mark(s.f1);
    await s.diagnose("sg-101", "upheld", undefined, "The contact had booked the call.");
    await s.diagnose("sg-101", "upheld", undefined, "The contact had booked the call.");
    const after = await s.diagnose("sg-101", "misread", "Something else.");
    expect(after.case_short_id).toBe("");
    const notes = await s.t.run(async (ctx) => await ctx.db.query("task_comments").withIndex("by_task_id", (q: any) => q.eq("task_id", s.problem)).collect()) as any[];
    expect(notes.filter((n) => n.text.includes("sg-101 was marked wrong"))).toHaveLength(1);
    const cases = await s.t.run(async (ctx) => (await ctx.db.query("signals").collect()).filter((r: any) => r.case_of)) as any[];
    expect(cases).toHaveLength(0);
    expect((await s.get(s.f1)).judge_review).toMatchObject({ state: "diagnosed", answer: "upheld" });
  });
});

describe("the sweep is fair across lines", () => {
  test("many findings waiting on a line that is off never hold back a line that is on", async () => {
    const s = await setup();
    // 60 wrong findings wait on Agent Quality, whose line is off.
    await s.t.run(async (ctx) => {
      const f1 = (await ctx.db.get(s.f1))!;
      const { _id, _creationTime, ...base } = f1 as any;
      for (let i = 0; i < 60; i++) {
        await ctx.db.insert("signals", { ...base, short_id: `sg-5${i}`, judge_review: { trigger: "label", at: T0, state: "waiting", attempts: 0 } } as any);
      }
    });
    // A second project, led by a role whose line is on, has one waiting finding filed after them.
    const other = await s.t.run(async (ctx) => {
      const role = (await ctx.db.get(s.role))! as any;
      const { _id, _creationTime, ...r } = role;
      const onRole = await ctx.db.insert("org_roles", { ...r, short_id: "or-2", handle: "calls", trust: "direct", caps: { ...r.caps, line_on: true } } as any);
      const project = await ctx.db.insert("projects", { user_id: s.user, workspace: `user:${s.user}`, short_id: "pr-2", title: "Calls", status: "active", owner_role_id: onRole, created_at: T0, updated_at: T0 } as any);
      const f1 = (await ctx.db.get(s.f1))! as any;
      const { _id: _f, _creationTime: _c, ...base } = f1;
      return await ctx.db.insert("signals", { ...base, short_id: "sg-900", project_id: project, task_id: undefined, judge_review: { trigger: "label", at: T0, state: "waiting", attempts: 0 } } as any);
    });
    const out = await s.t.run(async (ctx) => await sweepJudgeReviews(ctx, Date.now()));
    expect(out.started).toBe(1);
    expect((await s.get(other)).judge_review.state).toBe("diagnosing");
  });
});

describe("the dissolve hand off and the sweep", () => {
  test("judge-defects marks each finding by its signal id, or by the product's id the prove station copied, on the run's cause", async () => {
    const s = await setup();
    const runId = await s.t.run(async (ctx) => await ctx.db.insert("workflow_runs", { user_id: s.user, task_id: s.problem, status: "running", node_statuses: [], created_at: T0, updated_at: T0, workspace: `user:${s.user}` } as any));
    const out = await s.t.mutation((api as any).judgeReview.defectsForCli, {
      api_token: TOKEN,
      run_id: String(runId),
      defects: [
        { finding: "sg-101", judge: "comms", sentence: "The reply reports no problem about a call reaching voicemail.", name: "C97 voicemail" },
        { finding: "2a3bef0b-2", judge: "comms", sentence: "The reply reports no problem about repeated dials." },
        { finding: "sg-109" },
        { finding: "nothing-like-this" },
      ],
    });
    expect(out.map((r: any) => [r.short_id ?? r.finding, r.state ?? r.skipped])).toEqual([
      ["sg-101", "waiting"], ["sg-102", "waiting"], ["sg-109", "not a judge's finding"], ["nothing-like-this", "no such finding"],
    ]);
    expect((await s.get(s.f1)).judge_review).toMatchObject({ trigger: "dissolve", run_id: runId, sentence: "The reply reports no problem about a call reaching voicemail." });
  });

  test("a diagnosis run that ended without an answer goes back to waiting, and fails after its attempts", async () => {
    const s = await setup({ lineOn: true });
    await s.mark(s.f1);
    for (let i = 1; i <= JUDGE_REVIEW_ATTEMPTS; i++) {
      const f = await s.get(s.f1);
      expect(f.judge_review).toMatchObject({ state: "diagnosing", attempts: i });
      await s.t.run(async (ctx) => { await ctx.db.patch(f.judge_review.diagnosis_run_id, { status: "completed" }); });
      await s.t.run(async (ctx) => await sweepJudgeReviews(ctx, Date.now()));
    }
    const f = await s.get(s.f1);
    expect(f.judge_review.state).toBe("failed");
    expect(f.judge_review.waiting_on).toContain(`${JUDGE_REVIEW_ATTEMPTS} diagnosis runs ended without an answer`);
    // Marking it wrong again starts over.
    expect((await s.mark(s.f1)).state).toBe("diagnosing");
  });
});
