// The ground step before admission (docs/architecture/the-line-end-to-end.md
// LE5, LE6). Admission ranks a cause by the goal it threatens and admits it
// only once it is ready, but a cause the signal door opens carries no ground
// fields. This step writes them: one model call per fresh cause, over the
// cause, its signals and comments, and the goals brief of its project (of its
// workspace when it names none). It is the attach judge's shape (signals.ts):
// a query reads, the action asks, one mutation writes.
//
// A run's ground node is the agent version of the same decision, with the
// same definitions (shared/contracts/goalsBrief GROUND_FIELDS). Grounding here
// costs one call instead of a hand and a card slot, so the line spends its
// caps only on causes a person would want worked.
import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "./functions";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { callModel, parseJsonBlock, STRONG_MODEL, type SurfaceRequest } from "./lib/anthropic";
import { patchTask } from "./lib/taskWrite";
import { insertTaskComment } from "./tasks";
import { causeBrief } from "./goals";
export { causeBrief };
import {
  briefGoalRefs,
  groundCausePrompt,
  LINE_CATEGORIES,
  parseGroundReply,
  type GoalsBrief,
  type GroundCauseInput,
  type GroundFields,
} from "@codecast/shared/contracts/goalsBrief";

/** Causes one pass grounds; a full pass schedules the next at once. */
export const GROUND_BATCH = 8;
export const SIGNALS_SHOWN = 20;
export const COMMENTS_SHOWN = 10;
export const GROUND_AUTHOR = "ground";
// The strong model thinks before it answers and its thinking counts toward
// max_tokens (as changesProse.ts notes): at 400 a cause that took any thought
// came back as JSON cut off before its note. Only tokens used are billed.
export const GROUND_MAX_TOKENS = 2000;

/** The request one cause's ground call posts; ./evals replays exactly it. */
export function groundRequest(cause: GroundCauseInput, brief: GoalsBrief, now: number): SurfaceRequest {
  const { system, prompt } = groundCausePrompt(cause, brief, now);
  return { model: STRONG_MODEL, system, prompt, max_tokens: GROUND_MAX_TOKENS };
}

/** An open cause no one has grounded and no run holds. */
export function isUngroundedCause(task: Doc<"tasks"> | null): task is Doc<"tasks"> {
  return !!task && task.source === "signal" && task.status === "open" && !task.readiness && !task.workflow_run_id;
}

/** The oldest ungrounded causes, at most `limit`. */
export async function ungroundedCauses(ctx: { db: any }, limit: number): Promise<Doc<"tasks">[]> {
  const rows: Doc<"tasks">[] = await ctx.db
    .query("tasks")
    .withIndex("by_source_status_readiness", (q: any) => q.eq("source", "signal").eq("status", "open").eq("readiness", undefined))
    .order("asc")
    .take(limit * 2);
  return rows.filter(isUngroundedCause).slice(0, limit);
}


export async function groundInput(ctx: { db: any }, task: Doc<"tasks">): Promise<GroundCauseInput> {
  const signals = await ctx.db.query("signals").withIndex("by_task", (q: any) => q.eq("task_id", task._id)).order("desc").take(SIGNALS_SHOWN);
  const comments = await ctx.db.query("task_comments").withIndex("by_task_created", (q: any) => q.eq("task_id", task._id)).order("desc").take(COMMENTS_SHOWN);
  return {
    short_id: task.short_id,
    title: task.title,
    description: task.description,
    priority: task.priority,
    created_at: task._creationTime,
    signal_count: task.cause?.signal_count,
    first_seen: task.cause?.first_seen,
    last_seen: task.cause?.last_seen,
    signals: signals.map((s: any) => ({ source: s.source, kind: s.kind, title: s.title, subject: s.subject, goal_hint: s.goal_hint, detail_md: s.detail_md, observed_at: s.observed_at })),
    comments: comments.reverse().map((c: any) => ({ author: c.author, text: c.text ?? "", created_at: c.created_at })),
  };
}

type GroundJob = { task_id: Id<"tasks">; cause: GroundCauseInput; brief: GoalsBrief };

export const inputs = internalQuery({
  args: { limit: v.number() },
  handler: async (ctx, { limit }): Promise<GroundJob[]> => {
    const jobs: GroundJob[] = [];
    for (const task of await ungroundedCauses(ctx, limit)) {
      if (!task.workspace) continue;
      jobs.push({ task_id: task._id, cause: await groundInput(ctx, task), brief: await causeBrief(ctx, task) });
    }
    return jobs;
  },
});

/**
 * The outcome of one call, written if the cause is still open and ungrounded
 * (a person may have grounded it meanwhile). A reply that cannot be read
 * leaves the cause needing a person, with the reason, rather than asking again.
 */
export async function recordGroundCore(ctx: any, taskId: Id<"tasks">, outcome: { fields: GroundFields } | { error: string }, now: number): Promise<"grounded" | "unreadable" | "skipped"> {
  const task: Doc<"tasks"> | null = await ctx.db.get(taskId);
  if (!isUngroundedCause(task)) return "skipped";
  if ("fields" in outcome) {
    const f = outcome.fields;
    await patchTask(ctx, task, { ...f, updated_at: now });
    await insertTaskComment(ctx, task._id, {
      author: GROUND_AUTHOR,
      comment_type: "note",
      text: `Grounded: goal ${f.goal_ref}, ${f.category}, risk ${f.risk}, ${f.readiness.replace("_", " ")}.${f.readiness_note ? ` ${f.readiness_note}` : ""}`,
    });
    return "grounded";
  }
  const note = `The ground step could not read its answer (${outcome.error}). Ground it by hand: cast task update ${task.short_id} --goal-ref <ref> --category <kind> --risk <level> --readiness <state>`;
  await patchTask(ctx, task, { readiness: "needs_context", readiness_note: note.slice(0, 500), updated_at: now });
  await insertTaskComment(ctx, task._id, { author: GROUND_AUTHOR, comment_type: "note", text: note });
  return "unreadable";
}

const groundFieldsValidator = v.object({
  goal_ref: v.string(),
  category: v.union(...LINE_CATEGORIES.map((c) => v.literal(c))),
  risk: v.union(v.literal("low"), v.literal("review"), v.literal("plan")),
  readiness: v.union(v.literal("ready"), v.literal("needs_context"), v.literal("not_actionable")),
  readiness_note: v.string(),
});

export const record = internalMutation({
  args: { task_id: v.id("tasks"), fields: v.optional(groundFieldsValidator), error: v.optional(v.string()) },
  handler: async (ctx, args) => recordGroundCore(ctx, args.task_id, args.fields ? { fields: args.fields } : { error: args.error ?? "no answer" }, Date.now()),
});

export type GroundSweepResult = { grounded: number; unreadable: number; unanswered: number; skipped?: string };

/**
 * One pass: ground up to GROUND_BATCH of the oldest ungrounded causes. A call
 * that gets no reply at all (no key, a timeout, an outage) leaves its cause
 * untouched for the next pass; that is no answer, not a wrong one. Call this
 * from crons.ts.
 */
export const sweep = internalAction({
  args: {},
  handler: async (ctx): Promise<GroundSweepResult> => {
    if (!process.env.ANTHROPIC_API_KEY) return { grounded: 0, unreadable: 0, unanswered: 0, skipped: "no model key" };
    const jobs: GroundJob[] = await ctx.runQuery(internal.lineGround.inputs, { limit: GROUND_BATCH });
    const now = Date.now();
    const result: GroundSweepResult = { grounded: 0, unreadable: 0, unanswered: 0 };
    await Promise.all(jobs.map(async (job) => {
      const reply = await callModel({ ...groundRequest(job.cause, job.brief, now), label: "Line ground", timeout_ms: 60_000 });
      if (!reply?.text) { result.unanswered++; return; }
      const outcome = parseGroundReply(parseJsonBlock(reply.text), briefGoalRefs(job.brief));
      const status: string = await ctx.runMutation(internal.lineGround.record, "fields" in outcome ? { task_id: job.task_id, fields: outcome.fields } : { task_id: job.task_id, error: outcome.error });
      if (status === "grounded") result.grounded++;
      else if (status === "unreadable") result.unreadable++;
    }));
    if (jobs.length === GROUND_BATCH && result.unanswered === 0) await ctx.scheduler.runAfter(0, internal.lineGround.sweep, {});
    return result;
  },
});
