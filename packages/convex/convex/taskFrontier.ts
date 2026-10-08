// `cast task ready --claim` (docs/architecture/task-graph.md TG7): take the
// first task of the ready frontier the caller may take and start it, so two
// agents pulling from the same queue never take the same task.
//
// Two steps, so a claim's read set is a few rows rather than the workspace's
// task table. `claimCandidates` reads the frontier outside any write
// transaction (tasks.list's filters, readiness and order) and keeps the rows
// the claim rules let this caller take. `claimNextReady` re-reads only those
// rows, their blockers and parents, re-checks readiness and the rules, and
// starts the first that still passes through tasks.update (ownership, role,
// history, pulse side effects) as a nested call. Two racing claims read the
// same candidate row, so one conflicts and retries against the other's start;
// an unrelated task write no longer invalidates a claim.

import { v } from "convex/values";
import type { GenericActionCtx } from "convex/server";
import type { Doc } from "./_generated/dataModel";
import { api, internal } from "./_generated/api";
import { internalMutation, internalQuery } from "./functions";
import { verifyApiToken } from "./apiTokens";
import { canAccessTask, resolveSessionConversation } from "./lib/access";
import { readinessLookups } from "./lib/taskGraph";
import { assigneeNamesFor, heldError, holdingDecisionFor, roleOf } from "./tasks";
import { isStaleTask, readinessOf } from "@codecast/shared/tasks";

/** How many candidates one claim may try before it gives up. A candidate is
 *  passed over only when it changed since the frontier was read, or its start
 *  is refused (another live owner). */
const CLAIM_CANDIDATES = 10;
/** The candidate read looks through the whole frontier: tasks.list has
 *  already read every row to judge readiness, and the rows a claim may take
 *  can sit below any number that belong to someone else. */
const WHOLE_FRONTIER = Number.MAX_SAFE_INTEGER;

type ClaimResult = {
  task: { short_id: string; title: string; priority: string } | null;
  plan_id?: string;
  assigned_role?: { handle: string; name: string };
  released_owners?: Array<{ short_id: string; title: string | null; live: boolean }>;
  /** Candidates refused at claim time, with the reason. */
  skipped: Array<{ short_id: string; reason: string }>;
  /** More claimable rows exist past the candidates tried: narrow the filters. */
  more?: boolean;
};

// The ready list's filters (tasks.list).
const frontierFilterArgs = {
  project_id: v.optional(v.string()),
  project_path: v.optional(v.string()),
  plan_id: v.optional(v.string()),
  query: v.optional(v.string()),
  label: v.optional(v.string()),
  assignee: v.optional(v.string()),
  include_subtasks: v.optional(v.boolean()),
  team: v.optional(v.boolean()),
  workspace: v.optional(v.union(v.literal("personal"), v.literal("team"))),
  team_id: v.optional(v.id("teams")),
};

// Who claims, as `cast task start` sends it: the caller's own session, else
// the person at a terminal. `stale` lets a claim take a task nobody touched
// in 30 days, which `cast task ready` folds away.
const claimantArgs = {
  api_token: v.string(),
  conversation_id: v.optional(v.string()),
  stale: v.optional(v.boolean()),
};

/** `session` is the conversation `_id` readiness takes as `viewerSession`. */
type Claimant = { userId: string; conv: Doc<"conversations"> | null; session: string | null };

async function claimantOf(ctx: any, userId: any, conversationId: string | undefined): Promise<Claimant> {
  const conv = conversationId ? await resolveSessionConversation(ctx, userId, conversationId) : null;
  return { userId: String(userId), conv, session: conv ? String(conv._id) : null };
}

/**
 * Why a claim may not take this ready task, or null when it may. A claim
 * picks the task for the caller, so it takes only what is already theirs to
 * pick up: unassigned work, or work assigned to the caller or the role its
 * session works for. A teammate's task is theirs, and a blocking decision
 * holds a task for everyone, a person included (a person moves past a hold
 * only by starting the task by name). Whose ephemeral task is whose is
 * readiness's rule (`ownsEphemeral`), applied by both steps' readiness reads.
 */
async function claimRefusal(ctx: any, task: any, claimant: Claimant, stale: boolean | undefined): Promise<string | null> {
  if (!stale && isStaleTask(task, Date.now())) return "untouched 30+ days (claim with --stale)";
  const assignee: string | undefined = task.assignee || undefined;
  // Work handed to agents is any session's to take, never a person's claim.
  if (assignee?.startsWith("agent:")) {
    if (!claimant.conv) return "assigned to an agent";
  } else if (assignee && assignee !== claimant.userId && assignee !== roleOf(claimant.conv)) {
    return `assigned to ${task.assignee_name ?? (await assigneeNamesFor(ctx, [assignee]))[assignee] ?? assignee}`;
  }
  const hold = await holdingDecisionFor(ctx, task, "in_progress");
  return hold ? heldError(hold).message : null;
}

/** The frontier rows this caller may claim, in frontier order. */
export const claimCandidates = internalQuery({
  args: { ...claimantArgs, ...frontierFilterArgs },
  handler: async (ctx, args): Promise<{ candidates: string[]; more: boolean }> => {
    const { api_token, conversation_id, stale, ...filters } = args;
    const auth = await verifyApiToken(ctx, api_token, false);
    if (!auth) throw new Error("Unauthorized");
    const claimant = await claimantOf(ctx, auth.userId, conversation_id);
    const frontier = await ctx.runQuery(api.tasks.list, {
      api_token, ...filters, ...(conversation_id ? { conversation_id } : {}), ready: true, limit: WHOLE_FRONTIER,
    });
    const candidates: string[] = [];
    for (const row of frontier) {
      if (await claimRefusal(ctx, row, claimant, stale)) continue;
      if (candidates.length === CLAIM_CANDIDATES) return { candidates, more: true };
      candidates.push(row.short_id);
    }
    return { candidates, more: false };
  },
});

/** Start the first candidate that is still ready and still the caller's to take. */
export const claimNextReady = internalMutation({
  args: { ...claimantArgs, candidates: v.array(v.string()), include_subtasks: v.optional(v.boolean()) },
  handler: async (ctx, args): Promise<ClaimResult> => {
    const auth = await verifyApiToken(ctx, args.api_token);
    if (!auth) throw new Error("Unauthorized");
    const claimant = await claimantOf(ctx, auth.userId, args.conversation_id);
    const rows = await Promise.all(args.candidates.map((shortId) =>
      ctx.db.query("tasks").withIndex("by_short_id", (q) => q.eq("short_id", shortId)).first()));
    const visible: Doc<"tasks">[] = [];
    for (const row of rows) if (row && (await canAccessTask(ctx, auth.userId, row))) visible.push(row);
    const lookups = await readinessLookups(ctx, visible);
    const skipped: ClaimResult["skipped"] = [];
    for (const task of visible) {
      const verdict = readinessOf(task, { ...lookups, viewer: claimant.userId, viewerSession: claimant.session, includeSubtasks: args.include_subtasks });
      const reason = verdict.ready
        ? await claimRefusal(ctx, task, claimant, args.stale)
        : verdict.reason === "status" ? `already ${task.status}` : `no longer ready (${verdict.reason})`;
      if (reason) {
        skipped.push({ short_id: task.short_id, reason });
        continue;
      }
      try {
        const started = await ctx.runMutation(api.tasks.update, {
          api_token: args.api_token,
          short_id: task.short_id,
          status: "in_progress",
          ...(args.conversation_id ? { conversation_id: args.conversation_id } : { assignee: "me" }),
        });
        return {
          task: { short_id: task.short_id, title: task.title, priority: task.priority },
          plan_id: started.plan_id,
          assigned_role: started.assigned_role,
          released_owners: started.released_owners,
          skipped,
        };
      } catch (err) {
        // The refused start rolled back on its own; the next candidate is tried.
        skipped.push({ short_id: task.short_id, reason: err instanceof Error ? err.message : String(err) });
      }
    }
    return { task: null, skipped };
  },
});

/** `/cli/work/claim`: read the candidates, then claim one. */
export async function claimFrontier(
  ctx: Pick<GenericActionCtx<any>, "runQuery" | "runMutation">,
  args: { api_token: string; conversation_id?: string; stale?: boolean } & Record<string, any>,
): Promise<ClaimResult> {
  const { candidates, more } = await ctx.runQuery(internal.taskFrontier.claimCandidates, args as any);
  if (!candidates.length) return { task: null, skipped: [], more };
  const claim: ClaimResult = await ctx.runMutation(internal.taskFrontier.claimNextReady, {
    api_token: args.api_token,
    candidates,
    ...(args.conversation_id ? { conversation_id: args.conversation_id } : {}),
    ...(args.stale ? { stale: true } : {}),
    ...(args.include_subtasks ? { include_subtasks: true } : {}),
  });
  return { ...claim, ...(!claim.task && more ? { more } : {}) };
}
