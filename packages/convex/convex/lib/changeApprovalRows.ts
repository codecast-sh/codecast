// The rows behind codecast's `approval` status (ct-100350; the poster is changeApprovals.ts): which repositories are
// opted in, a Ship press joining the run it started, a person's Ship on a run's card becoming an approval and their
// Revise or Drop revoking it, and the re-post each of those owes. Plain functions over ctx.db so the modules that
// write those moments (sessionDecisions, workflow_runs, orgLineMerge, githubWebhooks) call them inside their own
// mutation, without importing the poster's module.
import type { Doc, Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import { normalizeRepository, repositoryOwner } from "@codecast/shared/contracts";
import { optionIsShip } from "./taskVerdicts";

export type ApprovalGate = {
  installation_id: number;
  installation_row: Id<"github_app_installations">;
  repository: string;
  judges_path: string;
  mode: "shadow" | "required";
  judges?: string[];
};

/** How long a Ship press waits for the run it asks for: the session starts it within a turn. */
export const PRESS_CLAIM_MS = 60 * 60 * 1000;

/** The status context a gate posts: `approval` once required, `approval (shadow)` while no ruleset may lean on it. */
export const approvalContext = (mode: "shadow" | "required") => (mode === "required" ? "approval" : "approval (shadow)");

/** The opt-in for `repository`, from an unsuspended installation that covers it; null when nothing is opted in. */
export async function gateOf(ctx: { db: any }, repository: string): Promise<ApprovalGate | null> {
  const repo = normalizeRepository(repository);
  if (!repo?.includes("/")) return null;
  const rows: Doc<"github_app_installations">[] = await ctx.db
    .query("github_app_installations")
    .withIndex("by_account_login", (q: any) => q.eq("account_login", repositoryOwner(repo)))
    .collect();
  for (const row of rows) {
    if (row.suspended_at) continue;
    const entry = (row.approval_gate ?? []).find((g) => normalizeRepository(g.repository) === repo);
    if (entry) return { installation_id: row.installation_id, installation_row: row._id, repository: repo, judges_path: entry.judges_path, mode: entry.mode, ...(entry.judges ? { judges: entry.judges } : {}) };
  }
  return null;
}

/** Work the pull request's status out again and post it, when its repository is opted in. */
export async function scheduleApprovalPost(ctx: { db: any; scheduler: any }, repository: string, prNumber: number): Promise<boolean> {
  if (!(await gateOf(ctx, repository))) return false;
  await ctx.scheduler.runAfter(0, internal.changeApprovals.evaluate, { repository: normalizeRepository(repository), pr_number: prNumber, post: true });
  return true;
}

/**
 * From a webhook action (a pull request opened or pushed to): work its status out again and post it, when its
 * repository is opted in. Pending from the moment it opens whenever it needs a person; every push re-posts, since a
 * new head carries no status until codecast posts one.
 */
export async function postApprovalFromAction(ctx: { runQuery: any; scheduler: any }, repository: string, prNumber: number): Promise<void> {
  if (await ctx.runQuery(internal.changeApprovals.gateFor, { repository })) {
    await ctx.scheduler.runAfter(0, internal.changeApprovals.evaluate, { repository, pr_number: prNumber, post: true });
  }
}

/** A push to the default branch that changed the judges file: every open pull request's judged paths may have moved. */
export async function repostOnJudgesPush(ctx: { db: any; scheduler: any }, repository: string, commits: any[]): Promise<boolean> {
  const gate = await gateOf(ctx, repository);
  if (!gate || !commits.some((c) => [...(c.added ?? []), ...(c.modified ?? []), ...(c.removed ?? [])].includes(gate.judges_path))) return false;
  await ctx.scheduler.runAfter(0, internal.changeApprovals.evaluateOpen, { repository });
  return true;
}

/** Re-post the status of the pull request a run opened, when it has one. */
export async function scheduleRunApprovalPost(ctx: { db: any; scheduler: any }, run: { pr?: { repository: string; number: number } | null }): Promise<boolean> {
  return run.pr ? scheduleApprovalPost(ctx, run.pr.repository, run.pr.number) : false;
}

/**
 * A run started from a session where a person pressed Ship moments before: the press is the run's approval. The
 * newest press of that session, untaken and unrevoked, within the hour, is the one this run answers.
 */
export async function claimPress(ctx: { db: any }, runId: Id<"workflow_runs">, conversationId: Id<"conversations"> | undefined, now: number): Promise<Id<"change_approvals"> | null> {
  if (!conversationId) return null;
  const presses: Doc<"change_approvals">[] = await ctx.db
    .query("change_approvals")
    .withIndex("by_conversation", (q: any) => q.eq("conversation_id", conversationId).gte("created_at", now - PRESS_CLAIM_MS))
    .order("desc")
    .take(10);
  const press = presses.find((p) => p.source === "ship_press" && !p.workflow_run_id && !p.revoked_at);
  if (!press) return null;
  await ctx.db.patch(press._id, { workflow_run_id: runId });
  await ctx.db.patch(runId, { pressed_approval_id: press._id });
  return press._id;
}

/**
 * What a card a run asks carries for its Ship to approve: the run's pull request and the judged diff as codecast
 * last worked it out for that head. Absent until the run's PR station reported its pull request.
 */
export async function approvalStampFor(ctx: { db: any }, runId: Id<"workflow_runs"> | undefined): Promise<{ approval: { repository: string; pr_number: number; judged_key: string; files: string[] } } | {}> {
  const run: any = runId ? await ctx.db.get(runId) : null;
  if (!run?.pr) return {};
  const pr: any = await ctx.db
    .query("pull_requests")
    .withIndex("by_repository_number", (q: any) => q.eq("repository", run.pr.repository).eq("number", run.pr.number))
    .first();
  const a = pr?.approval;
  if (!a?.judged_key || a.head_sha !== pr.head_sha) return {};
  return { approval: { repository: run.pr.repository, pr_number: run.pr.number, judged_key: a.judged_key, files: a.judged_files ?? [] } };
}

/**
 * A person settled a run's card. Ship (or Approve merge) inserts the approval of what the card carried; any other
 * answer or a dismissal revokes every approval of the run, the Ship press included, so a Revise or Drop is never
 * outlived by an earlier yes. An agent's, a role's or a policy's answer is no person's and changes nothing.
 */
export async function settleCardApproval(
  ctx: { db: any; scheduler: any },
  row: { _id: Id<"session_decisions">; workflow_run_id?: Id<"workflow_runs">; options: Array<{ label: string }>; task_id?: Id<"tasks">; conversation_id: Id<"conversations">; approval?: { repository: string; pr_number: number; judged_key: string; files: string[] }; trial?: boolean },
  verdict: { status: string; answer_index?: number },
  by: { kind: string; user_id?: Id<"users"> },
  now: number,
): Promise<void> {
  if (!row.workflow_run_id || row.trial || by.kind !== "user" || !by.user_id) return;
  const run: any = await ctx.db.get(row.workflow_run_id);
  if (!run) return;
  const offered = row.options.some((o) => optionIsShip(o.label));
  if (!offered) return;
  const ship = verdict.status === "answered" && optionIsShip(row.options[verdict.answer_index ?? -1]?.label);
  if (ship) {
    // Only a card that showed a judged diff ({pr, judged_key, files}) approves, and only that diff: an unstamped card's
    // Ship approves nothing, and the status asks again.
    if (row.approval) await ctx.db.insert("change_approvals", {
      repository: row.approval.repository,
      pr_number: row.approval.pr_number,
      judged_key: row.approval.judged_key,
      files: row.approval.files,
      user_id: by.user_id,
      source: "card",
      conversation_id: row.conversation_id,
      workflow_run_id: run._id,
      ...(row.task_id ? { task_id: row.task_id } : {}),
      decision_id: row._id,
      created_at: now,
    });
  } else {
    const held: Doc<"change_approvals">[] = await ctx.db.query("change_approvals").withIndex("by_run", (q: any) => q.eq("workflow_run_id", run._id)).collect();
    for (const a of held) if (!a.revoked_at) await ctx.db.patch(a._id, { revoked_at: now });
  }
  await scheduleRunApprovalPost(ctx, run);
}

/** The Release Captain role (pl-1075 Words), by its handle or its title: whose revert merges on CI alone. */
export const isReleaseCaptain = (role: { handle?: string; name?: string } | null | undefined): boolean =>
  !!role && (role.handle === "release" || role.handle === "release-captain" || /^release captain$/i.test(String(role.name ?? "").trim()));

/** Cam (Cameron), by the codecast account's own name. */
export const isCam = (user: { name?: string | null } | null | undefined): boolean => /^cam(eron)?\b/i.test(String(user?.name ?? "").trim());

/**
 * Who asked for the run's work, by codecast's own record: the task's owner, else the person who started the session
 * that asked for the run. Never a commit trailer, which an agent writes.
 */
export async function askerOf(ctx: { db: any }, run: { task_id?: Id<"tasks">; spawner_conversation_id?: Id<"conversations"> } | null): Promise<any | null> {
  const task: any = run?.task_id ? await ctx.db.get(run.task_id) : null;
  if (task?.user_id) return await ctx.db.get(task.user_id);
  const conversation: any = run?.spawner_conversation_id ? await ctx.db.get(run.spawner_conversation_id) : null;
  if (!conversation) return null;
  for (const id of [conversation.author_user_id, conversation.user_id]) {
    const u: any = id ? await ctx.db.get(id) : null;
    if (u && !u.is_bot) return u;
  }
  return null;
}

/** The station a pre-build question to an engineer is asked under (`cast decide --station pre-build`). */
export const PRE_BUILD_STATION = "pre-build";

/** A yes to building it: an approval card's Ship or Approve merge, or a plain Yes, Build or Approve. */
const saysYes = (label: unknown) => optionIsShip(label) || /^(yes|build|approve)\b/i.test(String(label ?? "").trim());

/**
 * The engineer's yes recorded before the run built anything (ct-98540): a card asked as the pre-build question
 * (`cast decide --station pre-build` on the run's task; the asker must use that station, recorded on ct-98540), answered yes in
 * person (a user's own answer, not given through a session) by someone main's engineers file lists, before the run's
 * attempt began. The newest such answer, or null. It covers judged paths only, never a mechanism, and binds to the
 * judged diff the run first pushed (changeApprovals.settle records it then).
 */
export async function preBuildYes(ctx: { db: any }, run: { task_id?: Id<"tasks">; created_at: number; visits_reset_at?: number }, engineers: ReadonlyArray<{ user_id: string }>): Promise<{ user_id: Id<"users">; ref: string; decision_id: Id<"session_decisions"> } | null> {
  if (!run.task_id || !engineers.length) return null;
  const cards: any[] = await ctx.db.query("session_decisions").withIndex("by_task", (q: any) => q.eq("task_id", run.task_id).eq("status", "answered")).order("desc").take(50);
  // The run's attempt began here (orgLineMerge.runAttempt).
  const startedAt = run.visits_reset_at ?? run.created_at;
  for (const d of cards) {
    if (d.station !== PRE_BUILD_STATION) continue;
    if (d.answered_by?.kind !== "user" || d.answered_by.via || (d.resolved_at ?? Infinity) > startedAt) continue;
    if (!engineers.some((e) => e.user_id === String(d.answered_by.id))) continue;
    if (!saysYes(d.options?.[d.answer_index ?? -1]?.label)) continue;
    return { user_id: d.answered_by.id, ref: d.short_id ?? "its card", decision_id: d._id };
  }
  return null;
}
