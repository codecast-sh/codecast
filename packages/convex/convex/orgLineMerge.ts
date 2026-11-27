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
import { runWorkflowOf } from "./lib/runGraph";
import { byPerson, cardRef, isShipAnswer, newestFirst, offersShip, verdictLabel } from "./lib/taskVerdicts";
import { scheduleApprovalPost, scheduleRunApprovalPost } from "./lib/changeApprovalRows";
import { parseOwnerRepo } from "@codecast/shared/contracts";

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

// "answered Revise on sd-N" / "dismissed sd-N": what a verdict was, for a refusal.
const verdictWords = (card: any, ref = cardRef(card)): string =>
  card.status === "dismissed" ? `dismissed ${ref}` : `answered ${verdictLabel(card)} on ${ref}`;

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
  return { user_id: String(run.user_id), why: `cleared by the run's own graph at ${stamp.node_id} (${stamp.why}), started by ${name}` };
}

/**
 * The Merge station's ask (`/cli/workflow-runs/clear`): the run's own graph cleared it to land with no card. Written
 * only by the run's own runner account, while the run is running, from the station it stands at, and only from a script
 * station: the graph the run executes (the version it pinned, lib/runGraph.ts) names that station `command` (shape
 * parallelogram), the runner reported no session on it, and the run is not waiting on its change's session (a fix
 * station hands work to that session and reports none). It stands on what the server itself recorded in this attempt
 * (unproven): a green CI verdict on the head being merged, posted by a script station of the graph while it ran
 * (recordCiVerdictCore), and a reviewer session station that ran a session and finished, both with edge paths to that
 * station. A flow that only writes its own ci.json and review.json cannot clear. The stamp names the run's attempt, and
 * anything that moves the run back (workflow_runs.resumeRunAt, landAgainCore, a trial rebuild) drops it. An agent that
 * fakes the runner's progress reports could still stamp; whoever holds the owner's token and git can push main anyway.
 */
export async function clearForMergeCore(ctx: any, userId: Id<"users">, args: { run_id: string; why: string; head_sha?: string; ci_changed?: boolean }, now = Date.now()): Promise<{ run_id: string; node_id: string; attempt: number }> {
  const run = await ctx.db.get(args.run_id as Id<"workflow_runs">);
  if (!run || String(run.user_id) !== String(userId)) throw new Error("Only the run's own runner clears it to land");
  const why = args.why.trim();
  if (!why) throw new Error("--why says what cleared the run to land");
  if (run.status !== "running" || !run.current_node_id) throw new Error(`The run is ${run.status}: only a running station clears it to land`);
  const station = (run.node_statuses ?? []).find((n: any) => n.node_id === run.current_node_id);
  if (!station || station.status !== "running") throw new Error(`${run.current_node_id} is not running: only the station the run stands at clears it`);
  const graph = await runWorkflowOf(ctx, run);
  const node = (graph?.nodes ?? []).find((n: any) => n.id === run.current_node_id);
  if (station.session_id || run.waiting_on_session || node?.type !== "command") {
    throw new Error(`${run.current_node_id} is not a script station of the run's graph: only a flow's script station clears a run to land`);
  }
  const attempt = runAttempt(run);
  const gap = unproven(graph, run, attempt, args.head_sha);
  if (gap) throw new Error(`${run.current_node_id} cannot clear the run: ${gap}. Only a graph whose CI recorded green on the head it merges and whose reviewer said ship on that head, both leading to it, clears a run to land`);
  // A change to CI's own config can change what green means, so it needs a person's word as well.
  if ((args.ci_changed || run.ci_verdict?.ci_changed) && !(await personShippedRun(ctx, run, attempt))) {
    throw new Error("this change edits CI; a person must answer Ship on this run's card");
  }
  await ctx.db.patch(run._id, { merge_cleared: { at: now, node_id: run.current_node_id, why: why.slice(0, 500), by: userId, attempt }, updated_at: now });
  return { run_id: String(run._id), node_id: run.current_node_id, attempt };
}

/** A person answered Ship on one of this run's own cards in this attempt. */
async function personShippedRun(ctx: any, run: any, attempt: number): Promise<boolean> {
  const rows: any[] = run.task_id
    ? await ctx.db.query("session_decisions").withIndex("by_task", (q: any) => q.eq("task_id", run.task_id).eq("status", "answered")).order("desc").take(100)
    : [];
  if (run.gate_decision_id && !rows.some((d) => String(d._id) === String(run.gate_decision_id))) {
    const own = await ctx.db.get(run.gate_decision_id);
    if (own) rows.push(own);
  }
  return rows.some((d) => (String(d.workflow_run_id ?? "") === String(run._id) || String(d._id) === String(run.gate_decision_id ?? ""))
    && isShipAnswer(d) && d.answered_by?.kind === "user" && (d.resolved_at ?? 0) >= attempt);
}

/** Whether an edge path leads from station `from` to station `to` in the run's graph. */
function leadsTo(graph: any, from: string, to: string): boolean {
  const edges: Array<{ from: string; to: string }> = graph?.edges ?? [];
  const seen = new Set([from]);
  for (const queue = [from]; queue.length; ) {
    const at = queue.shift();
    for (const e of edges.filter((x) => x.from === at)) {
      if (e.to === to) return true;
      if (!seen.has(e.to)) { seen.add(e.to); queue.push(e.to); }
    }
  }
  return false;
}

/** The heads a review of `reviewed` covers in this attempt: that head, and every head a recorded rebase chain leads
 *  to from it, link by link (R to X, then X to Y). */
export function coveredHeads(run: any, attempt: number, reviewed: string): Set<string> {
  const links = (run.station_rebases ?? []).filter((r: any) => r.attempt === attempt);
  const heads = new Set([reviewed]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const r of links) if (heads.has(r.from) && !heads.has(r.to)) { heads.add(r.to); grew = true; }
  }
  return heads;
}

/** What the run has not proven in this attempt, or null: a green CI verdict the server holds for `head` from a
 *  station that leads to the one the run stands at, and the reviewer's ship, reported by the reviewer node's own
 *  session, on that head, or on the head the station's own recorded rebase turned into it. */
function unproven(graph: any, run: any, attempt: number, head: string | undefined): string | null {
  const reaches = (from: string) => leadsTo(graph, from, run.current_node_id);
  const ci = run.ci_verdict;
  if (!ci || ci.attempt !== attempt) return "no CI verdict was recorded in this attempt";
  if (!ci.green) return `CI recorded red on ${ci.head_sha.slice(0, 10)}`;
  if (!head || ci.head_sha !== head) return `CI's green is on ${ci.head_sha.slice(0, 10)}, not on the head being merged (${head ? head.slice(0, 10) : "none named"})`;
  if (!reaches(ci.node_id)) return `the CI station ${ci.node_id} does not lead to it`;
  const review = run.review_verdict;
  if (!review || review.attempt !== attempt) return "no reviewer verdict was recorded in this attempt";
  if (review.verdict !== "ship") return `the reviewer said ${review.verdict}`;
  if (!reaches(review.node_id)) return `the review station ${review.node_id} does not lead to it`;
  if (!coveredHeads(run, attempt, review.head_sha).has(head)) return `the reviewer read ${review.head_sha.slice(0, 10)}, not the head being merged (${head.slice(0, 10)}), and no rebase of the station's own turned one into the other`;
  return null;
}

const SHA = /^[0-9a-f]{40}$/;

/** The canonical ids of the calling session: the conversation its agent session id names (or that id itself, when
 *  it is a conversation's), as its full id and as the short id the runner reports on the stations it spawns. With
 *  them, the runs those conversations name: a station is spawned nested under its run's own session, which carries
 *  the run's id and is the primary of its running runs, and a station the runner found by its session id carries it
 *  itself (workflow_runs.reportProgress). */
async function callerIds(ctx: any, userId: Id<"users">, sessionRef: string): Promise<{ ids: Set<string>; runIds: Set<string> }> {
  const ids = new Set<string>();
  const runIds = new Set<string>();
  if (!sessionRef) return { ids, runIds };
  const byAgent = await ctx.db.query("conversations").withIndex("by_session_id", (q: any) => q.eq("session_id", sessionRef)).take(5);
  const asId = ctx.db.normalizeId?.("conversations", sessionRef);
  const direct = asId ? await ctx.db.get(asId) : null;
  for (const c of [...byAgent, ...(direct ? [direct] : [])]) {
    if (String(c.user_id) !== String(userId)) continue;
    ids.add(String(c._id));
    ids.add(c.short_id ?? String(c._id).slice(0, 7));
    const parent = c.parent_conversation_id ? await ctx.db.get(c.parent_conversation_id) : null;
    for (const runId of [c.workflow_run_id, parent?.workflow_run_id]) if (runId) runIds.add(String(runId));
    // A session that launched several runs points at its newest alone: each running one is read by its primary.
    if (parent) for (const r of await ctx.db.query("workflow_runs").withIndex("by_primary_status", (q: any) => q.eq("primary_conversation_id", parent._id).eq("status", "running")).collect()) runIds.add(String(r._id));
  }
  return { ids, runIds };
}

/**
 * `cast flow review-verdict`: the reviewer's verdict and the head it read, reported by the reviewer's own session,
 * so a clearance binds the review to a head. The session names itself, and only itself: the server finds the
 * running run and the reviewer node (type agent, marked `reviewer`, run in this attempt) whose reported session is
 * exactly that session, so a prompt needs to know neither its run nor its node's id in a composed graph.
 * This keeps a confused agent or a stale verdict from counting; it is no defence against a process that holds the
 * account's token, which could push the default branch directly anyway.
 */
export async function recordReviewVerdictCore(ctx: any, userId: Id<"users">, args: { session_id?: string; verdict: string; head_sha: string; round?: string; run_id?: string; node_id?: string; mechanism?: boolean }, now = Date.now()): Promise<{ run_id: string; node_id: string; attempt: number }> {
  if (!SHA.test(args.head_sha)) throw new Error(`${args.head_sha} is not a commit sha`);
  if (!["ship", "changes", "rejected"].includes(args.verdict)) throw new Error(`${args.verdict} is not a verdict: ship, changes or rejected`);
  const { ids, runIds } = await callerIds(ctx, userId, String(args.session_id ?? ""));
  if (!ids.size) throw new Error("This session is not one of your sessions codecast knows: a review verdict is recorded from the reviewer station's own session");
  const reviewerOf = async (runs: any[]) => {
    const found: Array<{ run: any; node_id: string; attempt: number }> = [];
    for (const run of runs) {
      if (!run || String(run.user_id) !== String(userId) || run.status !== "running") continue;
      const attempt = runAttempt(run);
      const mine = (run.node_statuses ?? []).filter((s: any) => ids.has(String(s.session_id ?? "")) && (s.started_at ?? 0) >= attempt && (!args.node_id || s.node_id === args.node_id));
      if (!mine.length) continue;
      const nodes = (await runWorkflowOf(ctx, run))?.nodes ?? [];
      for (const s of mine) if (nodes.some((n: any) => n.id === s.node_id && n.type === "agent" && n.reviewer === true)) found.push({ run, node_id: s.node_id, attempt });
    }
    return found;
  };
  // The run is read by key: the one named, else the ones the caller's conversations name. An account can hold
  // thousands of running runs (parked at a queue for weeks), so scanning them is only the fallback, newest first.
  const get = (id: string) => ctx.db.get(id as Id<"workflow_runs">);
  let found = await reviewerOf(await Promise.all(args.run_id ? [get(args.run_id)] : [...runIds].map(get)));
  if (!args.run_id && !found.length) {
    found = await reviewerOf(await ctx.db.query("workflow_runs").withIndex("by_user_status", (q: any) => q.eq("user_id", userId).eq("status", "running")).order("desc").take(200));
  }
  if (!found.length) throw new Error("This session is no running run's reviewer station in this attempt: only the reviewer station's own session records its review verdict");
  if (found.length > 1) throw new Error(`This session is the reviewer station of ${found.length} running runs; pass --run to name one`);
  const { run, node_id, attempt } = found[0];
  await ctx.db.patch(run._id, { review_verdict: { node_id, verdict: args.verdict, head_sha: args.head_sha, ...(args.round ? { round: args.round.slice(0, 100) } : {}), ...(args.mechanism !== undefined ? { mechanism: args.mechanism } : {}), at: now, attempt }, updated_at: now });
  // The approval status reads the mechanism answer once codecast sees this station finish (changeApprovals.mechanismOf).
  await scheduleRunApprovalPost(ctx, run);
  return { run_id: String(run._id), node_id, attempt };
}

/**
 * A station of the run rebased its pull request's head onto the default branch and pushed it (Merge before a retest,
 * the PR station waiting for main): the review of `from` covers `to`. Only the run's own runner, from the script
 * station running now. The server cannot tell a rebase from any other commit, so the Merge station checks each link
 * itself before it trusts one (workflow/rebaseRecord.ts verifyRebaseChain); this record says only who claimed it.
 */
export async function recordStationRebaseCore(ctx: any, userId: Id<"users">, args: { run_id: string; from: string; to: string }, now = Date.now()): Promise<{ attempt: number }> {
  const run = await ctx.db.get(args.run_id as Id<"workflow_runs">);
  if (!run || String(run.user_id) !== String(userId)) throw new Error("Only the run's own runner records its rebase");
  if (!SHA.test(args.from) || !SHA.test(args.to) || args.from === args.to) throw new Error("a rebase names two different commit shas");
  const station = (run.node_statuses ?? []).find((s: any) => s.node_id === run.current_node_id);
  const node = ((await runWorkflowOf(ctx, run))?.nodes ?? []).find((n: any) => n.id === run.current_node_id);
  if (run.status !== "running" || station?.status !== "running" || station.session_id || node?.type !== "command") {
    throw new Error(`${run.current_node_id} is not a running script station: only a station's own script records its rebase`);
  }
  const attempt = runAttempt(run);
  await ctx.db.patch(run._id, { station_rebases: [...(run.station_rebases ?? []), { from: args.from, to: args.to, at: now, attempt }].slice(-10), updated_at: now });
  // The push's own status may have been worked out before this link was stored, and the review covers `to` only through it.
  await scheduleRunApprovalPost(ctx, run);
  return { attempt };
}

/**
 * The PR station opened (or found) the run's pull request and pushed a head: the run's own runner, from the script
 * station running now, as a rebase is recorded. The first head it reports is the one a Ship press is tied to
 * (changeApprovals.ts); a later round moves only `head_sha`. Every report re-posts the approval status.
 */
export async function recordRunPrCore(ctx: any, userId: Id<"users">, args: { run_id: string; repository: string; number: number; head_sha: string }, now = Date.now()): Promise<{ first_head_sha: string }> {
  const run = await ctx.db.get(args.run_id as Id<"workflow_runs">);
  if (!run || String(run.user_id) !== String(userId)) throw new Error("Only the run's own runner records its pull request");
  if (!SHA.test(args.head_sha)) throw new Error(`${args.head_sha} is not a commit sha`);
  const repository = parseOwnerRepo(args.repository);
  if (!repository || !Number.isInteger(args.number) || args.number < 1) throw new Error("A pull request is owner/name and a number");
  const station = (run.node_statuses ?? []).find((s: any) => s.node_id === run.current_node_id);
  const node = ((await runWorkflowOf(ctx, run))?.nodes ?? []).find((n: any) => n.id === run.current_node_id);
  if (run.status !== "running" || station?.status !== "running" || station.session_id || node?.type !== "command") {
    throw new Error(`${run.current_node_id} is not a running script station: only the PR station's own script records the run's pull request`);
  }
  const same = run.pr && run.pr.repository === repository && run.pr.number === args.number;
  const first_head_sha = same ? run.pr.first_head_sha : args.head_sha;
  await ctx.db.patch(run._id, { pr: { repository, number: args.number, first_head_sha, head_sha: args.head_sha, at: now }, updated_at: now });
  await scheduleApprovalPost(ctx, repository, args.number);
  return { first_head_sha };
}

export const recordRunPr = mutation({
  args: { api_token: v.string(), run_id: v.string(), repository: v.string(), number: v.number(), head_sha: v.string() },
  handler: async (ctx, { api_token, ...args }) => recordRunPrCore(ctx, await requireToken(ctx, api_token), args),
});

/** What the server holds for this attempt that a merge stands on: the reviewer's verdict and the head it read, and
 *  the recorded rebase links. The Merge station verifies the chain from that head itself, and trusts no file for it. */
export async function mergeProofCore(ctx: any, userId: Id<"users">, runId: string): Promise<{ review: { verdict: string; head_sha: string; node_id: string } | null; rebases: Array<{ from: string; to: string }>; ci_shipped: boolean }> {
  const run = await ctx.db.get(runId as Id<"workflow_runs">);
  if (!run || String(run.user_id) !== String(userId)) throw new Error("Only the run's own runner reads what its merge stands on");
  const attempt = runAttempt(run);
  const r = run.review_verdict?.attempt === attempt ? run.review_verdict : null;
  return {
    review: r ? { verdict: r.verdict, head_sha: r.head_sha, node_id: r.node_id } : null,
    rebases: (run.station_rebases ?? []).filter((x: any) => x.attempt === attempt).map((x: any) => ({ from: x.from, to: x.to })),
    // What a merge of a CI edit needs (clearForMergeCore): the change flow asks no person again for an edit they let merge.
    ci_shipped: await personShippedRun(ctx, run, attempt),
  };
}

export const mergeProof = query({
  args: { api_token: v.string(), run_id: v.string() },
  handler: async (ctx, { api_token, run_id }) => mergeProofCore(ctx, await requireToken(ctx, api_token), run_id),
});

export const recordReviewVerdict = mutation({
  args: { api_token: v.string(), session_id: v.optional(v.string()), verdict: v.string(), head_sha: v.string(), round: v.optional(v.string()), run_id: v.optional(v.string()), node_id: v.optional(v.string()), mechanism: v.optional(v.boolean()) },
  handler: async (ctx, { api_token, ...args }) => recordReviewVerdictCore(ctx, await requireToken(ctx, api_token), args),
});

export const recordStationRebase = mutation({
  args: { api_token: v.string(), run_id: v.string(), from: v.string(), to: v.string() },
  handler: async (ctx, { api_token, ...args }) => recordStationRebaseCore(ctx, await requireToken(ctx, api_token), args),
});

/**
 * `cast flow ci --run --node`: the CI station's verdict, reported by the station itself while it runs, so a clearance
 * stands on what the server holds rather than on a ci.json any script can write. Only the run's own runner account,
 * for a script station of the run's graph that is running now, in this attempt, with no session on it.
 */
export async function recordCiVerdictCore(ctx: any, userId: Id<"users">, args: { run_id: string; node_id: string; green: boolean; head_sha: string; ci_changed?: boolean }, now = Date.now()): Promise<{ attempt: number }> {
  const run = await ctx.db.get(args.run_id as Id<"workflow_runs">);
  if (!run || String(run.user_id) !== String(userId)) throw new Error("Only the run's own runner records its CI verdict");
  if (run.status !== "running") throw new Error(`The run is ${run.status}: only a running CI station records a verdict`);
  if (!/^[0-9a-f]{40}$/.test(args.head_sha)) throw new Error(`${args.head_sha} is not a commit sha`);
  const attempt = runAttempt(run);
  const node = ((await runWorkflowOf(ctx, run))?.nodes ?? []).find((n: any) => n.id === args.node_id);
  const station = (run.node_statuses ?? []).find((s: any) => s.node_id === args.node_id);
  if (node?.type !== "command" || station?.status !== "running" || station.session_id || (station.started_at ?? 0) < attempt) {
    throw new Error(`${args.node_id} is not a running script station of the run's graph: only the CI station records a verdict, while it runs`);
  }
  await ctx.db.patch(run._id, { ci_verdict: { node_id: args.node_id, green: args.green, head_sha: args.head_sha, ...(args.ci_changed ? { ci_changed: true } : {}), at: now, attempt }, updated_at: now });
  return { attempt };
}

export const recordCiVerdict = mutation({
  args: { api_token: v.string(), run_id: v.string(), node_id: v.string(), green: v.boolean(), head_sha: v.string(), ci_changed: v.optional(v.boolean()) },
  handler: async (ctx, { api_token, ...args }) => recordCiVerdictCore(ctx, await requireToken(ctx, api_token), args),
});

export const clearForMerge = mutation({
  args: { api_token: v.string(), run_id: v.string(), why: v.string(), head_sha: v.optional(v.string()), ci_changed: v.optional(v.boolean()) },
  handler: async (ctx, { api_token, ...args }) => clearForMergeCore(ctx, await requireToken(ctx, api_token), args),
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
export async function recordMergeCore(ctx: any, userId: Id<"users">, args: { run_id: string; sha: string; branch: string; into: string; pr_url?: string; observed?: boolean }, now = Date.now()): Promise<any> {
  if (args.observed) {
    // A landing found on the default branch (`cast flow landed`), not a merge the line made: it authorizes nothing,
    // so it needs no role and no Ship, only the run's own runner (its owner). It fills an empty run.merge as where the
    // change landed and never replaces a merge already recorded; it counts against no allowance, says nothing on the
    // task and tells no role.
    const run = await ctx.db.get(args.run_id as Id<"workflow_runs">);
    if (!run) throw new Error(`No run ${args.run_id}`);
    if (run.user_id !== userId) throw new Error("Forbidden");
    if (run.merge) return { observed: true, kept: run.merge.sha };
    await ctx.db.patch(run._id, { merge: { sha: args.sha, branch: args.branch, into: args.into, at: now, ...(args.pr_url ? { pr_url: args.pr_url } : {}) } });
    return { observed: true };
  }
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
  args: { api_token: v.string(), run_id: v.string(), sha: v.string(), branch: v.string(), into: v.string(), pr_url: v.optional(v.string()), observed: v.optional(v.boolean()) },
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
