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
import { parseJsonBlock, STRONG_MODEL, type SurfaceRequest } from "./lib/anthropic";
import { runModelCall, type CallScope } from "./modelCalls";
import { patchTask } from "./lib/taskWrite";
import { insertTaskComment } from "./tasks";
import { causeBrief } from "./goals";
export { causeBrief };
import { isPlaced } from "./lib/signalPlacement";
import {
  briefGoalRefs,
  groundCausePrompt,
  groundOutputSchema,
  groundPlacingProjects,
  groundedWords,
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
  return { model: STRONG_MODEL, system, prompt, max_tokens: GROUND_MAX_TOKENS, output_schema: groundOutputSchema(groundPlacingProjects(cause, brief)) };
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


/** A cause nothing has placed (LM1): its project, if any, is a default, so ground names it. */
export const needsPlacing = (task: Doc<"tasks">) => !!task.cause?.placed && !isPlaced(task.cause.placed);

export async function groundInput(ctx: { db: any }, task: Doc<"tasks">): Promise<GroundCauseInput> {
  const filedUnder: Doc<"projects"> | null = needsPlacing(task) && task.project_id ? await ctx.db.get(task.project_id) : null;
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
    ...(needsPlacing(task) ? { placing: filedUnder ? { filed_under: { short_id: filedUnder.short_id ?? String(filedUnder._id), title: filedUnder.title } } : {} } : {}),
  };
}

/** One cause to ground, and where its call is charged: its workspace's budget and its project. */
type GroundJob = { task_id: Id<"tasks">; scope: CallScope; cause: GroundCauseInput; brief: GoalsBrief };

export const inputs = internalQuery({
  args: { limit: v.number() },
  handler: async (ctx, { limit }): Promise<GroundJob[]> => {
    const jobs: GroundJob[] = [];
    for (const task of await ungroundedCauses(ctx, limit)) {
      if (!task.workspace) continue;
      const scope: CallScope = { workspace: task.workspace, ...(task.team_id ? { team_id: task.team_id } : {}), ...(task.project_id ? { project_id: task.project_id } : {}) };
      // A cause being placed reads every project's charter: its own project is only a default.
      const brief = await causeBrief(ctx, needsPlacing(task) ? { workspace: task.workspace } : task);
      jobs.push({ task_id: task._id, scope, cause: await groundInput(ctx, task), brief });
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
    const { project, ...f } = outcome.fields;
    const placed = project && needsPlacing(task) ? await placeCause(ctx, task, project) : null;
    await patchTask(ctx, task, {
      ...f,
      ...(placed ? { project_id: placed.to._id } : {}),
      ...(task.cause ? { cause: { ...task.cause, grounded_count: task.cause.signal_count, ...(placed ? { placed: "ground" as const } : {}) } } : {}),
      updated_at: now,
    });
    await insertTaskComment(ctx, task._id, {
      author: GROUND_AUTHOR,
      comment_type: "note",
      text: `${groundedWords(f)}${placed ? ` ${placedWords(placed)}` : ""}`,
    });
    return "grounded";
  }
  const note = `The ground step could not read its answer (${outcome.error}). Ground it by hand: cast task update ${task.short_id} --goal-ref <ref> --category <kind> --risk <level> --readiness <state>`;
  await patchTask(ctx, task, { readiness: "needs_context", readiness_note: note.slice(0, 500), updated_at: now });
  await insertTaskComment(ctx, task._id, { author: GROUND_AUTHOR, comment_type: "note", text: note });
  return "unreadable";
}

/**
 * Ground places a cause (LM1): it moves to the project named, with its
 * signals, and each signal filed under another project keeps that one as
 * where it was first filed (filed_for_project_id). Null when the ref names
 * no project in the cause's workspace.
 */
async function placeCause(ctx: any, task: Doc<"tasks">, ref: string): Promise<{ to: Doc<"projects">; from: Doc<"projects"> | null } | null> {
  const rows: Doc<"projects">[] = await ctx.db.query("projects").withIndex("by_workspace", (q: any) => q.eq("workspace", task.workspace)).take(2000);
  // The brief names a project by its short id, else its id (goals.gatherGoalsBrief).
  const to = rows.find((p) => (p.short_id ?? String(p._id)) === ref) ?? null;
  if (!to) return null;
  const from: Doc<"projects"> | null = task.project_id ? await ctx.db.get(task.project_id) : null;
  if (String(to._id) === String(task.project_id)) return { to, from };
  const signals: Doc<"signals">[] = await ctx.db.query("signals").withIndex("by_task", (q: any) => q.eq("task_id", task._id)).collect();
  for (const row of signals) {
    const filedFor = row.filed_for_project_id ?? (row.project_id && String(row.project_id) !== String(to._id) ? row.project_id : undefined);
    await ctx.db.patch(row._id, { project_id: to._id, ...(filedFor ? { filed_for_project_id: filedFor } : {}) });
  }
  return { to, from };
}

/** What ground's placement adds to its note: where the cause now lives, and where a default had filed it. */
function placedWords(p: { to: Doc<"projects">; from: Doc<"projects"> | null }): string {
  if (p.from && String(p.from._id) === String(p.to._id)) return `Belongs in ${p.to.title}, where it was filed.`;
  return `Placed in ${p.to.title}${p.from ? `, moved from ${p.from.title}, where it was filed by default` : ""}.`;
}

/**
 * A grounded problem whose findings doubled or halved since its note was
 * written is grounded again: the note speaks of the findings it read ("All 3
 * reports show ..." stood on ct-59578 at 65), and a problem that grew by
 * grouping or a merge may now be a different decision. Only an open problem
 * no run holds; a run reads its findings itself. A note from before counts
 * were kept is taken as written over one finding.
 */
export async function regroundWhenRegrouped(ctx: { db: any }, taskId: Id<"tasks">, now: number): Promise<boolean> {
  const task: Doc<"tasks"> | null = await ctx.db.get(taskId);
  if (!task || task.source !== "signal" || task.status !== "open" || task.workflow_run_id || !task.readiness || !task.cause) return false;
  const was = Math.max(1, task.cause.grounded_count ?? 1);
  const held = task.cause.signal_count;
  if (held === 0 || (held < was * 2 && held * 2 > was)) return false;
  await patchTask(ctx, task, { goal_ref: undefined, category: undefined, risk: undefined, readiness: undefined, readiness_note: undefined, updated_at: now });
  return true;
}

const groundFieldsValidator = v.object({
  goal_ref: v.string(),
  category: v.union(...LINE_CATEGORIES.map((c) => v.literal(c))),
  risk: v.union(v.literal("low"), v.literal("review"), v.literal("plan")),
  readiness: v.union(v.literal("ready"), v.literal("needs_context"), v.literal("not_actionable")),
  readiness_note: v.string(),
  project: v.optional(v.string()),
});

export const record = internalMutation({
  args: { task_id: v.id("tasks"), fields: v.optional(groundFieldsValidator), error: v.optional(v.string()) },
  handler: async (ctx, args) => recordGroundCore(ctx, args.task_id, args.fields ? { fields: args.fields } : { error: args.error ?? "no answer" }, Date.now()),
});

export type GroundSweepResult = { grounded: number; unreadable: number; unanswered: number; unbudgeted: number; skipped?: string };

/**
 * One pass: ground up to GROUND_BATCH of the oldest ungrounded causes. A call
 * that gets no reply at all (no key, a timeout, an outage) leaves its cause
 * untouched for the next pass; that is no answer, not a wrong one. Each call
 * goes through the workspace's model budget (modelCalls.runModelCall), so its
 * spend is capped and counted with the line's other calls, and a cap with no
 * room leaves the cause for a later pass. Call this from crons.ts.
 */
export const sweep = internalAction({
  args: {},
  handler: async (ctx): Promise<GroundSweepResult> => {
    if (!process.env.ANTHROPIC_API_KEY) return { grounded: 0, unreadable: 0, unanswered: 0, unbudgeted: 0, skipped: "no model key" };
    const jobs: GroundJob[] = await ctx.runQuery(internal.lineGround.inputs, { limit: GROUND_BATCH });
    const now = Date.now();
    const result: GroundSweepResult = { grounded: 0, unreadable: 0, unanswered: 0, unbudgeted: 0 };
    await Promise.all(jobs.map(async (job) => {
      const req = groundRequest(job.cause, job.brief, now);
      const reply = await runModelCall(ctx, job.scope, "grouping", { model: req.model, system: req.system, prompt: req.prompt, max_tokens: req.max_tokens, output: "text", output_schema: req.output_schema }, "Line ground", 60_000);
      if (!reply.ok) { if (reply.reason === "budget") result.unbudgeted++; else result.unanswered++; return; }
      const outcome = parseGroundReply(parseJsonBlock(reply.text), briefGoalRefs(job.brief), groundPlacingProjects(job.cause, job.brief));
      const status: string = await ctx.runMutation(internal.lineGround.record, "fields" in outcome ? { task_id: job.task_id, fields: outcome.fields } : { task_id: job.task_id, error: outcome.error });
      if (status === "grounded") result.grounded++;
      else if (status === "unreadable") result.unreadable++;
    }));
    if (jobs.length === GROUND_BATCH && result.unanswered === 0 && result.unbudgeted === 0) await ctx.scheduler.runAfter(0, internal.lineGround.sweep, {});
    return result;
  },
});
