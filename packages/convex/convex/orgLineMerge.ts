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
// task, or, for a run a script station of its own graph cleared to land
// (`clearForMerge`), the person who started it.

import { internalMutation, mutation, query } from "./functions";
import type { Cite } from "./lib/originatorChain";
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

const optionIsShip = (label: unknown): boolean => /^ship\b/i.test(String(label ?? "").trim());
const isShipAnswer = (card: any): boolean => card.status === "answered" && optionIsShip(card.options?.[card.answer_index ?? -1]?.label);
const offersShip = (card: any): boolean => (card.options ?? []).some((o: any) => optionIsShip(o?.label));
const cardRef = (card: any): string => card.short_id ?? String(card._id);
// "answered Revise on sd-N" / "dismissed sd-N": what a verdict was, for a refusal.
const verdictWords = (card: any, ref = cardRef(card)): string =>
  card.status === "dismissed" ? `dismissed ${ref}` : `answered ${String(card.options?.[card.answer_index ?? -1]?.label ?? card.answer_text ?? "something other than Ship").trim()} on ${ref}`;
// A person's verdict: an answer a user gave, or a dismissal a user made (a dismissal names its person in answered_by,
// or, on older rows, only in resolved_by). A withdrawal names nobody: the asker took its own question back.
const byPerson = (card: any): boolean =>
  card.answered_by ? card.answered_by.kind === "user" : card.status === "dismissed" && !!card.resolved_by;
const newestFirst = (a: any, b: any) => (b.resolved_at ?? b.created_at ?? 0) - (a.resolved_at ?? a.created_at ?? 0);

/** The attempt a run is on: a resume that counts as a new attempt moves it, and a cleared stamp holds only for the
 *  attempt it was written in (`run.merge_cleared.attempt`). */
export const runAttempt = (run: { visits_reset_at?: number; created_at: number }): number => run.visits_reset_at ?? run.created_at;

/**
 * The person whose word lets a run no role is behind merge, or a refusal (thrown).
 *
 * A card counts when it is a gate card (it names a run) that offered Ship; a failure gate's "Reopen" or "Drop the
 * task" is no word on shipping. Cards are read off the task's index by status, newest first
 * (`session_decisions.by_task`), plus the run's own `gate_decision_id`. Rules, in order:
 * 1. A card of this run still waiting refuses: the run asked, and nobody has answered.
 * 2. This run's own decided cards: the newest decides, whoever gave it. A person's Ship authorizes; a role's or a
 *    policy's Ship is no person's, and Revise, Drop or a dismissal refuses.
 * 3. Otherwise the task's newest person verdict on another run's card (an answer or a dismissal by a user): Ship
 *    carries over to this rerun, as that person; anything else refuses until a person answers Ship on a later
 *    card. A Ship covers the task, not a commit: the newest verdict is what revokes it.
 * 4. Otherwise a run its own graph cleared to land: the stamp a script station wrote (`clearForMergeCore`) in the
 *    run's current attempt, and the person who started the run (`run.user_id`) authorizes it. Every resume, reask
 *    and land-again drops the stamp, so it is never inferred from what a run lacks. An agent account is no person.
 */
export async function personAuthorized(ctx: any, run: any): Promise<PersonAuthorization> {
  const byStatus = (status: string) => run.task_id
    ? ctx.db.query("session_decisions").withIndex("by_task", (q: any) => q.eq("task_id", run.task_id).eq("status", status)).order("desc").take(100)
    : Promise.resolve([]);
  const [pending, answered, dismissed] = await Promise.all([byStatus("pending"), byStatus("answered"), byStatus("dismissed")]);
  const rows: any[] = [...pending, ...answered, ...dismissed];
  if (run.gate_decision_id && !rows.some((d) => String(d._id) === String(run.gate_decision_id))) {
    const own = await ctx.db.get(run.gate_decision_id);
    if (own) rows.push(own);
  }
  const isOwn = (d: any) => String(d.workflow_run_id ?? "") === String(run._id) || String(d._id) === String(run.gate_decision_id ?? "");
  const waiting = rows.find((d) => isOwn(d) && d.status === "pending");
  if (waiting) throw new Error(`No role started this run and its card ${cardRef(waiting)} is still waiting on a person, ${NOTHING_AUTHORIZES}`);
  const decided = rows.filter((d) => (d.status === "answered" || d.status === "dismissed") && !d.trial && offersShip(d) && (isOwn(d) || !!d.workflow_run_id)).sort(newestFirst);

  const own = decided.find(isOwn);
  if (own) {
    if (isShipAnswer(own) && own.answered_by?.kind === "user") return { user_id: String(own.answered_by.id), why: `ship on card ${cardRef(own)}` };
    const who = own.answered_by?.kind && own.answered_by.kind !== "user" ? `a ${own.answered_by.kind}` : "a person";
    throw new Error(`No role started this run and ${who} ${verdictWords(own, `its card ${cardRef(own)}`)}, ${NOTHING_AUTHORIZES}`);
  }
  const earlier = decided.find(byPerson);
  if (earlier) {
    if (isShipAnswer(earlier)) return { user_id: String(earlier.answered_by.id), why: `ship on earlier run's card ${cardRef(earlier)}` };
    throw new Error(`No role started this run and a person ${verdictWords(earlier)}, the task's newest verdict, ${NOTHING_AUTHORIZES}`);
  }
  const stamp = run.merge_cleared;
  if (!stamp || stamp.attempt !== runAttempt(run)) throw new Error(`No role started this run, its graph did not clear it to land, and no person answered Ship on a card, ${NOTHING_AUTHORIZES}`);
  const starter: any = await ctx.db.get(run.user_id);
  if (!starter || starter.is_bot) throw new Error(`No role started this run, an agent account started it, and no person answered Ship on a card, ${NOTHING_AUTHORIZES}`);
  const name = starter.name || starter.github_username || starter.email?.split("@")[0] || String(starter._id);
  if (stamp.cite) return { user_id: String(run.user_id), why: `${name}'s own word "${stamp.quote}" (${stamp.cite.conversation_short_id}:${stamp.cite.line}), checked at ${stamp.node_id}` };
  return { user_id: String(run.user_id), why: `cleared by the run's own graph at ${stamp.node_id} (${stamp.why}), started by ${name}` };
}

/**
 * `cast workflow clear <run> --why`: the run's own graph cleared it to land with no card (a founder-intent read that
 * passed). Written only by the run's own runner account, while the run is running, from the station it stands at,
 * and only from a script station: the graph the run executes (its `workflows` row, the composed graph the runner
 * pushed at start) names that station `command` (shape parallelogram), the runner reported no session on it, and the
 * run is not waiting on its change's session (a fix station hands work to that session and reports none). The stamp
 * names the run's attempt, and anything that moves the run back (workflow_runs.resumeRunAt, landAgainCore, a trial
 * rebuild) drops it.
 * An agent that fakes the runner's progress reports could still stamp; whoever holds the owner's token and git can push main anyway.
 *
 * `cited`: the starter's own typed line the clear rests on, already checked by verifyCitation (the intent segment's
 * clear, /cli/workflow-runs/clear with a cite). The stamp keeps it, and the task says the change lands on that word.
 */
export async function clearForMergeCore(
  ctx: any,
  userId: Id<"users">,
  args: { run_id: string; why: string; cited?: { cite: Cite; quote: string; name: string } },
  now = Date.now(),
): Promise<{ run_id: string; node_id: string; attempt: number }> {
  const run = await ctx.db.get(args.run_id as Id<"workflow_runs">);
  if (!run || String(run.user_id) !== String(userId)) throw new Error("Only the run's own runner clears it to land");
  const why = args.why.trim();
  if (!why) throw new Error("--why says what cleared the run to land");
  if (run.status !== "running" || !run.current_node_id) throw new Error(`The run is ${run.status}: only a running station clears it to land`);
  const station = (run.node_statuses ?? []).find((n: any) => n.node_id === run.current_node_id);
  if (!station || station.status !== "running") throw new Error(`${run.current_node_id} is not running: only the station the run stands at clears it`);
  const node = run.workflow_id ? ((await ctx.db.get(run.workflow_id))?.nodes ?? []).find((n: any) => n.id === run.current_node_id) : null;
  if (station.session_id || run.waiting_on_session || node?.type !== "command") {
    throw new Error(`${run.current_node_id} is not a script station of the run's graph: only a flow's script station clears a run to land`);
  }
  const attempt = runAttempt(run);
  const cited = args.cited ? { cite: args.cited.cite, quote: args.cited.quote.slice(0, 2000) } : {};
  await ctx.db.patch(run._id, { merge_cleared: { at: now, node_id: run.current_node_id, why: why.slice(0, 500), by: userId, attempt, ...cited }, updated_at: now });
  if (args.cited && run.task_id) {
    const { cite, quote, name } = args.cited;
    await insertTaskComment(ctx, run.task_id, {
      author: "line",
      text: `Cleared to land on ${name}'s word: "${quote}" (${cite.conversation_short_id}:${cite.line}), no card.`,
      comment_type: "progress",
      conversation_id: run.primary_conversation_id ?? undefined,
    });
  }
  return { run_id: String(run._id), node_id: run.current_node_id, attempt };
}

export const clearForMerge = mutation({
  args: { api_token: v.string(), run_id: v.string(), why: v.string() },
  handler: async (ctx, { api_token, ...args }) => clearForMergeCore(ctx, await requireToken(ctx, api_token), args),
});

const citeValidator = v.object({ conversation_short_id: v.string(), line: v.number() });

/** A clear resting on the starter's own typed line: only /cli/workflow-runs/clear writes it, after verifyCitation. */
export const clearForMergeCited = internalMutation({
  args: { api_token: v.string(), run_id: v.string(), why: v.string(), cite: citeValidator, quote: v.string(), name: v.string() },
  handler: async (ctx, { api_token, cite, quote, name, ...args }) => clearForMergeCore(ctx, await requireToken(ctx, api_token), { ...args, cited: { cite, quote, name } }),
});

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
