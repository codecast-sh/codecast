// The rows behind codecast's `approval` status (ct-100350; the poster is changeApprovals.ts): which repositories are
// opted in, a Ship press joining the run it started, a person's Ship on a run's card becoming an approval and their
// Revise or Drop revoking it, and the re-post each of those owes. Plain functions over ctx.db so the modules that
// write those moments (sessionDecisions, workflow_runs, orgLineMerge, githubWebhooks) call them inside their own
// mutation, without importing the poster's module.
import type { Doc, Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import { normalizeRepository, repositoryOwner } from "@codecast/shared/contracts";
import { optionIsShip } from "./taskVerdicts";
import { emitNotification } from "../notificationRouter";
import { mayBeJudged } from "./judgedDiff";

export type ApprovalGate = {
  installation_id: number;
  installation_row: Id<"github_app_installations">;
  repository: string;
  judges_path: string;
  mode: "shadow" | "required";
  judges?: string[];
  engineers?: Array<{ user_id: string; name: string }>;
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
    if (entry) return { installation_id: row.installation_id, installation_row: row._id, repository: repo, judges_path: entry.judges_path, mode: entry.mode, ...(entry.judges ? { judges: entry.judges } : {}), ...(entry.engineers ? { engineers: entry.engineers } : {}) };
  }
  return null;
}

/** Whether `userId` may read an opted-in gate: a member of the installation's team, or a personal install's owner. */
export async function mayReadGate(ctx: { db: any }, userId: Id<"users">, gate: ApprovalGate): Promise<boolean> {
  const installation = await ctx.db.get(gate.installation_row);
  if (!installation) return false;
  return installation.team_id
    ? !!(await ctx.db.query("team_memberships").withIndex("by_user_team", (q: any) => q.eq("user_id", userId).eq("team_id", installation.team_id)).first())
    : String(installation.scope_user_id ?? "") === String(userId);
}

/** At most this many judged files a Ship list names, and pull requests of the session it reads. */
const SHIP_LIST_MAX = 100;
const SHIP_LIST_PRS = 20;

/**
 * The judged files a session's change touches, each with the sessions codecast knows wrote it, for the list beside
 * Ship: the judged diff of each open pull request the session is linked to (as worked out for its head), by the
 * linked sessions that edited each file; and the uncommitted judged files its checkout reports, by the session that
 * wrote each last (none for a file no session wrote). The web adds the session's own edits from its transcript.
 */
export async function changeJudgedFiles(
  ctx: { db: any },
  conversation: { _id: Id<"conversations">; git_root?: string },
  gate: ApprovalGate,
): Promise<Array<{ path: string; writers: string[] }>> {
  const judges = gate.judges ?? [];
  const writers = new Map<string, Set<string>>();
  const add = (path: string, by?: string | null) => {
    const set = writers.get(path) ?? new Set<string>();
    if (by) set.add(by);
    writers.set(path, set);
  };
  const links: any[] = await ctx.db.query("pull_request_sessions").withIndex("by_conversation", (q: any) => q.eq("conversation_id", conversation._id)).take(SHIP_LIST_PRS);
  for (const link of links) {
    const pr: Doc<"pull_requests"> | null = await ctx.db.get(link.pull_request_id);
    const a = pr?.approval;
    if (!pr || pr.state !== "open" || normalizeRepository(pr.repository) !== gate.repository || !a?.judged_files || a.head_sha !== pr.head_sha) continue;
    // Who wrote each: a session linked to the pull request with an edit of the file in its own checkout.
    const linked: any[] = (await Promise.all((pr.linked_session_ids ?? []).slice(0, 10).map((id) => ctx.db.get(id)))).filter((c: any) => c?.git_root);
    for (const path of a.judged_files.slice(0, SHIP_LIST_MAX)) {
      add(path);
      for (const s of linked) {
        const edits: any[] = await ctx.db.query("file_changes").withIndex("by_file_path", (q: any) => q.eq("file_path", `${s.git_root.replace(/\/+$/, "")}/${path}`)).order("desc").take(20);
        if (edits.some((e) => String(e.conversation_id) === String(s._id) && e.change_type !== "commit")) add(path, String(s._id));
      }
    }
  }
  const installation = await ctx.db.get(gate.installation_row);
  const root = conversation.git_root?.replace(/\/+$/, "");
  if (root && installation?.team_id) {
    const rows: any[] = await ctx.db.query("checkouts").withIndex("by_workspace_repository", (q: any) => q.eq("workspace", `team:${installation.team_id}`).eq("repository", gate.repository)).take(500);
    for (const row of rows.filter((r) => r.path.replace(/\/+$/, "") === root)) {
      const uncommitted = row.report?.uncommitted;
      for (const s of uncommitted?.sessions ?? []) for (const p of s.paths ?? []) if (mayBeJudged(p, judges)) add(p, s.conversation_id);
      for (const p of uncommitted?.unattributed ?? []) if (mayBeJudged(p, judges)) add(p);
    }
  }
  return [...writers].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).slice(0, SHIP_LIST_MAX).map(([path, by]) => ({ path, writers: [...by] }));
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

/** Work a run's landing commit's status out again and post it, when its repository is opted in. */
export async function scheduleLandingPost(ctx: { db: any; scheduler: any }, run: { _id: Id<"workflow_runs">; landing?: { repository: string; sha: string } | null }): Promise<boolean> {
  if (!run.landing || !(await gateOf(ctx, run.landing.repository))) return false;
  await ctx.scheduler.runAfter(0, internal.changeApprovals.evaluateLanding, { repository: normalizeRepository(run.landing.repository), run_id: run._id, sha: run.landing.sha, post: true });
  return true;
}

/** Re-post the status of what a run lands: its landing commit, else the pull request it opened. */
export async function scheduleRunApprovalPost(ctx: { db: any; scheduler: any }, run: { _id: Id<"workflow_runs">; landing?: { repository: string; sha: string } | null; pr?: { repository: string; number: number } | null }): Promise<boolean> {
  if (run.landing) return scheduleLandingPost(ctx, run);
  return run.pr ? scheduleApprovalPost(ctx, run.pr.repository, run.pr.number) : false;
}

/**
 * What an approval card carries: the change it approves (a pull request by its number, or a run's landing commit by its
 * run and sha, never both), the diff key its yes binds to, and the judged files it listed.
 */
export type ApprovalStamp = { repository: string; pr_number?: number; sha?: string; judged_key: string; whole_key?: string; files: string[]; run_id?: Id<"workflow_runs">; reason?: string; asked?: Id<"users">[]; held?: boolean };

/**
 * A landing's approvals of one diff key, or every one with no key: its run's, and those of any other run of the same
 * task, so an approval outlives a run that stopped and was run again while the diff it approved is unchanged.
 */
export async function landingApprovals(ctx: { db: any }, run: { _id: Id<"workflow_runs">; task_id?: Id<"tasks"> }, key?: string): Promise<Doc<"change_approvals">[]> {
  const byRun: Doc<"change_approvals">[] = await ctx.db.query("change_approvals").withIndex(key === undefined ? "by_run" : "by_run_key", (q: any) => (key === undefined ? q.eq("workflow_run_id", run._id) : q.eq("workflow_run_id", run._id).eq("judged_key", key))).collect();
  const byTask: Doc<"change_approvals">[] = run.task_id ? await ctx.db.query("change_approvals").withIndex("by_task_key", (q: any) => (key === undefined ? q.eq("task_id", run.task_id) : q.eq("task_id", run.task_id).eq("judged_key", key))).collect() : [];
  const seen = new Set(byRun.map((a) => String(a._id)));
  return [...byRun, ...byTask.filter((a) => !seen.has(String(a._id)))];
}

/** A Revise, Drop or dismissal of a run's change: every approval it stands on goes, its task's too for a landing. */
async function revokeRunApprovals(ctx: { db: any }, run: any, now: number): Promise<void> {
  const rows: Doc<"change_approvals">[] = run.landing ? await landingApprovals(ctx, run) : await ctx.db.query("change_approvals").withIndex("by_run", (q: any) => q.eq("workflow_run_id", run._id)).collect();
  for (const a of rows) if (!a.revoked_at) await ctx.db.patch(a._id, { revoked_at: now });
}

/** Work the status out again for what a card was about: the landing of its run, else its pull request. */
async function repostFor(ctx: { db: any; scheduler: any }, a: ApprovalStamp): Promise<void> {
  if (a.pr_number !== undefined) { await scheduleApprovalPost(ctx, a.repository, a.pr_number); return; }
  const run: any = a.run_id ? await ctx.db.get(a.run_id) : null;
  if (run) await scheduleLandingPost(ctx, run);
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
  // The task rides along: a later run of the same task finds the press by it (taskApprovals).
  const run: any = await ctx.db.get(runId);
  await ctx.db.patch(press._id, { workflow_run_id: runId, ...(run?.task_id ? { task_id: run.task_id } : {}) });
  await ctx.db.patch(runId, { pressed_approval_id: press._id });
  return press._id;
}

/**
 * What a card a run asks carries for its Ship to approve: the run's landing commit (or pull request) and the judged
 * diff as codecast last worked it out for that sha. Absent until the run reported one.
 */
export async function approvalStampFor(ctx: { db: any }, runId: Id<"workflow_runs"> | undefined): Promise<{ approval: ApprovalStamp } | {}> {
  const run: any = runId ? await ctx.db.get(runId) : null;
  if (run?.landing) {
    const a = run.landing.approval;
    if (!a?.judged_key || a.head_sha !== run.landing.sha) return {};
    return { approval: { repository: run.landing.repository, run_id: run._id, sha: run.landing.sha, judged_key: a.judged_key, ...(a.whole_key ? { whole_key: a.whole_key } : {}), files: a.judged_files ?? [] } };
  }
  if (!run?.pr) return {};
  const pr: any = await ctx.db
    .query("pull_requests")
    .withIndex("by_repository_number", (q: any) => q.eq("repository", run.pr.repository).eq("number", run.pr.number))
    .first();
  const a = pr?.approval;
  if (!a?.judged_key || a.head_sha !== pr.head_sha) return {};
  return { approval: { repository: run.pr.repository, pr_number: run.pr.number, judged_key: a.judged_key, ...(a.whole_key ? { whole_key: a.whole_key } : {}), files: a.judged_files ?? [] } };
}

/**
 * A person settled a run's card. Ship (or Approve merge) inserts the approval of what the card carried; any other
 * answer or a dismissal revokes every approval of the run, the Ship press included, so a Revise or Drop is never
 * outlived by an earlier yes. An agent's, a role's or a policy's answer is no person's and changes nothing, and a
 * withdrawn card (`cast decide cancel`, or codecast taking back a stale approval card) was answered by nobody, so it
 * approves and revokes nothing: whatever approved before still stands.
 */
export async function settleCardApproval(
  ctx: { db: any; scheduler: any },
  row: { _id: Id<"session_decisions">; workflow_run_id?: Id<"workflow_runs">; options: Array<{ label: string }>; task_id?: Id<"tasks">; conversation_id: Id<"conversations">; approval?: ApprovalStamp; approval_card?: boolean; trial?: boolean },
  verdict: { status: string; answer_index?: number },
  by: { kind: string; user_id?: Id<"users">; via?: Id<"conversations"> },
  now: number,
): Promise<void> {
  if (verdict.status === "withdrawn") return;
  if (row.approval_card && row.approval) return settleApprovalCard(ctx, { ...row, approval: row.approval }, verdict, by, now);
  if (!row.workflow_run_id || row.trial || by.kind !== "user" || !by.user_id) return;
  const run: any = await ctx.db.get(row.workflow_run_id);
  if (!run) return;
  const offered = row.options.some((o) => optionIsShip(o.label));
  if (!offered) return;
  const ship = verdict.status === "answered" && optionIsShip(row.options[verdict.answer_index ?? -1]?.label);
  if (ship) {
    // Only a card that showed a judged diff ({pr, judged_key, files}) approves, and only that diff: an unstamped card's
    // Ship approves nothing, and the status asks again. The run's card read the change whole, so its Ship also binds to
    // the whole diff it showed, which covers a mechanism until any code changes.
    // A run's own card never clears a hold: only codecast's approval card for it does (settleApprovalCard).
    const a = row.approval;
    if (a) for (const key of new Set([a.judged_key, ...(a.whole_key ? [a.whole_key] : [])])) {
      await ctx.db.insert("change_approvals", {
        repository: a.repository,
        ...(a.pr_number !== undefined ? { pr_number: a.pr_number } : {}),
        ...(a.sha ? { head_sha: a.sha } : {}),
        judged_key: key,
        files: a.files,
        user_id: by.user_id,
        source: "card",
        conversation_id: row.conversation_id,
        workflow_run_id: run._id,
        ...(row.task_id ? { task_id: row.task_id } : {}),
        decision_id: row._id,
        created_at: now,
      });
    }
  } else {
    await revokeRunApprovals(ctx, run, now);
  }
  await scheduleRunApprovalPost(ctx, run);
}

/** The codecast user who opened the pull request on GitHub, when codecast knows them (a bot account included). */
export async function prAuthor(ctx: { db: any }, repository: string, prNumber: number): Promise<Id<"users"> | null> {
  const pr: any = await ctx.db.query("pull_requests").withIndex("by_repository_number", (q: any) => q.eq("repository", normalizeRepository(repository)).eq("number", prNumber)).first();
  if (!pr?.author_github_username) return null;
  const u: any = await ctx.db.query("users").withIndex("by_github_username", (q: any) => q.eq("github_username", pr.author_github_username)).first();
  return u?._id ?? null;
}

/**
 * Whether an answer may approve where the author must not: a person's own (no session answering for them, `via`), one
 * the card asked, and not the pull request's author.
 */
async function mayClearHold(ctx: { db: any }, card: { asked?: Id<"users">[]; held?: boolean; repository: string; pr_number?: number }, by: { kind: string; user_id?: Id<"users">; via?: Id<"conversations"> }): Promise<boolean> {
  if (by.kind !== "user" || !by.user_id || by.via) return false;
  // Only a card posted while the pull request was held, showing the hold, releases it.
  if (!card.held || card.pr_number === undefined) return false;
  // The people the card asked when codecast posted it: a pass or an escalation adds no one. A run's own card has none.
  if (!(card.asked ?? []).some((id) => String(id) === String(by.user_id))) return false;
  return String(await prAuthor(ctx, card.repository, card.pr_number)) !== String(by.user_id);
}

/**
 * Why an answer to an approval card codecast posted (changeApprovals.ts) would not count, refused before it closes the
 * card, or null when it counts. Only someone the card asked answers it, in person (an answer a session gives for its
 * person, `via`, is no one's), whatever the answer: Approve merge, Revise, Drop or a dismissal. On a pull request no run
 * is behind, or a card about its hold, the pull request's author never approves it. A withdrawal (codecast's own, or the
 * asking session's) is no answer and is never refused.
 */
export async function approvalCardRefusal(
  ctx: { db: any },
  row: { approval_card?: boolean; status?: string; options: Array<{ label: string }>; asked_user_ids?: Id<"users">[]; approval?: ApprovalStamp },
  by: { kind: string; user_id?: Id<"users">; via?: Id<"conversations"> },
  verdict?: { status: string; answer_index?: number },
): Promise<string | null> {
  if (!row.approval_card || !row.approval || verdict?.status === "withdrawn") return null;
  if (row.status && row.status !== "pending") return `This approval card is already ${row.status}: it is answered once.`;
  // Who the card asked when codecast posted it, never whom a pass or an escalation handed it to (a card from before the
  // set was kept reads its asked people).
  const asked = (row.approval.asked ?? row.asked_user_ids ?? []).map(String);
  const names = (await Promise.all(asked.map(async (id) => {
    const u: any = ctx.db.normalizeId?.("users", id) ? await ctx.db.get(id) : await ctx.db.get(id).catch(() => null);
    return u?.name || u?.github_username || null;
  }))).filter(Boolean);
  const who = names.length ? names.join(" or ") : "the person it asks";
  if (by.kind !== "user" || !by.user_id) return `Only ${who} answers this approval card, in person: a role or a policy does not.`;
  if (by.via) return `Only ${who} answers this approval card, in person: an answer a session gives for its person does not count. Answer it on the web, or from a plain shell.`;
  if (!asked.includes(String(by.user_id))) return `Only ${who} answers this approval card: it asks them, not you.`;
  const approving = verdict?.status === "answered" && optionIsShip(row.options[verdict.answer_index ?? -1]?.label);
  const barred = !row.approval.run_id || row.approval.reason === "held";
  if (approving && barred && row.approval.pr_number !== undefined && String(await prAuthor(ctx, row.approval.repository, row.approval.pr_number)) === String(by.user_id)) {
    const others = names.length > 1 ? `; ${who} can, besides you` : "";
    return `You opened this pull request, so your approval of it does not count${others}.`;
  }
  return null;
}

/**
 * Why a decision may not be passed or escalated: an approval card codecast posted never is, since only the people it
 * asked when it was posted can answer it. Null for any other decision.
 */
export function approvalHandoffRefusal(row: { approval_card?: boolean; approval?: unknown }): string | null {
  return row.approval_card && row.approval ? "An approval card is answered by the people it asks: it is not handed on." : null;
}

/**
 * A person approved the pull request on a card (mayClearHold): the hold an automatic review's mechanism answer put on it
 * is cleared (changeApprovals.settle). Nothing else clears it.
 */
async function clearHold(ctx: { db: any }, repository: string, prNumber: number): Promise<void> {
  const rows: Doc<"pull_requests">[] = await ctx.db.query("pull_requests").withIndex("by_repository_number", (q: any) => q.eq("repository", normalizeRepository(repository)).eq("number", prNumber)).collect();
  for (const row of rows) {
    if (!row.approval?.held) continue;
    const { held: _held, ...rest } = row.approval;
    await ctx.db.patch(row._id, { approval: rest });
  }
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

/**
 * A person settled an approval card codecast posted for a pull request (changeApprovals.ts): Approve merge is the
 * approval of the judged diff the card showed; Revise, Drop or a dismissal revokes what approved that pull request's
 * run (or, with no run, that diff). Anyone else's answer changes nothing. The status is worked out again either way.
 * An approval counts only from a person the card asked, in person: an answer a session gave for them (`via`) approves
 * nothing, and on a pull request no run is behind, or a card about its hold, neither does its author's.
 */
async function settleApprovalCard(
  ctx: { db: any; scheduler: any },
  row: { _id: Id<"session_decisions">; options: Array<{ label: string }>; task_id?: Id<"tasks">; conversation_id: Id<"conversations">; asked_user_ids?: Id<"users">[]; approval: ApprovalStamp },
  verdict: { status: string; answer_index?: number },
  by: { kind: string; user_id?: Id<"users">; via?: Id<"conversations"> },
  now: number,
): Promise<void> {
  if (by.kind !== "user" || !by.user_id) return;
  const a = row.approval;
  if (verdict.status === "answered" && optionIsShip(row.options[verdict.answer_index ?? -1]?.label)) {
    const asked = (a.asked ?? row.asked_user_ids ?? []).some((id) => String(id) === String(by.user_id));
    const authorBarred = !a.run_id || a.reason === "held";
    if (by.via || !asked || (authorBarred && a.pr_number !== undefined && String(await prAuthor(ctx, a.repository, a.pr_number)) === String(by.user_id))) return;
    if (await mayClearHold(ctx, { asked: a.asked, held: a.held, repository: a.repository, pr_number: a.pr_number }, by)) await clearHold(ctx, a.repository, a.pr_number!);
    await ctx.db.insert("change_approvals", {
      repository: a.repository, ...(a.pr_number !== undefined ? { pr_number: a.pr_number } : {}), ...(a.sha ? { head_sha: a.sha } : {}), judged_key: a.judged_key, files: a.files, user_id: by.user_id, source: "card",
      conversation_id: row.conversation_id, ...(a.run_id ? { workflow_run_id: a.run_id } : {}), ...(row.task_id ? { task_id: row.task_id } : {}),
      decision_id: row._id, created_at: now,
    });
  } else {
    const run: any = a.run_id ? await ctx.db.get(a.run_id) : null;
    if (run) await revokeRunApprovals(ctx, run, now);
    else {
      const held: Doc<"change_approvals">[] = a.run_id
        ? await ctx.db.query("change_approvals").withIndex("by_run", (q: any) => q.eq("workflow_run_id", a.run_id)).collect()
        : await ctx.db.query("change_approvals").withIndex("by_pr_key", (q: any) => q.eq("repository", a.repository).eq("pr_number", a.pr_number).eq("judged_key", a.judged_key)).collect();
      for (const h of held) if (!h.revoked_at) await ctx.db.patch(h._id, { revoked_at: now });
    }
  }
  await repostFor(ctx, a);
}

/**
 * A Release Captain's revert merged on CI alone (no review, no card); when it touched a judged file or a mechanism,
 * the first engineer main's engineers file lists is told, once, by a notification, never a card.
 */
export async function noticeCaptainRevertMerged(ctx: { db: any }, pr: Doc<"pull_requests">): Promise<boolean> {
  const a = pr.approval;
  if (!a?.captain_revert || a.engineer_told || !(a.judged_files?.length || a.mechanism)) return false;
  const gate = await gateOf(ctx, pr.repository);
  const engineer = gate?.engineers?.[0];
  const id = engineer ? ctx.db.normalizeId("users", engineer.user_id) : null;
  if (!id || !(await ctx.db.get(id))) return false;
  const what = a.judged_files?.length ? `touches ${a.judged_files.slice(0, 3).join(", ")}${a.judged_files.length > 3 ? ` (+${a.judged_files.length - 3})` : ""}` : "is a mechanism by its review";
  await emitNotification(ctx as any, {
    event_type: "change_shipped",
    actor_name: "Release Captain",
    entity_type: "code",
    entity_id: `${pr.repository}#${pr.number}`,
    message: `merged a revert, ${pr.repository}#${pr.number}, on CI alone; it ${what}`,
    link: `https://github.com/${pr.repository}/pull/${pr.number}`,
    recipient_ids: [id],
  });
  await ctx.db.patch(pr._id, { approval: { ...a, engineer_told: true } });
  return true;
}
