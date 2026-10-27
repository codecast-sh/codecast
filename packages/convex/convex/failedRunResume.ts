// `cast workflow resume`: a failed line run, or an approved one whose merge was
// left to a person, tried again from a station of its graph, now, or once its
// own machine has a free run slot (a queued resume, which the line's sweep
// carries out ahead of new starts: orgLine.planSweep).
import { ConvexError, v } from "convex/values";
import { isTerminalTaskStatus } from "@codecast/shared/tasks";
import { endedFailing, endedUnmerged } from "@codecast/shared/contracts/changeCard";
import { mutation } from "./functions";
import type { Doc, Id } from "./_generated/dataModel";
import { verifyApiToken } from "./apiTokens";
import { trialProjectOf } from "./lineTrial";
import { repinRunForResume } from "./flowVersions";
import { canReadRun, resumeRunAt } from "./workflow_runs";

type Ctx = { db: any };

const resumable = (run: Doc<"workflow_runs">): boolean => endedFailing(run) || endedUnmerged(run);

/**
 * `cast workflow resume <task> --at <station>`: a failed run tried again from a station of its graph, on its own
 * branch, once its lead has fixed what failed it. The owner resumes it, as with reask. The run keeps what it made, and
 * a resume is a new attempt: the visits the earlier attempt used, the cap that stops a loop within one attempt, count
 * again from now (`visits_reset_at`, which the runner reads). The caller checks the station against the graph the run
 * will read (as it is now, which the stored workflow may predate). A trial problem resumes under its trial's limits
 * (cast line trial rerun <task> --at). An approved run whose merge station left the merge to a person (the switch was
 * off, the day's limit used) resumes the same way, at its merge station.
 */
export async function resumeFailedRunCore(ctx: Ctx, userId: Id<"users">, runId: Id<"workflow_runs">, at: string, opts: { check?: boolean; currentFlow?: boolean; queue?: boolean } = {}, now = Date.now()) {
  const run = await ctx.db.get(runId);
  if (!run || !(await canReadRun(ctx, userId, run))) throw new ConvexError("Run not found");
  if (String(run.user_id) !== String(userId)) throw new ConvexError("Only the run's owner resumes it");
  const task = run.task_id ? await ctx.db.get(run.task_id) : null;
  if (task && isTerminalTaskStatus(task.status)) throw new ConvexError(`${task.short_id} is ${task.status}: a closed problem is not resumed`);
  if (task && (await trialProjectOf(ctx, task))) throw new ConvexError(`${task.short_id} is a trial problem: cast flow trial rerun ${task.short_id} --at <station> resumes it under the trial's budget`);
  if (!resumable(run)) throw new ConvexError(`The run is ${run.status}: only a failed run, or an approved one whose merge was left to a person, is resumed at a station (a run waiting on a decision is asked again with cast workflow reask)`);
  const node = at.trim();
  if (!node) throw new ConvexError("Name the station to resume at");
  if (!run.runner_device) throw new ConvexError("The run names no machine to pick it up");
  // A run reads the flow versions it started on, resume included; --current-flow moves it onto the current ones first
  // (a queued resume moves when it resumes, onto the versions current then).
  if (opts.currentFlow) await repinRunForResume(ctx, run, node, { check: opts.check || opts.queue });
  if (opts.check) return { run_id: run._id, task: task?.short_id ?? null, resumed_at: node, queued: false };
  // --queue: the line's sweep resumes it once its own machine has a free run slot, ahead of new starts (orgLine.planSweep).
  if (opts.queue) {
    await ctx.db.patch(run._id, { resume_queued: { at: node, ...(opts.currentFlow ? { current_flow: true } : {}), by: userId, since: now }, updated_at: now });
    return { run_id: run._id, task: task?.short_id ?? null, resumed_at: node, queued: true };
  }
  await resumeRunAt(ctx, userId, run, node, now, { newAttempt: true });
  return { run_id: run._id, task: task?.short_id ?? null, resumed_at: node, queued: false };
}

/**
 * A queued resume (resumeFailedRunCore's `queue`), carried out by the line's sweep once the run's machine has a free
 * slot. It no longer applies to a run that moved since (resumed some other way, or its problem closed): the queue is
 * cleared and nothing starts. A current flow that lost the station also clears it, and the run stays failed.
 */
export async function resumeQueuedRun(ctx: Ctx, runId: Id<"workflow_runs">, now = Date.now()): Promise<string | null> {
  const run: Doc<"workflow_runs"> | null = await ctx.db.get(runId);
  const queued = run?.resume_queued;
  if (!run || !queued) return null;
  const task = run.task_id ? await ctx.db.get(run.task_id) : null;
  const drop = async () => { await ctx.db.patch(run._id, { resume_queued: undefined }); return null; };
  if (!resumable(run) || !run.runner_device || (task && isTerminalTaskStatus(task.status))) return drop();
  if (queued.current_flow) {
    try {
      await repinRunForResume(ctx, run, queued.at);
    } catch {
      return drop();
    }
  }
  await resumeRunAt(ctx, queued.by, run, queued.at, now, { newAttempt: true });
  return String(run._id);
}

export const resumeFromCli = mutation({
  args: { api_token: v.string(), run_id: v.id("workflow_runs"), at: v.string(), check: v.optional(v.boolean()), current_flow: v.optional(v.boolean()), queue: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token, false);
    if (!auth) return { error: "Unauthorized" };
    return resumeFailedRunCore(ctx, auth.userId, args.run_id, args.at, { check: args.check, currentFlow: args.current_flow, queue: args.queue });
  },
});
