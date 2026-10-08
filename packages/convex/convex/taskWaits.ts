// Waits: blockers on something that is not a task (docs/architecture/task-graph.md
// TG2). A wait lives on its task row (`tasks.waits`) and settles on the event
// it names: a PR merging or closing (settlePrWaits, from prShepherd's one PR
// event exit), its checks turning green, a decision being answered, dismissed
// or withdrawn (settleTaskWaits, from sessionDecisions.settleResolution), or
// the clock (settleTimeWait). When a task's last blocker clears, by a wait
// settling or a task in its blocked_by closing (releaseDependents, from
// tasks.afterStatusMove), onUnblocked tells the task and whoever works it.
//
// writeWaits is the only writer of `waits`: it keeps `waiting_since` set
// exactly while a wait is waiting, so a PR event reads the waiting tasks from
// by_waiting_since instead of scanning, and it writes the history line.
// A met decision wait has left that index, and reopenCore must find it again,
// so decision waits are found through the decision's `waiting_task_ids`
// instead, a back reference writeWaits adds when the wait is set.

import { v } from "convex/values";
import { internalMutation, mutation, type MutationCtx } from "./functions";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { verifyApiToken } from "./apiTokens";
import {
  canAccessPullRequest,
  canAccessTask,
  isSameWorkspace,
  resolveSessionConversation,
  workspaceForResource,
} from "./lib/access";
import { isTeamMember } from "./privacy";
import { recordTaskChange, type TaskChangeBy, type TaskFieldChange } from "./lib/taskHistory";
import { patchTask } from "./lib/taskWrite";
import { readinessLookups, taskByRef } from "./lib/taskGraph";
import { boundSessionsOf } from "./lib/taskOwner";
import { waitTargetValidator } from "./lib/taskWaitValidator";
import { enqueuePendingMessage } from "./pendingMessages";
import { emitNotification } from "./notificationRouter";
import { insertTaskComment } from "./tasks";
import { answerLabel, userMayRead, type Verdict } from "./sessionDecisions";
import {
  blockerLabel,
  isTerminalTaskStatus,
  isUnblocked,
  parseBlockerRef,
  waitingOnLabel,
  waitMetLabel,
  type PrWaitTarget,
  type StatusOf,
  type TaskWait,
  type WaitTarget,
} from "@codecast/shared/tasks";
import { normalizeRepository, repositoryKeyOfRemote } from "@codecast/shared/contracts";

type Ctx = MutationCtx;
type Task = Doc<"tasks">;
type PR = Doc<"pull_requests">;

/** Who signs what the waits write on a task: its comments and notices. */
const SENDER = "codecast";
const SYSTEM: TaskChangeBy = { actor_type: "system" };
/** Stored text about a wait is read later, in other zones (TG11). */
const STORED = { absolute: true } as const;
const WAIT_ID = /^[\w-]{1,64}$/;

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

/** One wait as a timeline value: "Waiting on PR #42", "PR #42 merged",
 *  "PR #42 merges (failed: closed without merging)". */
function waitLine(w: TaskWait): string {
  if (w.state === "waiting") return waitingOnLabel(w, STORED);
  return w.state === "met" ? metCause(w) : blockerLabel(w, STORED);
}

/** What cleared, for "Unblocked: …": "PR #42 merged", "sd-4 answered: Ship it". */
function metCause(w: TaskWait): string {
  return w.kind === "decision" && w.note ? `${w.decision} ${w.note}` : waitMetLabel(w, STORED);
}

const prName = (repository: string, n: number) => `PR ${repository}#${n}`;

// ---------------------------------------------------------------------------
// The one writer
// ---------------------------------------------------------------------------

/**
 * Replace `task`'s waits with `next`. Recomputes `waiting_since` (kept while
 * any wait still waits, cleared otherwise), writes one history line per wait
 * that was added, settled, reopened or removed, and links each new decision
 * wait from its decision. Returns the row as written.
 */
export async function writeWaits(ctx: Ctx, task: Task, next: TaskWait[], by: TaskChangeBy, now = Date.now()): Promise<Task> {
  const prev = task.waits ?? [];
  const waiting_since = next.some((w) => w.state === "waiting") ? (task.waiting_since ?? now) : undefined;
  await patchTask(ctx, task, { waits: next, waiting_since, updated_at: now });

  const before = new Map(prev.map((w) => [w.id, w]));
  const kept = new Set(next.map((w) => w.id));
  const changes: TaskFieldChange[] = [
    ...prev.filter((w) => !kept.has(w.id)).map((w): TaskFieldChange => ["waits", waitLine(w), ""]),
    ...next.map((w): TaskFieldChange => ["waits", before.has(w.id) ? waitLine(before.get(w.id)!) : "", waitLine(w)]),
  ];
  await recordTaskChange(ctx, task._id, by, changes, now);

  for (const w of next) {
    if (w.kind !== "decision" || before.has(w.id)) continue;
    const decision = await decisionByShortId(ctx, w.decision);
    const linked = decision?.waiting_task_ids ?? [];
    if (decision && !linked.some((id) => String(id) === String(task._id))) {
      await ctx.db.patch(decision._id, { waiting_task_ids: [...linked, task._id] });
    }
  }
  return { ...task, waits: next, waiting_since, updated_at: now };
}

async function decisionByShortId(ctx: Pick<Ctx, "db">, shortId: string) {
  return await ctx.db.query("session_decisions").withIndex("by_short_id", (q) => q.eq("short_id", shortId)).first();
}

async function prByNumber(ctx: Pick<Ctx, "db">, repository: string, number: number): Promise<PR | null> {
  return await ctx.db
    .query("pull_requests")
    .withIndex("by_repository_number", (q) => q.eq("repository", normalizeRepository(repository)).eq("number", number))
    .first();
}

/** A PR's events reach a task routed to the PR's team or owned by one of its members. */
async function prReachesTask(ctx: Pick<Ctx, "db">, pr: PR, task: Task): Promise<boolean> {
  return String(task.team_id ?? "") === String(pr.team_id) || (await isTeamMember(ctx, task.user_id, pr.team_id));
}

// ---------------------------------------------------------------------------
// Adding and removing (CLI, web dispatch)
// ---------------------------------------------------------------------------

/** What a caller names: a TG3 ref (`#42`, `owner/repo#42:checks`, `sd-4`,
 *  `2h`, `2026-10-14T09:00`) or a parsed target. `repository` resolves a bare
 *  `#42` when the task's project names none (the CLI's git remote);
 *  `time_zone` is the person's, for a date without one. `id` lets the web
 *  paint the wait before the server answers. */
export type AddWaitInput = { ref?: string; target?: WaitTarget; repository?: string; time_zone?: string; id?: string };

export type AddWaitResult = { wait: TaskWait; met: boolean; existing?: boolean };

const str = (x: unknown) => (typeof x === "string" && x.trim() ? x.trim() : undefined);

/** A target before a bare `#42` has its repository. */
type UnresolvedTarget = Exclude<WaitTarget, PrWaitTarget> | (Omit<PrWaitTarget, "repository"> & { repository?: string });

/** A target as the client sent it, rebuilt from its known fields only. */
function targetFromInput(raw: any): UnresolvedTarget {
  const kind = raw?.kind;
  if (kind === "pr_merged" || kind === "pr_checks_green") {
    if (!Number.isInteger(raw.pr_number) || raw.pr_number <= 0) throw new Error("A PR wait needs a pull request number");
    const repository = str(raw.repository);
    return repository ? { kind, repository, pr_number: raw.pr_number } : { kind, pr_number: raw.pr_number };
  }
  if (kind === "decision") {
    const ref = parseBlockerRef(String(raw.decision ?? ""));
    if (!ref.ok || ref.kind !== "decision") throw new Error(`"${raw.decision}" is not a decision (sd-4)`);
    return { kind, decision: ref.decision };
  }
  if (kind === "time" && Number.isFinite(raw.at)) return { kind, at: raw.at };
  throw new Error("A wait is on a PR, its checks, a decision or a time");
}

/** The target `input` names, with a bare `#42` given its repository. */
async function resolveTarget(ctx: Ctx, userId: Id<"users">, task: Task, input: AddWaitInput, now: number): Promise<WaitTarget> {
  let target: UnresolvedTarget;
  if (input.target) target = targetFromInput(input.target);
  else {
    const ref = str(input.ref);
    if (!ref) throw new Error("Name what the task waits on: a PR (#42, add :checks for CI), a decision (sd-4) or a time (2h)");
    const parsed = parseBlockerRef(ref, { now, timeZone: str(input.time_zone) });
    if (!parsed.ok) throw new Error(parsed.error);
    if (parsed.kind === "task") throw new Error(`${parsed.ref} is a task: add it as a dependency (blocked_by), not a wait`);
    const { ok: _ok, ...rest } = parsed;
    target = rest;
  }
  if (target.kind === "decision" || target.kind === "time") return target;
  const repository = target.repository
    ? normalizeRepository(target.repository)
    : await repositoryForBarePr(ctx, userId, task, target.pr_number, str(input.repository));
  return { kind: target.kind, repository, pr_number: target.pr_number };
}

/** The repositories a task's work happens in: the mapped checkout covering its
 *  project's path, and the remotes of the sessions on it. */
async function taskRepositories(ctx: Ctx, task: Task): Promise<string[]> {
  const out = new Set<string>();
  const project = task.project_id ? await ctx.db.get(task.project_id) : null;
  const path = task.project_path || project?.project_path;
  if (path) {
    const mappings = [
      ...(await ctx.db.query("directory_team_mappings").withIndex("by_user_id", (q) => q.eq("user_id", task.user_id)).collect()),
      ...(task.team_id ? await ctx.db.query("directory_team_mappings").withIndex("by_team_id", (q) => q.eq("team_id", task.team_id)).collect() : []),
    ];
    for (const m of mappings) {
      const prefix = m.path_prefix.replace(/\/+$/, "");
      if (m.repository && (path === prefix || path.startsWith(`${prefix}/`))) out.add(normalizeRepository(m.repository));
    }
  }
  const sessions = [task.created_from_conversation, ...(task.conversation_ids ?? [])].filter((id): id is Id<"conversations"> => !!id);
  for (const id of [...new Set(sessions.map(String))].slice(0, 20)) {
    const conv = await ctx.db.get(id as Id<"conversations">);
    const repo = repositoryKeyOfRemote(conv?.git_remote_url);
    if (repo) out.add(normalizeRepository(repo));
  }
  return [...out];
}

/**
 * A bare `#42`: the task's project names the repository, then the caller's
 * (the CLI's git remote). Several candidates narrow to the ones where codecast
 * sees PR #42; still several, or none, fails with the candidates.
 */
async function repositoryForBarePr(ctx: Ctx, userId: Id<"users">, task: Task, n: number, fallback?: string): Promise<string> {
  const fromProject = await taskRepositories(ctx, task);
  const candidates = fromProject.length ? fromProject : fallback ? [normalizeRepository(fallback)] : [];
  if (!candidates.length) throw new Error(`#${n}: ${task.short_id} names no repository to find it in. Write owner/repo#${n}.`);
  if (candidates.length === 1) return candidates[0];
  const seen: string[] = [];
  for (const repo of candidates) {
    const pr = await prByNumber(ctx, repo, n);
    if (pr && (await canAccessPullRequest(ctx, userId, pr))) seen.push(repo);
  }
  if (seen.length === 1) return seen[0];
  throw new Error(`#${n} is ambiguous for ${task.short_id}: write one of ${(seen.length ? seen : candidates).map((r) => `${r}#${n}`).join(", ")}`);
}

/**
 * Check a target before waiting on it (TG2): one already met is met at once,
 * with a note saying so; one that can never settle (a PR codecast cannot see,
 * a closed PR, a dismissed decision, a past time) is refused with the reason.
 */
async function checkTarget(ctx: Ctx, userId: Id<"users">, task: Task, t: WaitTarget, now: number): Promise<{ met: false } | { met: true; note: string }> {
  if (t.kind === "time") {
    if (t.at <= now) throw new Error("That time has already passed");
    return { met: false };
  }
  if (t.kind === "decision") {
    const row = await decisionByShortId(ctx, t.decision);
    if (!row || !(await userMayRead(ctx, userId, row))) throw new Error(`No decision ${t.decision} you can read`);
    if (row.status === "answered") {
      const label = answerLabel(row, { status: "answered", answer_index: row.answer_index, answer_text: row.answer_text, answer_json: row.answer_json });
      return { met: true, note: `already answered${label ? `: ${label.slice(0, 120)}` : ""}` };
    }
    if (row.status !== "pending") throw new Error(`${t.decision} was ${row.status}: it will never be answered, so a wait on it would never clear`);
    return { met: false };
  }
  const name = prName(t.repository, t.pr_number);
  const pr = await prByNumber(ctx, t.repository, t.pr_number);
  if (!pr || !(await canAccessPullRequest(ctx, userId, pr))) {
    throw new Error(`codecast cannot see ${name}: no GitHub app installation of yours covers ${t.repository}, or the pull request has not synced. A wait on it would never clear.`);
  }
  if (!(await prReachesTask(ctx, pr, task))) {
    throw new Error(`${name} belongs to a team ${task.short_id} is not in, so its events never reach the task`);
  }
  if (t.kind === "pr_merged") {
    if (pr.state === "merged") return { met: true, note: "already merged" };
    if (pr.state === "closed") throw new Error(`${name} was closed without merging: it will never merge`);
    return { met: false };
  }
  if (pr.checks_state === "success") return { met: true, note: "checks already green" };
  if (pr.state !== "open") throw new Error(`${name} is ${pr.state}: its checks will not run again`);
  return { met: false };
}

const sameTarget = (a: WaitTarget, b: WaitTarget) =>
  a.kind === b.kind &&
  (a.kind === "decision" ? a.decision === (b as typeof a).decision
    : a.kind === "time" ? a.at === (b as typeof a).at
    : a.pr_number === (b as typeof a).pr_number && normalizeRepository(a.repository) === normalizeRepository((b as typeof a).repository));

/** The task a caller may write waits on, by short id. */
async function writableTask(ctx: Ctx, userId: Id<"users">, shortId: string): Promise<Task> {
  const task = await ctx.db.query("tasks").withIndex("by_short_id", (q) => q.eq("short_id", shortId)).first();
  if (!task || !(await canAccessTask(ctx, userId, task))) throw new Error("Task not found");
  return task;
}

/**
 * Set a wait on a task. A wait on the same target that is still waiting is
 * returned as is, so a retry adds nothing. A time wait schedules the job that
 * settles it.
 */
export async function addWaitCore(
  ctx: Ctx,
  userId: Id<"users">,
  shortId: string,
  input: AddWaitInput,
  by: TaskChangeBy & { created_by?: string } = { user_id: userId, actor_type: "user" },
): Promise<AddWaitResult> {
  const now = Date.now();
  const task = await writableTask(ctx, userId, shortId);
  const target = await resolveTarget(ctx, userId, task, input, now);
  const waits = task.waits ?? [];
  const id = str(input.id);
  const existing = waits.find((w) => (id && w.id === id) || (w.state === "waiting" && sameTarget(w, target)));
  if (existing) return { wait: existing, met: existing.state === "met", existing: true };
  if (id && !WAIT_ID.test(id)) throw new Error("A wait id is letters, digits, _ and -, at most 64");

  const check = await checkTarget(ctx, userId, task, target, now);
  const wait: TaskWait = {
    ...target,
    id: id ?? `w${now.toString(36)}${Math.floor(Math.random() * 46656).toString(36)}`,
    state: check.met ? "met" : "waiting",
    created_at: now,
    created_by: by.created_by ?? String(userId),
    ...(check.met ? { settled_at: now, note: check.note } : {}),
  };
  const { created_by: _createdBy, ...changeBy } = by;
  await writeWaits(ctx, task, [...waits, wait], changeBy, now);
  if (wait.kind === "time" && !check.met) {
    await ctx.scheduler.runAt(wait.at, internal.taskWaits.settleTimeWait, { task_id: task._id, wait_id: wait.id, at: wait.at });
  }
  return { wait, met: check.met };
}

/** Remove waits by id, or every wait matching a ref (a bare `#42` matches
 *  that number in any repository). A met or failed wait is history until
 *  removed; removing one never notifies. */
export async function removeWaitCore(
  ctx: Ctx,
  userId: Id<"users">,
  shortId: string,
  which: { wait_id?: string; ref?: string; time_zone?: string },
  by: TaskChangeBy = { user_id: userId, actor_type: "user" },
): Promise<{ removed: TaskWait[] }> {
  const task = await writableTask(ctx, userId, shortId);
  const waits = task.waits ?? [];
  let match: (w: TaskWait) => boolean;
  const ref = str(which.ref);
  if (str(which.wait_id)) match = (w) => w.id === which.wait_id;
  else if (ref) {
    const p = parseBlockerRef(ref, { timeZone: str(which.time_zone) });
    if (!p.ok) throw new Error(p.error);
    match = (w) =>
      w.kind === p.kind &&
      (w.kind === "decision" ? p.kind === "decision" && w.decision === p.decision
        : w.kind === "time" ? p.kind === "time" && w.at === p.at
        : (p.kind === "pr_merged" || p.kind === "pr_checks_green") && w.pr_number === p.pr_number &&
          (!p.repository || normalizeRepository(p.repository) === normalizeRepository(w.repository)));
  } else throw new Error("Name the wait to remove: its id or what it waits on");
  const removed = waits.filter(match);
  if (!removed.length) throw new Error(`${task.short_id} has no wait on ${ref ?? which.wait_id}`);
  await writeWaits(ctx, task, waits.filter((w) => !match(w)), by);
  return { removed };
}

/** The CLI's writer: a session's call is the agent's, a terminal's the person's. */
async function cliWriter(ctx: Ctx, userId: Id<"users">, conversationId: string | undefined) {
  const conv = conversationId ? await resolveSessionConversation(ctx, userId, conversationId) : null;
  return conv
    ? { user_id: userId, actor_type: "agent" as const, conversation_id: conv._id, created_by: conv.short_id ?? String(conv._id) }
    : { user_id: userId, actor_type: "user" as const };
}

export const addWait = mutation({
  args: {
    api_token: v.string(),
    short_id: v.string(),
    ref: v.optional(v.string()),
    target: v.optional(waitTargetValidator),
    repository: v.optional(v.string()),
    time_zone: v.optional(v.string()),
    id: v.optional(v.string()),
    conversation_id: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token);
    if (!auth) throw new Error("Unauthorized");
    const { api_token: _t, short_id, conversation_id, ...input } = args;
    return await addWaitCore(ctx, auth.userId, short_id, input, await cliWriter(ctx, auth.userId, conversation_id));
  },
});

export const removeWait = mutation({
  args: {
    api_token: v.string(),
    short_id: v.string(),
    wait_id: v.optional(v.string()),
    ref: v.optional(v.string()),
    time_zone: v.optional(v.string()),
    conversation_id: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token);
    if (!auth) throw new Error("Unauthorized");
    const { created_by: _c, ...by } = await cliWriter(ctx, auth.userId, args.conversation_id);
    return await removeWaitCore(ctx, auth.userId, args.short_id, args, by);
  },
});

// ---------------------------------------------------------------------------
// Settling
// ---------------------------------------------------------------------------

/**
 * Settle the waits of `task` that `match` picks, then tell whoever works it:
 * a failed wait asks for a new plan; the last open blocker clearing runs
 * onUnblocked. A task already closed is only written.
 */
async function settleWaits(ctx: Ctx, task: Task, match: (w: TaskWait) => boolean, state: "met" | "failed", note: string): Promise<void> {
  const now = Date.now();
  const settled: TaskWait[] = [];
  const next = (task.waits ?? []).map((w) => {
    if (!match(w)) return w;
    const s: TaskWait = { ...w, state, settled_at: now, note };
    settled.push(s);
    return s;
  });
  if (!settled.length) return;
  const after = await writeWaits(ctx, task, next, SYSTEM, now);
  if (isTerminalTaskStatus(after.status)) return;
  if (state === "failed") {
    for (const w of settled) await onWaitFailed(ctx, after, w);
  } else if (await isTaskUnblocked(ctx, after)) {
    await onUnblocked(ctx, after, settled.map(metCause).join(", "));
  }
}

const PR_EVENTS: Record<string, { kind: "pr_merged" | "pr_checks_green"; state: "met" | "failed"; note: string }> = {
  pr_merged: { kind: "pr_merged", state: "met", note: "merged" },
  pr_closed: { kind: "pr_merged", state: "failed", note: "closed without merging" },
  pr_checks_green: { kind: "pr_checks_green", state: "met", note: "checks green" },
};

/** A derived PR event (prShepherd.firePrTrigger) settles the waits on that PR. */
export async function settlePrWaits(ctx: Ctx, eventType: string, pr: PR): Promise<void> {
  const rule = PR_EVENTS[eventType];
  if (!rule) return;
  const repository = normalizeRepository(pr.repository);
  const hit = (w: TaskWait) =>
    w.state === "waiting" && w.kind === rule.kind && w.pr_number === pr.number && normalizeRepository(w.repository) === repository;
  const waiting = await ctx.db.query("tasks").withIndex("by_waiting_since", (q) => q.gt("waiting_since", 0)).collect();
  for (const task of waiting) {
    if (!task.waits?.some(hit) || !(await prReachesTask(ctx, pr, task))) continue;
    await settleWaits(ctx, task, hit, rule.state, rule.note);
  }
}

/** The tasks a decision's waits sit on, through its back reference. */
async function tasksWaitingOn(ctx: Ctx, row: Doc<"session_decisions">): Promise<Task[]> {
  const rows = await Promise.all((row.waiting_task_ids ?? []).map((id) => ctx.db.get(id)));
  return rows.filter((t): t is Task => !!t);
}

/** A decision resolved (sessionDecisions.settleResolution): answered meets
 *  its waits, dismissed or withdrawn fails them. */
export async function settleTaskWaits(ctx: Ctx, row: Doc<"session_decisions">, verdict: Verdict): Promise<void> {
  if (!row.short_id) return;
  const label = answerLabel(row, verdict);
  const [state, note] = verdict.status === "answered"
    ? ["met" as const, `answered${label ? `: ${label.slice(0, 120)}` : ""}`]
    : ["failed" as const, verdict.status];
  const hit = (w: TaskWait) => w.state === "waiting" && w.kind === "decision" && w.decision === row.short_id;
  for (const task of await tasksWaitingOn(ctx, row)) await settleWaits(ctx, task, hit, state, note);
}

/** A reopened decision (sessionDecisions.reopenCore) puts its met waits back to waiting. */
export async function reopenTaskWaits(ctx: Ctx, row: Doc<"session_decisions">): Promise<void> {
  if (!row.short_id) return;
  const hit = (w: TaskWait) => w.state === "met" && w.kind === "decision" && w.decision === row.short_id;
  for (const task of await tasksWaitingOn(ctx, row)) {
    if (!task.waits?.some(hit)) continue;
    const next = task.waits.map((w) => {
      if (!hit(w)) return w;
      const { settled_at: _s, note: _n, ...rest } = w;
      return { ...rest, state: "waiting" as const };
    });
    await writeWaits(ctx, task, next, SYSTEM);
  }
}

/** A time wait's job. It settles only a wait that still exists, still waits
 *  and still names this time, so removing a wait needs no cancellation. */
export const settleTimeWait = internalMutation({
  args: { task_id: v.id("tasks"), wait_id: v.string(), at: v.number() },
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.task_id);
    if (!task) return;
    const hit = (w: TaskWait) => w.id === args.wait_id && w.kind === "time" && w.at === args.at && w.state === "waiting";
    await settleWaits(ctx, task, hit, "met", "passed");
  },
});

/** A task closed (tasks.afterStatusMove): the tasks it blocked whose last
 *  open blocker it was are unblocked. `task` is the row before the move. */
export async function releaseDependents(ctx: Ctx, task: Task, next: string | undefined): Promise<void> {
  if (!next || !isTerminalTaskStatus(next) || isTerminalTaskStatus(task.status) || !task.blocks?.length) return;
  const self = new Set([task.short_id, String(task._id)]);
  const closed = { short_id: task.short_id, status: next };
  const workspace = workspaceForResource(task);
  for (const ref of new Set(task.blocks)) {
    const dep = await taskByRef(ctx, ref);
    if (!dep || isTerminalTaskStatus(dep.status) || !isSameWorkspace(dep, workspace)) continue;
    if (!dep.blocked_by?.some((r) => self.has(r))) continue;
    if (await isTaskUnblocked(ctx, dep, (r) => (self.has(r) ? closed : undefined))) {
      await onUnblocked(ctx, dep, `${task.short_id} ${next}`);
    }
  }
}

/** Nothing in blocked_by is open and every wait is met, reading blockers from
 *  the database. `override` answers for rows the caller knows better. */
async function isTaskUnblocked(ctx: Ctx, task: Task, override?: StatusOf): Promise<boolean> {
  const { statusOf } = await readinessLookups(ctx, [task]);
  return isUnblocked(task, override ? (r) => override(r) ?? statusOf(r) : statusOf);
}

// ---------------------------------------------------------------------------
// Telling the people and sessions doing the work
// ---------------------------------------------------------------------------

/** Wake the session that owns the task (lib/taskOwner) with `content`;
 *  `key` makes the delivery idempotent. Returns false when no live session
 *  owns it. */
async function wakeOwner(ctx: Ctx, task: Task, key: string, content: string): Promise<boolean> {
  const owner = (await boundSessionsOf(ctx, task)).find((c) => !c.inbox_killed_at);
  if (!owner) return false;
  await enqueuePendingMessage(ctx, owner, owner.user_id, { content, client_id: `task-wait:${task._id}:${key}` });
  return true;
}

const taskName = (task: Task) => `${task.short_id}${task.title ? ` ("${task.title.replace(/"/g, "'").slice(0, 80)}")` : ""}`;

/**
 * The task's last open blocker just cleared (TG2): a comment on the task, then
 * the owning session is woken to continue, or else a person it is assigned to
 * is told. This is how an agent parks: it sets a wait on its own task and
 * ends its turn.
 */
export async function onUnblocked(ctx: Ctx, task: Task, cause: string): Promise<void> {
  await insertTaskComment(ctx, task._id, { author: SENDER, text: `Unblocked: ${cause}`, comment_type: "note" });
  const woke = await wakeOwner(
    ctx,
    task,
    `unblocked:${Date.now()}`,
    `${taskName(task)} is unblocked: ${cause}. Nothing it waits on is open any more, so continue the work.`,
  );
  if (woke || task.ephemeral || !task.assignee) return;
  const assignee = ctx.db.normalizeId("users", task.assignee);
  const person = assignee ? await ctx.db.get(assignee) : null;
  if (!person || person.is_bot) return;
  await emitNotification(ctx, {
    event_type: "task_unblocked",
    actor_name: SENDER,
    entity_type: "task",
    entity_id: String(task._id),
    message: `${task.short_id} is unblocked: ${cause}`,
    recipient_ids: [person._id],
  });
}

/** A wait that can no longer be met keeps blocking; the task needs a new
 *  plan, so the task says so and its owner is woken. */
async function onWaitFailed(ctx: Ctx, task: Task, w: TaskWait): Promise<void> {
  const what = blockerLabel(w, STORED);
  await insertTaskComment(ctx, task._id, { author: SENDER, text: `Still blocked: ${what}. This wait can no longer clear.`, comment_type: "blocker" });
  await wakeOwner(
    ctx,
    task,
    `failed:${w.id}:${w.settled_at}`,
    `${taskName(task)} is still blocked: ${what}. That wait can no longer clear, so the task needs a new plan: remove or replace the wait, or change the approach, and say what you decided on the task.`,
  );
}
