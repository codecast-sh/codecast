// Priorities (shared/contracts/priorities.ts): the reads behind /priorities,
// the pin line and `cast priorities`, and the person's own controls over them.
//
// Access follows the workspace's sharing settings (lib/priorityAccess.ts): a
// priority is readable by its owner, and by a teammate holding its `workspace`
// key only while the owner lists their sessions to that team; nothing is
// readable, writable or run while the `priorities` feature is off there. Only the owner
// changes a priority, and every change marks its field set by the person, so
// the pass (lib/priorityPass.ts, priorityPassRun applyPlan) never overrides it:
// a placed rank; a milestone's tier, done state, title and drop (steps are milestones);
// set aside, done and merge; a session's move and "not this". Corrections are
// the person's words to the pass, read by every later pass until deleted. A
// merge the pass would make waits for the owner as a proposal they accept or
// reject (priorityWrite doAnswerProposal).

import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { internalQuery, mutation, query } from "./functions";
import { internal } from "./_generated/api";
import { accessStampFromDoc, authorizedFor, heldKeysFor, parseWorkspaceKey } from "./lib/accessKeys";
import { teamFeatureOffMessage } from "./lib/teamFeatureGuard";
import { FEATURE, featureCheck, readerFor, type Reader } from "./lib/priorityAccess";
import { hasOkRun, runBlocker } from "./priorityPassRun";
import { sessionVisibility } from "./lib/prioritySessionVisibility";
import type { PriorityDetail, PriorityHistory, PriorityList, PriorityPinLine } from "@codecast/shared/contracts/priorities";
import type { Doc, Id } from "./_generated/dataModel";
import { type Priority, type Result, cliWorkspace, criticalCounts, isOwner, listFor, positionOf, showFor, tokenUser } from "./priorityRead";
import { historyFor } from "./priorityHistory";
import { type MilestoneChange, doAnswerProposal, doCorrect, doCorrectionDelete, doMerge, doMilestone, doMove, doPriorityDone, doSessionMove, doSessionNotThis, doSetAside, doUndoPriorityDone } from "./priorityWrite";

function orThrow<T>(res: Result<T>): T {
  if (res && typeof res === "object" && "error" in res) throw new Error(res.error);
  return res as T;
}

const statusArg = v.optional(v.union(v.literal("active"), v.literal("done"), v.literal("quiet"), v.literal("set_aside"), v.literal("merged")));
const tierArg = v.union(v.literal("critical"), v.literal("polish"));
const setByArg = v.union(v.literal("pass"), v.literal("person"));
/** What a person's done replaced (shared/contracts/priorities PriorDone). */
const priorDoneArg = v.object({
  status: v.union(v.literal("active"), v.literal("quiet"), v.literal("set_aside")),
  status_set_by: v.optional(setByArg),
  person_pos: v.optional(v.number()),
  ai_rank: v.optional(v.number()),
});
const cliScope = { team_id: v.optional(v.id("teams")), personal: v.optional(v.boolean()) };

// ── Web (signed-in user) ─────────────────────────────────────────────────

export const list = query({
  args: { workspace: v.optional(v.string()), status: statusArg, all: v.optional(v.boolean()) },
  handler: async (ctx, args): Promise<PriorityList | null> => {
    const viewer = await getAuthUserId(ctx);
    if (!viewer) return null;
    return listFor(ctx, viewer, args);
  },
});

export const show = query({
  args: { short_id: v.string() },
  handler: async (ctx, { short_id }): Promise<PriorityDetail | null> => {
    const viewer = await getAuthUserId(ctx);
    if (!viewer) return null;
    const res = await showFor(ctx, viewer, short_id);
    return "error" in res ? null : res;
  },
});

export const history = query({
  args: { days: v.optional(v.number()), workspace: v.optional(v.string()), tz_offset_minutes: v.optional(v.number()) },
  handler: async (ctx, args): Promise<PriorityHistory> => {
    const viewer = await getAuthUserId(ctx);
    if (!viewer) return { days: [], lanes: [] };
    return historyFor(ctx, viewer, args);
  },
});

/**
 * The line under a mapped session's pinned state: for the priority's owner,
 * and for a teammate holding its workspace key when this open session is
 * listed to that team and the priority needs no rewrite (summary level is
 * enough: the line names the priority, not the transcript). No scan of the
 * priority's other sessions: one conversation read, one priority read, the
 * owner's membership, and the owner's active priorities for its position.
 */
export const pinLine = query({
  args: { conversation_id: v.id("conversations") },
  handler: async (ctx, { conversation_id }): Promise<PriorityPinLine | null> => {
    const viewer = await getAuthUserId(ctx);
    if (!viewer) return null;
    const conv = await ctx.db.get(conversation_id);
    if (!conv?.priority_id) return null;
    const p = await ctx.db.get(conv.priority_id);
    if (!p || p.status === "merged") return null;
    // Only the open session is judged: the owner's, or a teammate's listed to the team that holds the priority.
    if (String(p.user_id) !== String(viewer)) {
      const ws = parseWorkspaceKey(p.workspace);
      if (p.needs_rewrite || ws?.type !== "team" || !authorizedFor(accessStampFromDoc("priorities", p), String(viewer), await heldKeysFor(ctx, viewer))) return null;
      if (!(await sessionVisibility(ctx).listedTo(conv, ws.teamId))) return null;
    }
    if (!(await featureCheck(ctx)(p.workspace))) return null;
    // A teammate reads a step only as the page shows it to them (Reader.stepsFor): never one written from a session they cannot see.
    const steps = isOwner(viewer, p) ? p.steps : await (await readerFor(ctx, viewer)).stepsFor(p);
    const step = steps.find((s) => s.key === conv.priority_step_key && !s.dropped);
    return {
      short_id: p.short_id,
      title: p.title,
      rank: await positionOf(ctx, viewer, p),
      ...criticalCounts(p),
      ...(step ? { step_title: step.title } : {}),
    };
  },
});

async function authed(ctx: any): Promise<Id<"users">> {
  const viewer = await getAuthUserId(ctx);
  if (!viewer) throw new Error("Not signed in");
  return viewer;
}

export const moveTo = mutation({
  args: { short_id: v.string(), to: v.number() },
  handler: async (ctx, args) => orThrow(await doMove(ctx, await authed(ctx), args.short_id, args.to)),
});

export const moveUp = mutation({
  args: { short_id: v.string() },
  handler: async (ctx, args) => orThrow(await doMove(ctx, await authed(ctx), args.short_id, "up")),
});

export const moveDown = mutation({
  args: { short_id: v.string() },
  handler: async (ctx, args) => orThrow(await doMove(ctx, await authed(ctx), args.short_id, "down")),
});

export const setStepTier = mutation({
  args: { short_id: v.string(), step_key: v.string(), tier: tierArg },
  handler: async (ctx, args) => orThrow(await doMilestone(ctx, await authed(ctx), args.short_id, args.step_key, { tier: args.tier })),
});

export const setStepDone = mutation({
  args: { short_id: v.string(), step_key: v.string(), done: v.boolean() },
  handler: async (ctx, args) => orThrow(await doMilestone(ctx, await authed(ctx), args.short_id, args.step_key, { done: args.done })),
});

/** The undo of the person's own milestone done: open again, its done state back with whoever held it (`set_by`; none: the pass). */
export const undoStepDone = mutation({
  args: { short_id: v.string(), step_key: v.string(), set_by: v.optional(setByArg) },
  handler: async (ctx, args) => orThrow(await doMilestone(ctx, await authed(ctx), args.short_id, args.step_key, { undoDone: args.set_by ?? null })),
});

export const renameStep = mutation({
  args: { short_id: v.string(), step_key: v.string(), title: v.string() },
  handler: async (ctx, args) => orThrow(await doMilestone(ctx, await authed(ctx), args.short_id, args.step_key, { title: args.title })),
});

export const dropStep = mutation({
  args: { short_id: v.string(), step_key: v.string() },
  handler: async (ctx, args) => orThrow(await doMilestone(ctx, await authed(ctx), args.short_id, args.step_key, { drop: true })),
});

export const markDone = mutation({
  args: { short_id: v.string() },
  handler: async (ctx, args) => orThrow(await doPriorityDone(ctx, await authed(ctx), args.short_id)),
});

/** The undo of the person's own Mark done: back to the status and place it had. */
export const undoDone = mutation({
  args: { short_id: v.string(), prior: priorDoneArg },
  handler: async (ctx, args) => orThrow(await doUndoPriorityDone(ctx, await authed(ctx), args.short_id, args.prior)),
});

export const merge = mutation({
  args: { short_id: v.string(), into: v.string() },
  handler: async (ctx, args) => orThrow(await doMerge(ctx, await authed(ctx), args.short_id, args.into)),
});

export const moveSession = mutation({
  args: { session: v.string(), short_id: v.string(), step_key: v.optional(v.string()) },
  handler: async (ctx, args) => orThrow(await doSessionMove(ctx, await authed(ctx), args.session, args.short_id, args.step_key)),
});

export const sessionNotThis = mutation({
  args: { session: v.string() },
  handler: async (ctx, args) => orThrow(await doSessionNotThis(ctx, await authed(ctx), args.session)),
});

export const correct = mutation({
  args: { short_id: v.string(), text: v.string(), step_key: v.optional(v.string()), client_key: v.optional(v.string()) },
  handler: async (ctx, args) => orThrow(await doCorrect(ctx, await authed(ctx), args.short_id, args.text, args.step_key, args.client_key)),
});

export const deleteCorrection = mutation({
  args: { correction_id: v.string() },
  handler: async (ctx, args) => orThrow(await doCorrectionDelete(ctx, await authed(ctx), args.correction_id)),
});

/** The person answers a merge the pass proposed (PriorityMergeProposal): accept merges as the pass would have, reject keeps them apart for good. */
export const answerProposal = mutation({
  args: { proposal: v.string(), accept: v.boolean() },
  handler: async (ctx, args) => orThrow(await doAnswerProposal(ctx, await authed(ctx), args.proposal, args.accept)),
});

export const setAside = mutation({
  args: { short_id: v.string() },
  handler: async (ctx, args) => orThrow(await doSetAside(ctx, await authed(ctx), args.short_id, true)),
});

export const restore = mutation({
  args: { short_id: v.string() },
  handler: async (ctx, args) => orThrow(await doSetAside(ctx, await authed(ctx), args.short_id, false)),
});

// ── CLI (api token) ──────────────────────────────────────────────────────

export const cliList = query({
  args: { api_token: v.string(), status: statusArg, all: v.optional(v.boolean()), ...cliScope },
  handler: async (ctx, args) => {
    const viewer = await tokenUser(ctx, args.api_token);
    if (!viewer) return { error: "Unauthorized" };
    return await listFor(ctx, viewer, { workspace: cliWorkspace(viewer, args), status: args.status, all: args.all });
  },
});

export const cliShow = query({
  args: { api_token: v.string(), short_id: v.string() },
  handler: async (ctx, args) => {
    const viewer = await tokenUser(ctx, args.api_token);
    if (!viewer) return { error: "Unauthorized" };
    return await showFor(ctx, viewer, args.short_id);
  },
});

export const cliHistory = query({
  args: { api_token: v.string(), days: v.optional(v.number()), tz_offset_minutes: v.optional(v.number()), ...cliScope },
  handler: async (ctx, args) => {
    const viewer = await tokenUser(ctx, args.api_token);
    if (!viewer) return { error: "Unauthorized" };
    return historyFor(ctx, viewer, { days: args.days, tz_offset_minutes: args.tz_offset_minutes, workspace: cliWorkspace(viewer, args) });
  },
});

/** `cast priorities rank <id> <n>`: move to position n. */
export const cliMove = mutation({
  args: { api_token: v.string(), short_id: v.string(), to: v.number() },
  handler: async (ctx, args) => {
    const viewer = await tokenUser(ctx, args.api_token);
    if (!viewer) return { error: "Unauthorized" };
    return doMove(ctx, viewer, args.short_id, args.to);
  },
});

export const cliSetStepTier = mutation({
  args: { api_token: v.string(), short_id: v.string(), step_key: v.string(), tier: tierArg },
  handler: async (ctx, args) => {
    const viewer = await tokenUser(ctx, args.api_token);
    if (!viewer) return { error: "Unauthorized" };
    return doMilestone(ctx, viewer, args.short_id, args.step_key, { tier: args.tier });
  },
});

/** `cast priorities milestone done|undone|rename|drop`: one change to one milestone. */
export const cliMilestone = mutation({
  args: { api_token: v.string(), short_id: v.string(), step_key: v.string(), done: v.optional(v.boolean()), title: v.optional(v.string()), drop: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const viewer = await tokenUser(ctx, args.api_token);
    if (!viewer) return { error: "Unauthorized" };
    const changes = [args.done !== undefined, args.title !== undefined, !!args.drop].filter(Boolean).length;
    if (changes !== 1) return { error: "name exactly one change: done, title or drop" };
    const change: MilestoneChange = args.done !== undefined ? { done: args.done } : args.title !== undefined ? { title: args.title } : { drop: true };
    return doMilestone(ctx, viewer, args.short_id, args.step_key, change);
  },
});

export const cliDone = mutation({
  args: { api_token: v.string(), short_id: v.string() },
  handler: async (ctx, args) => {
    const viewer = await tokenUser(ctx, args.api_token);
    if (!viewer) return { error: "Unauthorized" };
    return doPriorityDone(ctx, viewer, args.short_id);
  },
});

export const cliMerge = mutation({
  args: { api_token: v.string(), short_id: v.string(), into: v.string() },
  handler: async (ctx, args) => {
    const viewer = await tokenUser(ctx, args.api_token);
    if (!viewer) return { error: "Unauthorized" };
    return doMerge(ctx, viewer, args.short_id, args.into);
  },
});

export const cliMoveSession = mutation({
  args: { api_token: v.string(), session: v.string(), short_id: v.string(), step_key: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const viewer = await tokenUser(ctx, args.api_token);
    if (!viewer) return { error: "Unauthorized" };
    return doSessionMove(ctx, viewer, args.session, args.short_id, args.step_key);
  },
});

export const cliSessionNotThis = mutation({
  args: { api_token: v.string(), session: v.string() },
  handler: async (ctx, args) => {
    const viewer = await tokenUser(ctx, args.api_token);
    if (!viewer) return { error: "Unauthorized" };
    return doSessionNotThis(ctx, viewer, args.session);
  },
});

export const cliCorrect = mutation({
  args: { api_token: v.string(), short_id: v.string(), text: v.string(), step_key: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const viewer = await tokenUser(ctx, args.api_token);
    if (!viewer) return { error: "Unauthorized" };
    return doCorrect(ctx, viewer, args.short_id, args.text, args.step_key);
  },
});

export const cliDeleteCorrection = mutation({
  args: { api_token: v.string(), correction_id: v.string() },
  handler: async (ctx, args) => {
    const viewer = await tokenUser(ctx, args.api_token);
    if (!viewer) return { error: "Unauthorized" };
    return doCorrectionDelete(ctx, viewer, args.correction_id);
  },
});

/** `cast priorities accept|reject <proposal>`: by its id, or by a priority one pending proposal names. */
export const cliAnswerProposal = mutation({
  args: { api_token: v.string(), proposal: v.string(), accept: v.boolean() },
  handler: async (ctx, args) => {
    const viewer = await tokenUser(ctx, args.api_token);
    if (!viewer) return { error: "Unauthorized" };
    return doAnswerProposal(ctx, viewer, args.proposal, args.accept);
  },
});

export const cliSetAside = mutation({
  args: { api_token: v.string(), short_id: v.string() },
  handler: async (ctx, args) => {
    const viewer = await tokenUser(ctx, args.api_token);
    if (!viewer) return { error: "Unauthorized" };
    return doSetAside(ctx, viewer, args.short_id, true);
  },
});

export const cliRestore = mutation({
  args: { api_token: v.string(), short_id: v.string() },
  handler: async (ctx, args) => {
    const viewer = await tokenUser(ctx, args.api_token);
    if (!viewer) return { error: "Unauthorized" };
    return doSetAside(ctx, viewer, args.short_id, false);
  },
});

/**
 * One pass now, for the caller, in the named workspace (one they belong to)
 * or in every workspace of theirs with the feature on. Returns at once with
 * what was scheduled and the plain reason runNow would refuse any other.
 */
async function runFor(ctx: any, viewer: Id<"users">, named: string | undefined): Promise<Result<{ scheduled: string[]; skipped: Array<{ workspace: string; reason: string }>; note: string }>> {
  const held = await heldKeysFor(ctx, viewer);
  if (named && !held.has(named)) return { error: "you are not a member of that team" };
  const featureOn = featureCheck(ctx);
  const now = Date.now();
  const scheduled: string[] = [];
  const skipped: Array<{ workspace: string; reason: string }> = [];
  let first = false;
  for (const workspace of named ? [named] : held) {
    if (!(await featureOn(workspace))) continue;
    // runNow's own checks, read-only: reserve decides for real when the pass starts.
    const catchUp = !(await hasOkRun(ctx, viewer, workspace));
    const blocked = await runBlocker(ctx, viewer, workspace, now, true, catchUp);
    if (blocked && "kind" in blocked) { skipped.push({ workspace, reason: blocked.reason }); continue; }
    first ||= catchUp;
    await ctx.scheduler.runAfter(0, (internal as any).priorityPassRun.runNow, { user_id: viewer, workspace });
    scheduled.push(workspace);
  }
  if (!scheduled.length) return { error: skipped.length ? skipped.map((s) => s.reason).join(" ") : teamFeatureOffMessage(FEATURE) };
  const note = first
    ? "A pass is running; results land in a few minutes. This first catch-up reads your last two weeks, oldest work first, over a few runs."
    : "A pass is running; results land in a few minutes.";
  return { scheduled, skipped, note };
}

/** `cast priorities run`. */
export const cliRun = mutation({
  args: { api_token: v.string(), ...cliScope },
  handler: async (ctx, args) => {
    const viewer = await tokenUser(ctx, args.api_token);
    if (!viewer) return { error: "Unauthorized" };
    return runFor(ctx, viewer, cliWorkspace(viewer, args));
  },
});

/** The web's Run now (dispatch runPriorities): one pass in a workspace, refused with the same plain reasons. */
export const run = mutation({
  args: { workspace: v.string() },
  handler: async (ctx, args) => orThrow(await runFor(ctx, await authed(ctx), args.workspace)),
});

/** The most correction cases one export returns, oldest applied first from `since`. */
const EXPORT_CASES = 200;

/**
 * Every correction a pass applied after `since` (its applied_at), oldest
 * first, as an eval case: the priority as the person saw it when they wrote
 * it (`before`, the snapshot), their words, the window the pass that applied
 * it read (`window`: replay it with priorityPassEval evalPass, window_start to
 * window.to), and the priority as it stands now (`after`). A correction no
 * pass has read yet is not a case: its after is its before. Staff read it
 * through packages/convex/run.sh; packages/evals/scripts/
 * priority-corrections-export.ts freezes each case under EVALS_HOME. Real
 * content: never written into the repo.
 */
export const exportCases = internalQuery({
  args: { since: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const rows: Doc<"priority_corrections">[] = await ctx.db
      .query("priority_corrections")
      .withIndex("by_applied", (q: any) => q.gt("applied_at", args.since ?? 0))
      .take(EXPORT_CASES);
    const out = [];
    for (const c of rows) {
      // One applied unread (superseded) taught the pass nothing, and one the person deleted they took back: neither is a case.
      if (c.superseded || c.deleted_at) continue;
      const now: Priority | null = await ctx.db.get(c.priority_id);
      out.push({
        id: c._id, user_id: c.user_id, workspace: c.workspace, created_at: c.created_at, applied_at: c.applied_at!, window: c.applied_window ?? null,
        step_key: c.step_key ?? null, text: c.text, before: c.snapshot,
        after: now ? { short_id: now.short_id, title: now.title, summary: now.summary, status: now.status, steps: now.steps } : null,
      });
    }
    return { cases: out, more: rows.length === EXPORT_CASES };
  },
});
