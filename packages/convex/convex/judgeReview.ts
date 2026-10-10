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
import { internalMutation, mutation } from "./functions";
import type { Doc, Id } from "./_generated/dataModel";
import { verifyApiToken } from "./apiTokens";
import { createDataContext } from "./data";
import { canAccessSignal } from "./lib/access";
import { parseWorkspaceKey } from "./lib/accessKeys";
import { insertTaskComment } from "./tasks";
import { commitSignal, normalizeSignal } from "./signals";
import { leadRoleOf } from "./lineCause";
import { roleMayStartHands, startRoleRun } from "./orgLine";
import { lineStartsOn } from "@codecast/shared/contracts/roleAutonomy";
import { isLiveRunStatus } from "./workflow_runs";
import {
  caseDetail,
  caseRoute,
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
/** Wrong findings one sweep pass looks at, per state. */
const SWEEP_BATCH = 50;

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

/** Why the finding's project cannot diagnose it now, or the role that can. */
async function diagnosingRole(ctx: any, finding: Doc<"signals">, now: number): Promise<{ role: any } | { waiting_on: string }> {
  const project: Doc<"projects"> | null = finding.project_id ? await ctx.db.get(finding.project_id) : null;
  if (!project) return { waiting_on: "The finding is in no project, so no line diagnoses it." };
  const role = await leadRoleOf(ctx, project);
  if (!role) return { waiting_on: `No role leads ${project.title}, so no line diagnoses its findings.` };
  if (!roleMayStartHands(role, now)) {
    return { waiting_on: role.status === "active" && lineStartsOn(role)
      ? `@${role.handle} has used today's hands; the diagnosis starts tomorrow.`
      : `@${role.handle}'s line is off; the diagnosis starts when it is on.` };
  }
  return { role };
}

/** Start the diagnosis run for a waiting finding, or record why it waits. */
async function startDiagnosis(ctx: any, finding: Doc<"signals">, now: number): Promise<Review> {
  const review = finding.judge_review!;
  if (review.state !== "waiting") return review;
  const place = await diagnosingRole(ctx, finding, now);
  if ("waiting_on" in place) {
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

/**
 * Record a diagnosis and file its case (LL11). The case goes under the issue
 * key of the part it is against, so it joins that part's open problem or
 * opens one titled for it; the finding's own problem gets a note naming the
 * case. Recording twice files nothing new.
 */
export async function recordDiagnosis(
  ctx: any,
  userId: Id<"users">,
  finding: Doc<"signals">,
  d: { answer: DiagnosisAnswer; fact?: string; why?: string; now: number },
): Promise<{ review: Review; case_short_id: string; task_short_id?: string }> {
  const review = finding.judge_review;
  if (!review) throw new ConvexError(`${finding.short_id} has not been marked wrong, so there is nothing to diagnose`);
  if (review.state === "diagnosed" && review.case_id) {
    const had: Doc<"signals"> | null = await ctx.db.get(review.case_id);
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
    subject: route.key,
    ...(finding.evidence_url ? { evidence_url: finding.evidence_url } : {}),
    judge: finding.judge,
    ...(finding.judge_version ? { judge_version: finding.judge_version } : {}),
    ...(finding.moment ? { moment: finding.moment } : {}),
  });
  const filed = await commitSignal(ctx, db, userId, signal, null, d.now, finding.project_id ?? null, { title: route.title });
  await ctx.db.patch(filed.signal_id, { case_of: finding._id });

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
    .withIndex("by_judge_review_state", (q: any) => q.eq("judge_review.state", "waiting")).take(SWEEP_BATCH);
  for (const f of waiting) {
    if ((await startDiagnosis(ctx, f, now)).state === "diagnosing") started++;
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
 * wrong, with the sentence saying what a correct judgment does.
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
