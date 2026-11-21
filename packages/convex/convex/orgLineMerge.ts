// The line's merge step (docs/architecture/the-line.md L12). A line may end
// in a merge of the approved branch into the default branch when its checks
// pass. Two things allow it, and both are a person's: the role's `merge`
// authority grant (org-hire.md H4: kind write, id "merge", a per_day limit;
// the one the Release Captain template carries) and the line's own switch,
// `org_roles.line_merge`, off unless a person turns it on for that line. The
// runner's merge node asks `check` before it touches git and `record` after
// the push; the second re-reads the allowance inside the write, so two runs
// cannot both take the last merge of the day. A run no role is behind merges
// on a person's word instead (`personAuthorized`): a Ship on a card of the
// task, or, for a run whose own graph cleared it to land without a card, the
// person who started it.

import { mutation, query } from "./functions";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { verifyApiToken } from "./apiTokens";
import { requireRole, userCanAccessRole } from "./lib/orgAccess";
import { canReadRun } from "./workflow_runs";
import { trialProjectOf } from "./lineTrial";
import { countersFor } from "./lib/orgCaps";
import { mergeReportLine } from "./lib/orgRoutine";
import { MERGE_AUTHORITY_ID, MERGE_AUTHORITY_LABEL, mergeAllowance, mergeGrantOf } from "./lib/lineMerge";
export { MERGE_AUTHORITY_ID, MERGE_AUTHORITY_LABEL, mergeAllowance, mergeGrantOf, type MergeAllowance } from "./lib/lineMerge";
import { performSetAuthority } from "./orgRoles";
import { insertTaskComment } from "./tasks";
import { getAuthenticatedUserId, tellRole } from "./pendingMessages";
import { roleOfRun } from "./lib/actor";
import { roleMergeAllowance } from "./lib/regretRead";

/** The pull request a handoff named in its evidence ("PR: <url>", taskClaim
 *  handoffCommentText), or null. */
export function prUrlFromEvidence(evidence: string | null | undefined): string | null {
  const m = (evidence ?? "").match(/^PR:\s*(https?:\/\/\S+)\s*$/m);
  return m ? m[1] : null;
}

// `cast role line <handle> --merge on|off [--per-day N]`: the line's switch
// (logged like the line itself). Turning it on needs a merge
// grant: one the role already holds, or one written here from --per-day in
// the same gesture, through the one authority path.
export async function performSetLineMerge(
  ctx: any,
  userId: Id<"users">,
  args: { role_id: string; on: boolean; per_day?: number; rate?: { bar: number; min: number } | null; from_session?: string; api_token?: string; human_decision?: string },
): Promise<any> {
  let role = await requireRole(ctx, userId, args.role_id, "admin");
  // The mode is a person's alone (regret.md R7): only a signed-in person's request, which the web sends from its
  // confirm review, may set it; a token (a terminal, an agent's session) may not.
  if (args.rate !== undefined && (args.api_token || args.from_session)) throw new Error("Only a person sets how the merge step decides, from the role's settings");
  if (args.rate) {
    if (!(args.rate.bar > 0 && args.rate.bar <= 1)) throw new Error("The rate's bar is a share above 0 and at most 1 (0.9 is 90%)");
    if (!(Number.isInteger(args.rate.min) && args.rate.min >= 1)) throw new Error("The rate needs a whole number of finished changes, at least 1");
  }
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
  // The mode (regret.md R7): a bar sets the rate, null goes back to the count, absent leaves it.
  if (args.rate !== undefined) {
    const before = role.line_merge_rate ? `${role.line_merge_rate.bar}/${role.line_merge_rate.min}` : "count";
    const after = args.rate ? `${args.rate.bar}/${args.rate.min}` : "count";
    if (before !== after) {
      await ctx.db.patch(role._id, { line_merge_rate: args.rate ? { bar: args.rate.bar, min: args.rate.min, set_by: userId, set_at: now } : undefined, updated_at: now });
      await ctx.db.insert("org_role_history", {
        role_id: role._id, user_id: userId, actor_type: "user", action: "line_merge", field: "line_merge_rate",
        old_value: before, new_value: after, created_at: now,
      });
    }
  }
  const updated = await ctx.db.get(role._id);
  return { ...updated, merge: await roleMergeAllowance(ctx, updated, now, true) };
}

async function requireToken(ctx: any, apiToken: string): Promise<Id<"users">> {
  const auth = await verifyApiToken(ctx, apiToken);
  if (!auth) throw new Error("Unauthorized");
  return auth.userId;
}

/** A person's word that authorizes a merge no role is behind: who, and why. */
export type PersonAuthorization = { user_id: string; why: string };

/**
 * Who authorizes this merge. A role's line merges under the role's merge
 * authority and allowance. A run with no role behind it merges on a person's
 * word, which counts against no role's limit (`personAuthorized`).
 */
async function runAndRole(ctx: any, userId: Id<"users">, runRef: string): Promise<{ run: any; role: any; authorizedBy: PersonAuthorization | null }> {
  const run = await ctx.db.get(runRef as Id<"workflow_runs">);
  if (!run) throw new Error(`No run ${runRef}`);
  const role = await roleOfRun(ctx, run);
  if (role) {
    if (!(await userCanAccessRole(ctx, userId, role))) throw new Error("Forbidden");
    return { run, role, authorizedBy: null };
  }
  if (!(await canReadRun(ctx, userId, run))) throw new Error("Forbidden");
  return { run, role: null, authorizedBy: await personAuthorized(ctx, run) };
}

// Every refusal ends with these words: a flow reads them to ask at the card instead (a repo's change flow does).
const NOTHING_AUTHORIZES = "so nothing authorizes the merge";

const isShip = (card: any): boolean => /^ship\b/i.test(String(card.options?.[card.answer_index ?? -1]?.label ?? "").trim());
const answerLabel = (card: any): string => String(card.options?.[card.answer_index ?? -1]?.label ?? card.answer_text ?? "something other than Ship").trim();
const cardRef = (card: any): string => card.short_id ?? String(card._id);

/**
 * The person whose word lets a run no role is behind merge, or a refusal (thrown).
 *
 * The cards are every gate card of every run of the run's task (`session_decisions.by_task`), with the run's own
 * card (`gate_decision_id`). Only a person's answer is an answer: `answered`, by a user. A role's answer and a
 * withdrawn card are none.
 * - A card of this run still waiting refuses: the run asked, and nobody has answered.
 * - Otherwise the newest answer a person gave decides. Ship authorizes, as that person, whichever run's card it
 *   was on, so a rerun of a task already shipped at its card does not ask again; any other answer refuses until a
 *   person answers Ship on a later card.
 * - With no answer, a run that asked no card reached Land because its own graph cleared it, and the person who
 *   started it (`run.user_id`) authorizes it. A run asked a card when any card names it, its row names one, or it
 *   stopped at a gate (`gate_node_id`, written before the gate asks and kept after). A run with no task has no
 *   cards to read, and an agent account is no person: neither merges without a Ship.
 */
export async function personAuthorized(ctx: any, run: any): Promise<PersonAuthorization> {
  const ofTask: any[] = run.task_id
    ? await ctx.db.query("session_decisions").withIndex("by_task", (q: any) => q.eq("task_id", run.task_id)).take(500)
    : [];
  const cards = ofTask.filter((d) => !!d.workflow_run_id && !d.trial);
  if (run.gate_decision_id && !cards.some((d) => String(d._id) === String(run.gate_decision_id))) {
    const own = await ctx.db.get(run.gate_decision_id);
    if (own) cards.push(own);
  }
  const isOwn = (d: any) => String(d.workflow_run_id ?? "") === String(run._id) || String(d._id) === String(run.gate_decision_id ?? "");
  const waiting = cards.find((d) => isOwn(d) && d.status === "pending");
  if (waiting) throw new Error(`No role started this run and its card ${cardRef(waiting)} is still waiting on a person, ${NOTHING_AUTHORIZES}`);
  const answers = cards
    .filter((d) => d.status === "answered" && d.answered_by?.kind === "user")
    .sort((a, b) => (b.resolved_at ?? b.created_at ?? 0) - (a.resolved_at ?? a.created_at ?? 0));
  const last = answers[0];
  if (last) {
    if (!isShip(last)) throw new Error(`No role started this run and a person answered ${answerLabel(last)} on ${cardRef(last)}, the task's newest answer, ${NOTHING_AUTHORIZES}`);
    return { user_id: String(last.answered_by.id), why: isOwn(last) ? `ship on card ${cardRef(last)}` : `ship on earlier run's card ${cardRef(last)}` };
  }
  if (cards.some(isOwn) || run.gate_node_id) throw new Error(`No role started this run and no person answered Ship on its card, ${NOTHING_AUTHORIZES}`);
  if (!run.task_id) throw new Error(`No role started this run, it has no task whose cards show it asked none, and no person answered Ship on a card, ${NOTHING_AUTHORIZES}`);
  const starter: any = await ctx.db.get(run.user_id);
  if (!starter || starter.is_bot) throw new Error(`No role started this run, an agent account started it, and no person answered Ship on a card, ${NOTHING_AUTHORIZES}`);
  const name = starter.name || starter.github_username || starter.email?.split("@")[0] || String(starter._id);
  return { user_id: String(run.user_id), why: `cleared by the run's own graph, started by ${name}` };
}

const PERSON_ALLOWANCE = { on: true, used: 0, limit: null, grant: null, allowed: true, reason: null, mode: "count" as const, bar: null, measured: null };

/** Before the merge: may this run's line merge now? Never writes. A run no
 *  role is behind says who authorizes it (`authorized`); the trial check
 *  comes after, so a trial project's run never merges whoever said Ship. */
export async function checkMergeCore(ctx: any, userId: Id<"users">, runId: string): Promise<any> {
  const { run, role, authorizedBy } = await runAndRole(ctx, userId, runId);
  const task: any = run.task_id ? await ctx.db.get(run.task_id) : null;
  // A trial project's run never merges, whatever graph it runs (lineTrial.ts).
  const trial = (await trialProjectOf(ctx, task)) ? { allowed: false, reason: "a trial project's run stops at the card: nothing merges" } : {};
  return {
    role: role ? { short_id: role.short_id, handle: role.handle, name: role.name } : null,
    task: task ? { short_id: task.short_id, title: task.title, pr_url: prUrlFromEvidence(task.verification_evidence) } : null,
    ...(authorizedBy ? { authorized: authorizedBy } : {}),
    ...(role ? await roleMergeAllowance(ctx, role, Date.now()) : PERSON_ALLOWANCE),
    ...trial,
  };
}

export const check = query({
  args: { api_token: v.string(), run_id: v.string() },
  handler: async (ctx, args) => checkMergeCore(ctx, await requireToken(ctx, args.api_token), args.run_id),
});

/** After the push: the merge counted against the limit, recorded on the
 *  run and the task, and reported in the role's own thread. Refused when the
 *  allowance is gone by now (the runner then says so and leaves the merge to
 *  a person; the push has already landed, so this is the count, not a gate). */
export async function recordMergeCore(ctx: any, userId: Id<"users">, args: { run_id: string; sha: string; branch: string; into: string; pr_url?: string }, now = Date.now()): Promise<any> {
  const { run, role, authorizedBy } = await runAndRole(ctx, userId, args.run_id);
  if (!role) {
    // Authorized by a person: record the merge, who authorized it and why on the run and the task, no role to count it against.
    const by = authorizedBy!;
    await ctx.db.patch(run._id, { merge: { sha: args.sha, branch: args.branch, into: args.into, at: now, ...(args.pr_url ? { pr_url: args.pr_url } : {}), authorized: { user_id: by.user_id as Id<"users">, why: by.why } } });
    const task: any = run.task_id ? await ctx.db.get(run.task_id) : null;
    if (task) {
      await insertTaskComment(ctx, task._id, {
        author: "line",
        text: `merged ${args.branch} into ${args.into} at ${args.sha.slice(0, 10)}${args.pr_url ? ` (${args.pr_url})` : ""}: authorized by ${by.why}`,
        comment_type: "review",
        conversation_id: run.primary_conversation_id ?? undefined,
      });
    }
    return { used: 0, limit: null, over: false, reported: false, authorized: by };
  }
  const allowance = await roleMergeAllowance(ctx, role, now);
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
  args: { api_token: v.optional(v.string()), role_id: v.string(), on: v.boolean(), per_day: v.optional(v.number()), rate: v.optional(v.union(v.null(), v.object({ bar: v.number(), min: v.number() }))), from_session: v.optional(v.string()) },
  handler: async (ctx, { api_token, ...args }) => {
    const userId = await getAuthenticatedUserId(ctx, api_token);
    if (!userId) throw new Error("Authentication failed: invalid token or session");
    return performSetLineMerge(ctx, userId, { ...args, api_token });
  },
});
