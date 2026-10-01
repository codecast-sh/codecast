// The line's merge step (docs/architecture/the-line.md L12). A line may end
// in a merge of the approved branch into the default branch when its checks
// pass. Two things allow it, and both are a person's: the role's `merge`
// authority grant (org-hire.md H4: kind write, id "merge", a per_day limit;
// the one the Release Captain template carries) and the line's own switch,
// `org_roles.line_merge`, off unless a person turns it on for that line. The
// runner's merge node asks `check` before it touches git and `record` after
// the push; the second re-reads the allowance inside the write, so two runs
// cannot both take the last merge of the day.

import { mutation, query } from "./functions";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { verifyApiToken } from "./apiTokens";
import { requireRole, userCanAccessRole } from "./lib/orgAccess";
import { countersFor } from "./lib/orgCaps";
import { mergeReportLine } from "./lib/orgRoutine";
import { MERGE_AUTHORITY_ID, MERGE_AUTHORITY_LABEL, mergeAllowance, mergeGrantOf } from "./lib/lineMerge";
export { MERGE_AUTHORITY_ID, MERGE_AUTHORITY_LABEL, mergeAllowance, mergeGrantOf, type MergeAllowance } from "./lib/lineMerge";
import { performSetAuthority, refuseUnlessHuman } from "./orgRoles";
import { insertTaskComment } from "./tasks";
import { getAuthenticatedUserId, tellRole } from "./pendingMessages";
import { roleOfConversation } from "./lib/actor";

/** The pull request a handoff named in its evidence ("PR: <url>", taskClaim
 *  handoffCommentText), or null. */
export function prUrlFromEvidence(evidence: string | null | undefined): string | null {
  const m = (evidence ?? "").match(/^PR:\s*(https?:\/\/\S+)\s*$/m);
  return m ? m[1] : null;
}

/** The role behind a run: its spawner is the role's standing session (L9). */
export async function roleOfRun(ctx: { db: any }, run: { spawner_conversation_id?: Id<"conversations"> | null; primary_conversation_id?: Id<"conversations"> | null }): Promise<any | null> {
  for (const id of [run.spawner_conversation_id, run.primary_conversation_id]) {
    if (!id) continue;
    const conv = await ctx.db.get(id);
    if (!conv) continue;
    const role = await roleOfConversation(ctx, conv);
    if (role) return role;
  }
  return null;
}

// `cast role line <handle> --merge on|off [--per-day N]`: the line's switch
// (human only, logged like the line itself). Turning it on needs a merge
// grant: one the role already holds, or one written here from --per-day in
// the same gesture, through the one authority path.
export async function performSetLineMerge(
  ctx: any,
  userId: Id<"users">,
  args: { role_id: string; on: boolean; per_day?: number; from_session?: string; api_token?: string; human_decision?: string },
): Promise<any> {
  await refuseUnlessHuman(ctx, args, "The line's merge step");
  let role = await requireRole(ctx, userId, args.role_id, "admin");
  if (role.status === "retired") throw new Error("That role is retired");
  const now = Date.now();
  if (args.on) {
    const held = mergeGrantOf(role, now);
    if (args.per_day !== undefined) {
      if (!(Number.isInteger(args.per_day) && args.per_day >= 1)) throw new Error("--per-day is a whole number of merges a day, at least 1");
      role = await performSetAuthority(ctx, userId, {
        role_id: String(role._id),
        authority: [{ id: MERGE_AUTHORITY_ID, kind: "write", label: held?.label ?? MERGE_AUTHORITY_LABEL, scope: "the project's repository, into its default branch", limit: { per_day: args.per_day }, expires: "90d" }],
        human_decision: args.human_decision,
      });
    } else if (!held) {
      throw new Error("Turning the merge step on needs a merge authority with a daily limit: pass --per-day <n>, or grant one with cast role authority");
    }
  }
  const was = !!role.line_merge;
  if (was !== args.on) {
    await ctx.db.patch(role._id, { line_merge: args.on ? true : undefined, updated_at: now });
    await ctx.db.insert("org_role_history", {
      role_id: role._id, user_id: userId, actor_type: "user", action: "line_merge", field: "line_merge",
      old_value: String(was), new_value: String(args.on), created_at: now,
    });
  }
  const updated = await ctx.db.get(role._id);
  return { ...updated, merge: mergeAllowance(updated, now) };
}

async function requireToken(ctx: any, apiToken: string): Promise<Id<"users">> {
  const auth = await verifyApiToken(ctx, apiToken);
  if (!auth) throw new Error("Unauthorized");
  return auth.userId;
}

async function runAndRole(ctx: any, userId: Id<"users">, runRef: string): Promise<{ run: any; role: any }> {
  const run = await ctx.db.get(runRef as Id<"workflow_runs">);
  if (!run) throw new Error(`No run ${runRef}`);
  const role = await roleOfRun(ctx, run);
  if (!role) throw new Error("This run was not started by a role's line, so it has no merge authority to merge under");
  if (!(await userCanAccessRole(ctx, userId, role))) throw new Error("Forbidden");
  return { run, role };
}

/** Before the merge: may this run's line merge now? Never writes. */
export const check = query({
  args: { api_token: v.string(), run_id: v.string() },
  handler: async (ctx, args) => {
    const userId = await requireToken(ctx, args.api_token);
    const { run, role } = await runAndRole(ctx, userId, args.run_id);
    const task: any = run.task_id ? await ctx.db.get(run.task_id) : null;
    return { role: { short_id: role.short_id, handle: role.handle, name: role.name }, task: task ? { short_id: task.short_id, title: task.title, pr_url: prUrlFromEvidence(task.verification_evidence) } : null, ...mergeAllowance(role, Date.now()) };
  },
});

/** After the push: the merge counted against the limit, recorded on the
 *  run and the task, and reported in the role's own thread. Refused when the
 *  allowance is gone by now (the runner then says so and leaves the merge to
 *  a person; the push has already landed, so this is the count, not a gate). */
export async function recordMergeCore(ctx: any, userId: Id<"users">, args: { run_id: string; sha: string; branch: string; into: string; pr_url?: string }, now = Date.now()): Promise<any> {
  const { run, role } = await runAndRole(ctx, userId, args.run_id);
  const allowance = mergeAllowance(role, now);
  const counters = countersFor(role, now);
  const used = (counters.merges ?? 0) + 1;
  await ctx.db.patch(role._id, { counters: { ...counters, merges: used }, updated_at: now });
  await ctx.db.patch(run._id, { merge: { sha: args.sha, branch: args.branch, into: args.into, at: now, ...(args.pr_url ? { pr_url: args.pr_url } : {}) } });
  const task: any = run.task_id ? await ctx.db.get(run.task_id) : null;
  const limit = allowance.limit ?? used;
  if (task) {
    await insertTaskComment(ctx, task._id, {
      author: `@${role.handle}`,
      text: `merged ${args.branch} into ${args.into} at ${args.sha.slice(0, 10)}${args.pr_url ? ` (${args.pr_url})` : ""}: merge ${used} of ${limit} today`,
      comment_type: "review",
      conversation_id: run.primary_conversation_id ?? undefined,
    });
  }
  const told = await tellRole(ctx, role._id, {
    content: mergeReportLine({ task_short_id: task?.short_id ?? "the task", task_title: task?.title ?? "", branch: args.branch, sha: args.sha, into: args.into, used, limit }),
    client_id: `line-merge:${run._id}`,
  });
  return { used, limit, over: allowance.limit !== null && used > allowance.limit, reported: !!told };
}

export const record = mutation({
  args: { api_token: v.string(), run_id: v.string(), sha: v.string(), branch: v.string(), into: v.string(), pr_url: v.optional(v.string()) },
  handler: async (ctx, { api_token, ...args }) => recordMergeCore(ctx, await requireToken(ctx, api_token), args),
});

export const setLineMerge = mutation({
  args: { api_token: v.optional(v.string()), role_id: v.string(), on: v.boolean(), per_day: v.optional(v.number()), from_session: v.optional(v.string()) },
  handler: async (ctx, { api_token, ...args }) => {
    const userId = await getAuthenticatedUserId(ctx, api_token);
    if (!userId) throw new Error("Authentication failed: invalid token or session");
    return performSetLineMerge(ctx, userId, { ...args, api_token });
  },
});
