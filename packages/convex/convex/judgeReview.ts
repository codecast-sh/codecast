// Improving a judge (docs/architecture/learning-loop.md LL4, LL11).
//
// A judge's finding is marked wrong in one of two ways: a person labels the
// judge step's decision wrong (the line workspace's label, line-workspace.md
// LW3, which calls findingLabeled), or a line run's proof finds the system
// behaved well and the judge scored it as a break (judge-defects.json, which
// the dissolve station hands to `cast signal judge-defects`). Either way the
// finding keeps its place and gains a judge_review, and a short diagnosis
// run (the shipped judge-review graph) answers one question about it: was
// the fact needed to judge correctly missing from what the judge saw, or
// present and misread.
//
// The answer files a case: a signal of its own (case_of names the finding)
// under one issue key per part of the judge, so cases against one judge
// gather into one problem whose subject is that judge (caseRoute). That
// problem runs on the project's line like any change: prove shows the wrong
// cases failing today, the builder edits the judge's prompt, its input
// builder or the extractor in the product's repo, eval compares the judge's
// case set before and after, and a person gets one card.
//
// The diagnosis is a hand of the role that leads the finding's project, so
// it starts only while that line's start switch is on and its hands last; a
// finding waits until then, saying why (waiting_on), and the sweep starts it.
import { ConvexError, v } from "convex/values";
import { internalAction, internalMutation, internalQuery, mutation } from "./functions";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { verifyApiToken } from "./apiTokens";
import { createDataContext } from "./data";
import { canAccessSignal } from "./lib/access";
import { parseWorkspaceKey } from "./lib/accessKeys";
import { insertTaskComment } from "./tasks";
import { retireSignals } from "./judgeRetire";
import { attachJudgeRequest, commitSignal, foldProblem, normalizeSignal, parseAttachJudgeReply, type CauseCandidate, type SignalInput } from "./signals";
import { runModelCall } from "./modelCalls";
import { isTerminalTaskStatus } from "@codecast/shared/tasks";
import { isExpectationId } from "@codecast/shared/contracts/expectations";
import { latestExpectations } from "./lib/expectationsApply";
import { leadRoleOf } from "./lineCause";
import { roleMayStartHands, startRoleRun } from "./orgLine";
import { lineStartsOn } from "@codecast/shared/contracts/roleAutonomy";
import { isLiveRunStatus } from "./workflow_runs";
import {
  caseDetail,
  caseGist,
  caseRoute,
  isJudgeProblem,
  type CaseTarget,
  DIAGNOSIS_ANSWERS,
  JUDGE_CASE_SOURCE,
  JUDGE_REVIEW_ATTEMPTS,
  JUDGE_REVIEW_GRAPH,
  type DiagnosisAnswer,
} from "@codecast/shared/contracts/judgeReview";

type Review = NonNullable<Doc<"signals">["judge_review"]>;
type Trigger = Review["trigger"];

const NOTE_MAX = 2000;
const FACT_MAX = 1000;
/** Diagnoses one sweep pass checks for a run that ended without an answer. */
const SWEEP_BATCH = 50;
/**
 * Waiting findings one sweep pass reads. Wide, so findings waiting on a line
 * that is off never hold back a line that is on: each project's reason to
 * wait is looked up once per pass.
 */
const WAITING_SCAN = 500;

const clip = (s: string | undefined, max: number) => {
  const t = s?.trim();
  return t ? t.slice(0, max) : undefined;
};

async function authed(ctx: any, apiToken: string): Promise<Id<"users">> {
  const auth = await verifyApiToken(ctx, apiToken);
  if (!auth) throw new Error("Unauthorized");
  return auth.userId;
}

async function signalByRef(ctx: any, ref: string): Promise<Doc<"signals"> | null> {
  const t = ref.trim();
  const byShort = await ctx.db.query("signals").withIndex("by_short_id", (q: any) => q.eq("short_id", t)).first();
  if (byShort) return byShort;
  const id = ctx.db.normalizeId("signals", t);
  return id ? await ctx.db.get(id) : null;
}

/**
 * Mark a judge's finding wrong and start its diagnosis when the line may. A
 * finding already marked keeps its review (a second mark adds the newer
 * words); one whose diagnosis failed starts over. Returns the review as it
 * stands.
 */
export async function markFindingWrong(
  ctx: any,
  finding: Doc<"signals">,
  o: { trigger: Trigger; by?: Id<"users">; run_id?: Id<"workflow_runs">; note?: string; sentence?: string; now: number },
): Promise<Review> {
  if (!finding.judge) throw new ConvexError(`${finding.short_id} was not made by a judge, so there is no judge to improve`);
  if (finding.case_of) throw new ConvexError(`${finding.short_id} is a case against a judge, not a judge's finding`);
  const note = clip(o.note, NOTE_MAX);
  const sentence = clip(o.sentence, NOTE_MAX);
  const had = finding.judge_review;
  if (had && had.state !== "failed") {
    const words = { ...(note ? { note } : {}), ...(sentence ? { sentence } : {}) };
    if (Object.keys(words).length) await ctx.db.patch(finding._id, { judge_review: { ...had, ...words } });
    return { ...had, ...words };
  }
  const review: Review = {
    trigger: o.trigger,
    ...(o.by ? { by: o.by } : {}),
    ...(o.run_id ? { run_id: o.run_id } : {}),
    ...(note ? { note } : {}),
    ...(sentence ? { sentence } : {}),
    at: o.now,
    state: "waiting",
    attempts: 0,
  };
  await ctx.db.patch(finding._id, { judge_review: review });
  return await startDiagnosis(ctx, { ...finding, judge_review: review }, o.now);
}

/**
 * The hook for the line workspace's label on a judge step's decision whose
 * decision is a finding (line-workspace.md LW3): wrong marks it, right takes
 * back a mark whose diagnosis has not started. A diagnosed case stays with
 * its judge's problem, where a person drops it like any other report.
 */
export async function findingLabeled(
  ctx: any,
  findingId: Id<"signals">,
  label: { verdict: "right" | "wrong" | null; note?: string; by: Id<"users">; now: number },
): Promise<Review | null> {
  const finding: Doc<"signals"> | null = await ctx.db.get(findingId);
  if (!finding?.judge || finding.case_of) return null;
  if (label.verdict === "wrong") return await markFindingWrong(ctx, finding, { trigger: "label", by: label.by, note: label.note, now: label.now });
  const had = finding.judge_review;
  if (had?.trigger === "label" && had.state === "waiting") await ctx.db.patch(finding._id, { judge_review: undefined });
  return null;
}

/**
 * A person's label on a judge's finding (line-workspace.md LW4, LL4): the
 * finding is the judge step's decision, so the label lands in line_labels
 * under (finding, step, person) like any other decision's, and then marks
 * the finding (findingLabeled). `stepId` is the judge's step in the loop
 * (loopSteps: "product:<source>/<judge>" or "judge:<name>"); `key` is the
 * label's identity (lineWorkspace.lineLabelKey). Returns the label's id, or
 * null when the label was taken back.
 */
export async function labelFinding(
  ctx: any,
  userId: Id<"users">,
  findingId: Id<"signals">,
  stepId: string,
  key: string,
  verdict: "right" | "wrong" | null,
  note?: string,
): Promise<string | null> {
  const finding: Doc<"signals"> | null = await ctx.db.get(findingId);
  if (!finding || !(await canAccessSignal(ctx, userId, finding))) throw new Error("Not found");
  if (!finding.judge || finding.case_of) throw new ConvexError("Only a judge's finding can be marked right or wrong");
  const now = Date.now();
  const had = await ctx.db.query("line_labels").withIndex("by_key", (q: any) => q.eq("key", key)).first();
  await findingLabeled(ctx, finding._id, { verdict, note, by: userId, now });
  if (verdict === null) {
    if (had) await ctx.db.delete(had._id);
    return null;
  }
  if (had) {
    await ctx.db.patch(had._id, { verdict, note, at: now });
    return String(had._id);
  }
  return String(await ctx.db.insert("line_labels", {
    key,
    workspace: finding.workspace,
    ...(finding.team_id ? { team_id: finding.team_id } : {}),
    ...(finding.project_id ? { project_id: finding.project_id } : {}),
    signal_id: finding._id,
    node_id: stepId,
    verdict,
    ...(note ? { note } : {}),
    by: userId,
    at: now,
  }));
}

/** Why the finding's project cannot diagnose it now, or the role that can. */
async function diagnosingRole(ctx: any, finding: Doc<"signals">, now: number): Promise<{ role: any } | { waiting_on: string }> {
  const project: Doc<"projects"> | null = finding.project_id ? await ctx.db.get(finding.project_id) : null;
  if (!project) return { waiting_on: "The finding is in no project, so no line diagnoses it." };
  // A trial's line never starts on its own (LL12): the run that ruled the
  // finding wrong records the diagnosis itself.
  if (project.line_trial) return { waiting_on: `${project.title} is a trial, so its line never starts a diagnosis; the run that ruled it wrong records one with cast signal diagnosis.` };
  const role = await leadRoleOf(ctx, project);
  if (!role) return { waiting_on: `No role leads ${project.title}, so no line diagnoses its findings.` };
  if (!roleMayStartHands(role, now)) {
    return { waiting_on: role.status === "active" && lineStartsOn(role)
      ? `@${role.handle} has started all the sessions it may today; the diagnosis starts tomorrow.`
      : `The line for ${project.title} is off; the diagnosis starts once "Start problems on their own" is on.` };
  }
  return { role };
}

/**
 * Start the diagnosis run for a waiting finding, or record why it waits.
 * `waits` carries, through one sweep pass, why each project's findings wait:
 * a line that is off, or a role out of hands, stays so for the pass.
 */
async function startDiagnosis(ctx: any, finding: Doc<"signals">, now: number, waits?: Map<string, string>): Promise<Review> {
  const review = finding.judge_review!;
  if (review.state !== "waiting") return review;
  const project = String(finding.project_id ?? "");
  const known = waits?.get(project);
  const place = known !== undefined ? { waiting_on: known } : await diagnosingRole(ctx, finding, now);
  if ("waiting_on" in place) {
    waits?.set(project, place.waiting_on);
    const next = { ...review, waiting_on: place.waiting_on };
    if (next.waiting_on !== review.waiting_on) await ctx.db.patch(finding._id, { judge_review: next });
    return next;
  }
  const { runId } = await startRoleRun(ctx, place.role, { slug: JUDGE_REVIEW_GRAPH, goal: finding.short_id, now });
  const { waiting_on: _w, ...rest } = review;
  const next: Review = { ...rest, state: "diagnosing", attempts: review.attempts + 1, diagnosis_run_id: runId };
  await ctx.db.patch(finding._id, { judge_review: next });
  return next;
}

/** The expectation a judge's finding said was broken, with its words when the finding's project still carries it. */
async function expectationOf(ctx: any, finding: Doc<"signals">): Promise<{ expectation?: string; expectation_text?: string }> {
  if (!isExpectationId(finding.subject)) return {};
  const doc = finding.project_id ? await latestExpectations(ctx, finding.project_id) : null;
  const item = (doc?.items ?? []).find((i: { id: string }) => i.id === finding.subject);
  return { expectation: finding.subject, ...(item?.text ? { expectation_text: item.text } : {}) };
}

/**
 * Record a diagnosis and file its case (LL11). The case opens a problem under
 * a key of its own (caseRoute), and grouping folds it into the open case
 * problem with the same fix, if there is one (groupCase); the finding's own
 * problem gets a note naming the case. Recording twice files nothing new.
 */
export async function recordDiagnosis(
  ctx: any,
  userId: Id<"users">,
  finding: Doc<"signals">,
  d: { answer: DiagnosisAnswer; fact?: string; why?: string; now: number },
): Promise<{ review: Review; case_short_id: string; task_short_id?: string }> {
  const review = finding.judge_review;
  if (!review) throw new ConvexError(`${finding.short_id} has not been marked wrong, so there is nothing to diagnose`);
  // Recorded once: a second answer, the same or another, files nothing new.
  if (review.state === "diagnosed") {
    const had: Doc<"signals"> | null = review.case_id ? await ctx.db.get(review.case_id) : null;
    const task: Doc<"tasks"> | null = had?.task_id ? await ctx.db.get(had.task_id) : null;
    return { review, case_short_id: had?.short_id ?? "", task_short_id: task?.short_id };
  }
  if (!DIAGNOSIS_ANSWERS.includes(d.answer)) throw new ConvexError(`The answer is one of ${DIAGNOSIS_ANSWERS.join(", ")}`);
  const fact = clip(d.fact, FACT_MAX);
  const why = clip(d.why, NOTE_MAX);
  const settled = { answer: d.answer, ...(fact ? { fact } : {}), ...(why ? { why } : {}), diagnosed_at: d.now };

  const answer = d.answer;
  if (answer === "upheld") {
    // The records say the judge was right: nothing to fix in it. The finding
    // keeps its mark and the diagnosis, and its problem hears why.
    const { waiting_on: _w, ...rest } = review;
    const next: Review = { ...rest, ...settled, state: "diagnosed" };
    await ctx.db.patch(finding._id, { judge_review: next });
    if (finding.task_id) {
      await insertTaskComment(ctx, finding.task_id, {
        author: "line",
        comment_type: "note",
        text: `${finding.short_id} was marked wrong, but the ${finding.judge} judge's records show the finding holds${why ? `: ${why}` : "."}`,
      });
    }
    return { review: next, case_short_id: "" };
  }

  const moment: Doc<"moments"> | null = finding.moment
    ? await ctx.db.query("moments").withIndex("by_short_id", (q: any) => q.eq("short_id", finding.moment)).first()
    : null;
  const momentSource: Doc<"event_sources"> | null = moment ? await ctx.db.get(moment.source_id) : null;
  const route = caseRoute({
    judge: finding.judge!,
    source: finding.source,
    ...(finding.moment ? { moment: finding.moment } : {}),
    ...(moment ? { moment_kind: moment.kind } : {}),
    ...(momentSource ? { moment_source: momentSource.name } : {}),
    ...(await expectationOf(ctx, finding)),
    finding: finding.short_id,
  }, answer);

  const ws = parseWorkspaceKey(finding.workspace);
  if (!ws) throw new ConvexError("The finding's workspace is unknown");
  const db = await createDataContext(ctx, ws.type === "team" ? { userId, workspace: "team", team_id: ws.teamId } : { userId, workspace: "personal" });
  if (db.workspaceKey !== finding.workspace) throw new ConvexError("This finding is in another workspace");

  const signal = normalizeSignal({
    source: JUDGE_CASE_SOURCE,
    kind: route.kind,
    fingerprint: route.key,
    issue: true,
    title: `Marked wrong: ${finding.title}`,
    detail_md: caseDetail({
      judge: finding.judge!,
      judge_version: finding.judge_version,
      finding_short_id: finding.short_id,
      finding_title: finding.title,
      finding_detail: finding.detail_md,
      trigger: review.trigger,
      note: review.note,
      sentence: review.sentence,
      answer,
      fact,
      why,
    }),
    subject: route.part,
    ...(finding.evidence_url ? { evidence_url: finding.evidence_url } : {}),
    judge: finding.judge,
    ...(finding.judge_version ? { judge_version: finding.judge_version } : {}),
    ...(finding.moment ? { moment: finding.moment } : {}),
  });
  const filed = await commitSignal(ctx, db, userId, signal, null, d.now, finding.project_id ?? null, { title: route.title });
  await ctx.db.patch(filed.signal_id, { case_of: finding._id });
  // Its own problem until grouping finds the sibling with the same fix.
  if (filed.attach === "new") await ctx.scheduler.runAfter(0, internal.judgeReview.groupCase, { case_id: filed.signal_id });

  const { waiting_on: _w, ...rest } = review;
  const next: Review = { ...rest, ...settled, state: "diagnosed", against: route.against, case_id: filed.signal_id };
  await ctx.db.patch(finding._id, { judge_review: next });

  if (finding.task_id && filed.task_id && finding.task_id !== filed.task_id) {
    await insertTaskComment(ctx, finding.task_id, {
      author: "line",
      comment_type: "note",
      text: `${finding.short_id} was the ${finding.judge} judge's mistake (${answer === "missing" ? "the fact it needed was missing from what it saw" : "it misread what it saw"}). It is a case on ${filed.task_short_id}.`,
    });
  }
  return { review: next, case_short_id: filed.short_id, task_short_id: filed.task_short_id };
}

/**
 * Every few minutes: start the diagnoses that wait for their line, and put a
 * diagnosis whose run ended without an answer back to waiting, up to
 * JUDGE_REVIEW_ATTEMPTS runs; past that it fails and says so on the finding.
 */
export async function sweepJudgeReviews(ctx: any, now: number): Promise<{ started: number; retried: number; failed: number }> {
  let started = 0;
  let retried = 0;
  let failed = 0;
  const running: Doc<"signals">[] = await ctx.db.query("signals")
    .withIndex("by_judge_review_state", (q: any) => q.eq("judge_review.state", "diagnosing")).take(SWEEP_BATCH);
  for (const f of running) {
    const review = f.judge_review!;
    const run: Doc<"workflow_runs"> | null = review.diagnosis_run_id ? await ctx.db.get(review.diagnosis_run_id) : null;
    if (run && isLiveRunStatus(run.status)) continue;
    if (review.attempts >= JUDGE_REVIEW_ATTEMPTS) {
      await ctx.db.patch(f._id, { judge_review: { ...review, state: "failed", waiting_on: `${review.attempts} diagnosis runs ended without an answer; mark it wrong again to retry.` } });
      failed++;
    } else {
      await ctx.db.patch(f._id, { judge_review: { ...review, state: "waiting", waiting_on: "The last diagnosis ended without an answer." } });
      retried++;
    }
  }
  // After the retries, so a diagnosis put back to waiting starts again in this pass.
  const waiting: Doc<"signals">[] = await ctx.db.query("signals")
    .withIndex("by_judge_review_state", (q: any) => q.eq("judge_review.state", "waiting")).take(WAITING_SCAN);
  const waits = new Map<string, string>();
  for (const f of waiting) {
    if ((await startDiagnosis(ctx, f, now, waits)).state === "diagnosing") started++;
  }
  return { started, retried, failed };
}

export const sweep = internalMutation({
  args: {},
  handler: async (ctx) => await sweepJudgeReviews(ctx, Date.now()),
});

/**
 * The finding a judge-defects entry names: its signal id or short id, else
 * the signal of the run's cause whose words or link carry the id the prove
 * station copied from the product (a product's own finding id).
 */
async function defectFinding(ctx: any, ref: string, causeId: Id<"tasks"> | undefined): Promise<Doc<"signals"> | null> {
  const direct = await signalByRef(ctx, ref);
  if (direct) return direct;
  if (!causeId || ref.trim().length < 6) return null;
  const rows: Doc<"signals">[] = await ctx.db.query("signals").withIndex("by_task", (q: any) => q.eq("task_id", causeId)).collect();
  const t = ref.trim();
  return rows.find((r) => r.judge && (r.evidence_url?.includes(t) || r.detail_md?.includes(t))) ?? null;
}

/**
 * `cast signal judge-defects <file> --run <id>`: the dissolve station's hand
 * off (LL11). Each entry of the run's judge-defects.json marks its finding
 * wrong, with the sentence saying what a correct judgment does, and the
 * finding leaves its problem: a proof found it false, so no problem counts it
 * or takes it as evidence (a problem it empties closes, as a re-judge would).
 */
export const defectsForCli = mutation({
  args: {
    api_token: v.string(),
    run_id: v.optional(v.string()),
    defects: v.array(v.object({ finding: v.string(), judge: v.optional(v.string()), sentence: v.optional(v.string()), name: v.optional(v.string()) })),
  },
  handler: async (ctx, args) => {
    const userId = await authed(ctx, args.api_token);
    const runId = args.run_id ? ctx.db.normalizeId("workflow_runs", args.run_id.trim()) : null;
    const run: Doc<"workflow_runs"> | null = runId ? await ctx.db.get(runId) : null;
    const now = Date.now();
    const out: Array<{ finding: string; short_id?: string; state?: string; waiting_on?: string; skipped?: string }> = [];
    for (const d of args.defects.slice(0, 100)) {
      const finding = await defectFinding(ctx, d.finding, run?.task_id);
      if (!finding || !(await canAccessSignal(ctx, userId, finding))) { out.push({ finding: d.finding, skipped: "no such finding" }); continue; }
      if (!finding.judge) { out.push({ finding: d.finding, short_id: finding.short_id, skipped: "not a judge's finding" }); continue; }
      const review = await markFindingWrong(ctx, finding, {
        trigger: "dissolve",
        ...(run ? { run_id: run._id } : {}),
        sentence: d.sentence,
        now,
      });
      if (!finding.retired) await retireSignals(ctx, [finding], { reason: `found wrong by a line run's proof${d.sentence ? `: ${d.sentence.slice(0, 300)}` : ""}`, actor: userId });
      out.push({ finding: d.finding, short_id: finding.short_id, state: review.state, ...(review.waiting_on ? { waiting_on: review.waiting_on } : {}) });
    }
    return out;
  },
});

/** `cast signal diagnosis <sg> --answer missing|misread --fact ... --why ...`: the judge-review graph's last step. */
export const diagnosisForCli = mutation({
  args: {
    api_token: v.string(),
    signal: v.string(),
    answer: v.string(),
    fact: v.optional(v.string()),
    why: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await authed(ctx, args.api_token);
    const finding = await signalByRef(ctx, args.signal);
    if (!finding || !(await canAccessSignal(ctx, userId, finding))) throw new ConvexError("Finding not found");
    const answer = args.answer.trim().toLowerCase() as DiagnosisAnswer;
    return await recordDiagnosis(ctx, userId, finding, { answer, fact: args.fact, why: args.why, now: Date.now() });
  },
});

// ── Grouping a case (LL11) ──
//
// A case is one wrong finding's diagnosis. Cases are one problem when one fix
// answers them: the same diagnosed fact, against the same kind of part (the
// judge's prompt, the input a product's judge is given, an extractor). The
// judge line and the judge's original wording say neither: one line was ruled
// wrong for a prompt rule, two history folds and a missing operator note,
// while one misread fee lane was ruled on two lines (pl-882, 2026-10-12). The
// attach judge (signals.attachJudgeRequest) reads each candidate's cases by
// their facts and names the one with the same fix, or none.

/** How many of a project's newest signals are read for open case problems. */
const CASE_SCAN = 2000;
/** Candidate problems one grouping call reads, and cases shown per candidate. */
const CASE_CANDIDATES = 12;
const CASE_LINES = 8;

type CaseFacts = { short_id: string; against: CaseTarget; gist: string; signal: SignalInput };

/** A case as grouping reads it: the kind of part at fault, its gist, and itself as an observation. */
async function caseFacts(ctx: any, row: Doc<"signals">): Promise<CaseFacts> {
  const finding: Doc<"signals"> | null = row.case_of ? await ctx.db.get(row.case_of) : null;
  const against: CaseTarget = finding?.judge_review?.against ?? (row.kind === "prompt_miss" ? "judge" : "extractor");
  const expectation = finding && isExpectationId(finding.subject) ? finding.subject : undefined;
  const gist = caseGist({ moment: row.moment, part: row.subject, expectation, detail_md: row.detail_md });
  const at = row.detail_md?.indexOf("Diagnosis:") ?? -1;
  const diagnosis = at >= 0 ? row.detail_md!.slice(at) : row.detail_md ?? "";
  return {
    short_id: row.short_id,
    against,
    gist,
    // Titled by what hid the fact, not by the finding the judge got wrong: two cases share a fix when the same fold, cap
    // or rule hid their facts, whatever each email said.
    signal: normalizeSignal({ source: row.source, kind: row.kind, fingerprint: row.fingerprint, title: `Against ${row.subject ?? "the judge"}: ${gist.split(" · why: ")[1] ?? gist.split(" · fact: ")[1] ?? row.title}`.slice(0, 300), ...(row.subject ? { subject: row.subject } : {}), detail_md: [gist.split(" · fact: ")[0], diagnosis].join("\n") }),
  };
}

export const caseGroupInputs = internalQuery({
  args: { case_id: v.id("signals") },
  handler: async (ctx, args) => {
    const row: Doc<"signals"> | null = await ctx.db.get(args.case_id);
    if (!row?.case_of || !row.task_id || !row.project_id) return null;
    const own: Doc<"tasks"> | null = await ctx.db.get(row.task_id);
    if (!own || isTerminalTaskStatus(own.status)) return null;
    const mine = await caseFacts(ctx, row);
    const recent: Doc<"signals">[] = await ctx.db.query("signals")
      .withIndex("by_project_created", (q: any) => q.eq("project_id", row.project_id)).order("desc").take(CASE_SCAN);
    const byTask = new Map<string, Doc<"signals">[]>();
    for (const r of recent) {
      if (r.source !== JUDGE_CASE_SOURCE || !r.case_of || !r.task_id || r.task_id === row.task_id || r.workspace !== row.workspace) continue;
      byTask.set(String(r.task_id), [...(byTask.get(String(r.task_id)) ?? []), r]);
    }
    const candidates: CauseCandidate[] = [];
    for (const [id, rows] of byTask) {
      if (candidates.length >= CASE_CANDIDATES) break;
      const task: Doc<"tasks"> | null = await ctx.db.get(id as Id<"tasks">);
      if (!task || isTerminalTaskStatus(task.status) || !isJudgeProblem(task.cause)) continue;
      const facts = await Promise.all(rows.slice(0, CASE_LINES).map((r) => caseFacts(ctx, r)));
      // One fix answers one kind of part: a problem whose cases name another never takes this one.
      if (!facts.every((f) => f.against === mine.against)) continue;
      candidates.push({ task_id: task._id, short_id: task.short_id, title: task.title, subjects: [...new Set(rows.map((r) => r.subject).filter(Boolean) as string[])], signal_count: task.cause?.signal_count ?? rows.length, cases: facts.map((f) => f.gist) });
    }
    return {
      signal: mine.signal,
      scope: { workspace: row.workspace, ...(row.team_id ? { team_id: row.team_id } : {}), project_id: row.project_id },
      candidates,
    };
  },
});

/** After a case is filed: fold its own problem into the open case problem with the same fix, when the judge names one. */
export const groupCase = internalAction({
  args: { case_id: v.id("signals"), dry: v.optional(v.boolean()) },
  handler: async (ctx, args): Promise<{ joined: string | null; reply?: string }> => {
    const inputs: { signal: SignalInput; scope: any; candidates: CauseCandidate[] } | null = await ctx.runQuery(internal.judgeReview.caseGroupInputs, { case_id: args.case_id });
    if (!inputs?.candidates.length) return { joined: null };
    const req = attachJudgeRequest(inputs.signal, inputs.candidates);
    const r = await runModelCall(ctx, inputs.scope, "grouping", { model: req.model, system: req.system, prompt: req.prompt, max_tokens: req.max_tokens, output: "json" }, "Case grouping", 20_000);
    const id = r.ok ? parseAttachJudgeReply(r.text, inputs.candidates) : null;
    const reply = r.ok ? r.text : r.error;
    if (!id) return { joined: null, reply };
    const short = inputs.candidates.find((c) => c.task_id === id)!.short_id;
    if (args.dry) return { joined: short, reply };
    const done: string | null = await ctx.runMutation(internal.judgeReview.joinCase, { case_id: args.case_id, task_id: id });
    return { joined: done, reply };
  },
});

/** The fold groupCase decided, if both problems still stand as they were: the case's own problem holds only it, and the other is still an open case problem. */
export const joinCase = internalMutation({
  args: { case_id: v.id("signals"), task_id: v.id("tasks") },
  handler: async (ctx, args): Promise<string | null> => {
    const row: Doc<"signals"> | null = await ctx.db.get(args.case_id);
    const own: Doc<"tasks"> | null = row?.task_id ? await ctx.db.get(row.task_id) : null;
    const into: Doc<"tasks"> | null = await ctx.db.get(args.task_id);
    if (!row || !own || !into || own._id === into._id || isTerminalTaskStatus(own.status) || isTerminalTaskStatus(into.status) || !isJudgeProblem(into.cause)) return null;
    const held: Doc<"signals">[] = await ctx.db.query("signals").withIndex("by_task", (q: any) => q.eq("task_id", own._id)).collect();
    if (held.some((r) => r._id !== row._id)) return null;
    const now = Date.now();
    await foldProblem(ctx, row.user_id, own, into, now);
    await insertTaskComment(ctx, own._id, { author: "line", comment_type: "note", text: `Merged into ${into.short_id}: ${row.short_id} names the same fact, so one fix answers both.` });
    await insertTaskComment(ctx, into._id, { author: "line", comment_type: "note", text: `${row.short_id} joined from ${own.short_id}: the same fact, so this fix answers it too.` });
    return into.short_id;
  },
});

/**
 * Where grouping would put cases filed in this order, without moving anything
 * (run with packages/convex/run.sh): each case is asked against the groups the
 * cases before it formed, the way groupCase asks against open problems. For
 * checking grouping on the cases a misgrouping was found on. Charged to the
 * team's grouping budget.
 */
export const simulateCaseGrouping = internalAction({
  args: { cases: v.array(v.string()) },
  handler: async (ctx, args): Promise<Array<{ case: string; group: number; reply?: string }>> => {
    const facts: Array<CaseFacts & { scope: any }> = await ctx.runQuery(internal.judgeReview.caseFactsFor, { cases: args.cases });
    const groups: Array<{ against: CaseTarget; members: CaseFacts[] }> = [];
    const out: Array<{ case: string; group: number; reply?: string }> = [];
    for (const f of facts) {
      const open = groups.map((g, i) => ({ g, i })).filter(({ g }) => g.against === f.against);
      let group = -1;
      let reply: string | undefined;
      if (open.length) {
        const candidates = open.map(({ g, i }) => ({ task_id: `g${i + 1}` as unknown as Id<"tasks">, short_id: `g${i + 1}`, title: g.members[0]!.signal.title, subjects: [...new Set(g.members.map((m) => m.signal.subject).filter(Boolean) as string[])], signal_count: g.members.length, cases: g.members.map((m) => m.gist) }));
        const req = attachJudgeRequest(f.signal, candidates);
        const r = await runModelCall(ctx, f.scope, "grouping", { model: req.model, system: req.system, prompt: req.prompt, max_tokens: req.max_tokens, output: "json" }, "Case grouping probe", 20_000);
        reply = r.ok ? r.text : r.error;
        const id = r.ok ? parseAttachJudgeReply(r.text, candidates) : null;
        if (id) group = Number(String(id).slice(1)) - 1;
      }
      if (group < 0) group = groups.push({ against: f.against, members: [] }) - 1;
      groups[group]!.members.push(f);
      out.push({ case: f.short_id, group: group + 1, ...(reply ? { reply } : {}) });
    }
    return out;
  },
});

export const caseFactsFor = internalQuery({
  args: { cases: v.array(v.string()) },
  handler: async (ctx, args) => {
    const out: Array<CaseFacts & { scope: any }> = [];
    for (const ref of args.cases) {
      const row = await signalByRef(ctx, ref);
      if (!row?.case_of) throw new ConvexError(`${ref} is not a case against a judge`);
      out.push({ ...(await caseFacts(ctx, row)), scope: { workspace: row.workspace, ...(row.team_id ? { team_id: row.team_id } : {}), ...(row.project_id ? { project_id: row.project_id } : {}) } });
    }
    return out;
  },
});
