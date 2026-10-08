// Waits: blockers on something that is not a task (docs/architecture/task-graph.md
// TG2). A wait lives on its task row (`tasks.waits`) and settles on the event
// it names: a PR merging or closing or its checks turning green (settlePr,
// scheduled by prShepherd.patchPullRequest, the one PR writer), a decision
// being answered, dismissed or withdrawn (settleDecision, scheduled by
// sessionDecisions.settleResolution), or the clock (settleTimeWait). When a
// task's last blocker clears, by a wait settling or being removed or a task in
// its blocked_by closing (releaseDependents, from every close), onUnblocked
// tells the task and whoever works it.
//
// writeWaits is the only writer of `waits`: it keeps `waiting_since` set
// exactly while a wait is waiting, writes the history line, and links each new
// PR or decision wait from its target (`waiting_task_ids`), so an event reads
// only its own tasks and never scans.

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
  workspaceForConversation,
  workspaceForResource,
  workspacesMatch,
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
  SAME_WAIT_TIME_MS,
  sameWaitTarget,
  waitingOnLabel,
  waitLabel,
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
    if (before.has(w.id) || w.kind === "time") continue;
    // A decision is linked even when met at once, so a reopen finds it.
    const target = w.kind === "decision" ? await decisionByShortId(ctx, w.decision)
      : w.state === "waiting" ? await prByNumber(ctx, w.repository, w.pr_number)
      : null;
    if (target) await linkTask(ctx, target, task._id);
  }
  return { ...task, waits: next, waiting_since, updated_at: now };
}

/** Add `taskId` to a wait target's back reference. */
async function linkTask(ctx: Ctx, target: Doc<"session_decisions"> | PR, taskId: Id<"tasks">): Promise<boolean> {
  const linked = target.waiting_task_ids ?? [];
  if (linked.some((id) => String(id) === String(taskId))) return false;
  await ctx.db.patch(target._id, { waiting_task_ids: [...linked, taskId] });
  return true;
}

async function decisionByShortId(ctx: Pick<Ctx, "db">, shortId: string) {
  return await ctx.db.query("session_decisions").withIndex("by_short_id", (q) => q.eq("short_id", shortId)).first();
}

/**
 * "answered: Ship it" when everyone who can read the task can read the
 * decision, else just "answered": the note reaches the task's history, its
 * comment, the owner's wake and the bell, so a private session's answer must
 * not ride it onto a team task.
 */
async function answeredNote(ctx: Ctx, row: Doc<"session_decisions">, verdict: Verdict, task: Task, prefix = "answered"): Promise<string> {
  const label = answerLabel(row, verdict);
  if (!label) return prefix;
  const ws = workspaceForResource(task);
  const conv = ws.type === "team" ? await ctx.db.get(row.conversation_id) : null;
  const shared = ws.type === "personal"
    ? await userMayRead(ctx, ws.userId, row)
    : !!conv && workspacesMatch(workspaceForConversation(conv), ws);
  return shared ? `${prefix}: ${unmention(label.slice(0, 120))}` : prefix;
}

/** An answer quoted in a system note addresses nobody: "@bob" there would
 *  subscribe Bob through a comment no one typed at him. */
const unmention = (text: string) => text.replace(/(^|[^\w/])@(?=[A-Za-z0-9])/g, "$1");

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
      const verdict: Verdict = { status: "answered", answer_index: row.answer_index, answer_text: row.answer_text, answer_json: row.answer_json };
      return { met: true, note: await answeredNote(ctx, row, verdict, task, "already answered") };
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
  const existing = waits.find((w) => (id && w.id === id) || (w.state === "waiting" && sameWaitTarget(w, target)));
  // The web paints its wait under its own id; one that lands on another wait
  // is refused, so the client rolls its draft back instead of holding a copy.
  if (existing && id && existing.id !== id) throw new Error(`${task.short_id} is already ${waitingOnLabel(existing, STORED).replace(/^W/, "w")}`);
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
 *  removed. Removing the last open blocker unblocks the task the way a
 *  settle does, so a session parked on it is woken. */
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
  let byTime = false;
  const ref = str(which.ref);
  if (str(which.wait_id)) match = (w) => w.id === which.wait_id;
  else if (ref) {
    const p = parseBlockerRef(ref, { timeZone: str(which.time_zone) });
    if (!p.ok) throw new Error(p.error);
    byTime = p.kind === "time";
    match = (w) =>
      w.kind === p.kind &&
      (w.kind === "decision" ? p.kind === "decision" && w.decision === p.decision
        : w.kind === "time" ? p.kind === "time" && Math.abs(w.at - p.at) < SAME_WAIT_TIME_MS
        : (p.kind === "pr_merged" || p.kind === "pr_checks_green") && w.pr_number === p.pr_number &&
          (!p.repository || normalizeRepository(p.repository) === normalizeRepository(w.repository)));
  } else throw new Error("Name the wait to remove: its id or what it waits on");
  const removed = waits.filter(match);
  if (!removed.length) {
    // A relative time ("2h") names a new moment each time it is read, so a
    // time wait is removed by its id or the absolute time it names.
    const times = byTime ? waits.filter((w) => w.kind === "time").map((w) => `${w.id} (${waitLabel(w, STORED)})`) : [];
    const hint = times.length ? `. Remove a time wait by its id: ${times.join(", ")}` : "";
    throw new Error(`${task.short_id} has no wait on ${ref ?? which.wait_id}${hint}`);
  }
  const wasUnblocked = await isTaskUnblocked(ctx, task);
  const after = await writeWaits(ctx, task, waits.filter((w) => !match(w)), by);
  if (!wasUnblocked && !isTerminalTaskStatus(after.status) && (await isTaskUnblocked(ctx, after))) {
    const what = removed.map((w) => `the wait ${w.kind === "time" ? "" : "on "}${waitLabel(w, STORED)}`).join(", ");
    await onUnblocked(ctx, after, `${await writerName(ctx, by)} removed ${what}`, {
      actorUserId: by.user_id,
      conversationId: by.conversation_id,
      key: `removed:${removed.map((w) => w.id).join(",")}`,
    });
  }
  return { removed };
}

/** Who a history line names: the session that wrote, else the person. */
async function writerName(ctx: Ctx, by: TaskChangeBy): Promise<string> {
  const conv = by.conversation_id ? await ctx.db.get(by.conversation_id) : null;
  if (conv?.short_id) return `session ${conv.short_id}`;
  const user = by.user_id ? await ctx.db.get(by.user_id) : null;
  return user?.name || "someone";
}

/** Who a CLI call writes as: an agent when it names its session, else a
 *  person at the terminal (subscribeUser's rule). */
export async function cliWriter(ctx: Ctx, userId: Id<"users">, conversationId: string | undefined) {
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

/** What a settle makes of one wait, or undefined to leave it as it is. */
type Settle = { state: "met" | "failed"; note: string };

/** Who an unblock is by (their own change rings no bell of theirs and wakes
 *  no session that made it), and `key`, naming what cleared it so the wake is
 *  delivered once; it defaults to the cause at the row's version. */
type UnblockBy = { actorUserId?: Id<"users">; conversationId?: Id<"conversations">; key?: string };

/**
 * Settle the waits of `task` that `settle` decides, then tell whoever works
 * it: a failed wait asks for a new plan; the last open blocker clearing runs
 * onUnblocked. A task already closed is only written. `by` made the change
 * that settled it, so it is not told of its own act. Returns the row as
 * written.
 */
async function settleWaits(ctx: Ctx, task: Task, settle: (w: TaskWait) => Settle | undefined, by: Omit<UnblockBy, "key"> = {}): Promise<Task> {
  const now = Date.now();
  const settled: TaskWait[] = [];
  const next = (task.waits ?? []).map((w) => {
    const s = settle(w);
    if (!s) return w;
    const out: TaskWait = { ...w, ...s, settled_at: now };
    settled.push(out);
    return out;
  });
  if (!settled.length) return task;
  const after = await writeWaits(ctx, task, next, SYSTEM, now);
  if (isTerminalTaskStatus(after.status)) return after;
  const failed = settled.filter((w) => w.state === "failed");
  for (const w of failed) await onWaitFailed(ctx, after, w, by.conversationId);
  if (!failed.length && (await isTaskUnblocked(ctx, after))) {
    await onUnblocked(ctx, after, settled.map(metCause).join(", "), { ...by, key: `met:${settled.map((w) => w.id).join(",")}@${now}` });
  }
  return after;
}

type PrWait = Extract<TaskWait, PrWaitTarget>;
const isPrWait = (w: TaskWait): w is PrWait => w.kind === "pr_merged" || w.kind === "pr_checks_green";

/** What a PR as it now stands makes of a wait on it. A checks wait whose PR
 *  merged or closed before going green can no longer clear. */
function prSettle(pr: PR, w: PrWait): Settle | undefined {
  if (w.kind === "pr_merged") {
    if (pr.state === "merged") return { state: "met", note: "merged" };
    return pr.state === "closed" ? { state: "failed", note: "closed without merging" } : undefined;
  }
  if (pr.checks_state === "success") return { state: "met", note: "checks green" };
  return pr.state === "open" ? undefined : { state: "failed", note: `${pr.state} before its checks went green` };
}

/**
 * A PR moved (scheduled by prShepherd.patchPullRequest on a state or checks
 * move, so no webhook transaction carries it): settle the waits on it that
 * its state now decides, and keep its back reference to the tasks still
 * waiting. It reads the row as it stands, so a missed event or a repeat
 * settles the same way.
 */
export const settlePr = internalMutation({
  args: { pr_id: v.id("pull_requests") },
  handler: async (ctx, { pr_id }) => {
    const pr = await ctx.db.get(pr_id);
    if (!pr?.waiting_task_ids?.length) return;
    const repository = normalizeRepository(pr.repository);
    const onThis = (w: TaskWait): w is PrWait =>
      w.state === "waiting" && isPrWait(w) && w.pr_number === pr.number && normalizeRepository(w.repository) === repository;
    const still: Id<"tasks">[] = [];
    for (const id of pr.waiting_task_ids) {
      let task = await ctx.db.get(id);
      if (!task?.waits?.some(onThis)) continue;
      if (await prReachesTask(ctx, pr, task)) task = await settleWaits(ctx, task, (w) => (onThis(w) ? prSettle(pr, w) : undefined));
      if (task.waits?.some(onThis)) still.push(id);
    }
    if (still.length !== pr.waiting_task_ids.length) await ctx.db.patch(pr._id, { waiting_task_ids: still });
  },
});

/** One-off: link the PR waits set before PR rows carried `waiting_task_ids`,
 *  and settle each linked PR as it now stands. Idempotent; run until it
 *  reports `done`. */
export const linkPrWaits = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, { cursor }) => {
    const page = await ctx.db
      .query("tasks")
      .withIndex("by_waiting_since", (q) => q.gt("waiting_since", 0))
      .paginate({ cursor: cursor ?? null, numItems: 200 });
    let linked = 0;
    for (const task of page.page) {
      for (const w of task.waits ?? []) {
        if (w.state !== "waiting" || !isPrWait(w)) continue;
        const pr = await prByNumber(ctx, w.repository, w.pr_number);
        if (!pr || !(await linkTask(ctx, pr, task._id))) continue;
        linked++;
        await ctx.scheduler.runAfter(0, internal.taskWaits.settlePr, { pr_id: pr._id });
      }
    }
    return { linked, cursor: page.continueCursor, done: page.isDone };
  },
});

/** The tasks a decision's waits sit on, through its back reference. */
async function tasksWaitingOn(ctx: Ctx, row: Doc<"session_decisions">): Promise<Task[]> {
  const rows = await Promise.all((row.waiting_task_ids ?? []).map((id) => ctx.db.get(id)));
  return rows.filter((t): t is Task => !!t);
}

/** A decision's waits settle: answered meets them, dismissed or withdrawn
 *  fails them. `by` is who resolved it, told nothing of their own act. */
export async function settleTaskWaits(ctx: Ctx, row: Doc<"session_decisions">, verdict: Verdict, by: Omit<UnblockBy, "key"> = {}): Promise<void> {
  if (!row.short_id) return;
  const hit = (w: TaskWait) => w.state === "waiting" && w.kind === "decision" && w.decision === row.short_id;
  for (const task of await tasksWaitingOn(ctx, row)) {
    if (!task.waits?.some(hit)) continue;
    const settle: Settle = verdict.status === "answered"
      ? { state: "met", note: await answeredNote(ctx, row, verdict, task) }
      : { state: "failed", note: verdict.status };
    await settleWaits(ctx, task, (w) => (hit(w) ? settle : undefined), by);
  }
}

/** A decision resolved (sessionDecisions.settleResolution, the org
 *  proposals' card withdraw): its waits settle in a job of their own, so a
 *  failure there never rolls back the answer. */
export async function scheduleDecisionSettle(
  ctx: Ctx,
  row: Doc<"session_decisions">,
  by: { user_id?: Id<"users">; via?: Id<"conversations"> } = {},
): Promise<void> {
  if (!row.waiting_task_ids?.length) return;
  await ctx.scheduler.runAfter(0, internal.taskWaits.settleDecision, {
    decision_id: row._id,
    ...(by.user_id ? { actor_user_id: by.user_id } : {}),
    ...(by.via ? { conversation_id: by.via } : {}),
  });
}

/** The job: it reads the decision as it stands, so a repeat settles the same
 *  way and one reopened since settles nothing. */
export const settleDecision = internalMutation({
  args: { decision_id: v.id("session_decisions"), actor_user_id: v.optional(v.id("users")), conversation_id: v.optional(v.id("conversations")) },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.decision_id);
    if (!row || row.status === "pending") return;
    const verdict: Verdict = row.status === "answered"
      ? { status: "answered", answer_index: row.answer_index, answer_text: row.answer_text, answer_json: row.answer_json }
      : { status: row.status };
    await settleTaskWaits(ctx, row, verdict, { actorUserId: args.actor_user_id, conversationId: args.conversation_id });
  },
});

/** A reopened decision (sessionDecisions.reopenCore) puts its met waits back
 *  to waiting, and the task and its owner hear that the answer no longer stands. */
export async function reopenTaskWaits(ctx: Ctx, row: Doc<"session_decisions">): Promise<void> {
  if (!row.short_id) return;
  const hit = (w: TaskWait) => w.state === "met" && w.kind === "decision" && w.decision === row.short_id;
  for (const task of await tasksWaitingOn(ctx, row)) {
    const reopened = task.waits?.find(hit);
    if (!reopened) continue;
    const next = task.waits!.map((w) => {
      if (!hit(w)) return w;
      const { settled_at: _s, note: _n, ...rest } = w;
      return { ...rest, state: "waiting" as const };
    });
    const after = await writeWaits(ctx, task, next, SYSTEM);
    if (isTerminalTaskStatus(after.status)) continue;
    await insertTaskComment(ctx, after._id, { author: SENDER, text: `Waiting again: ${row.short_id} was reopened, so its answer no longer stands.`, comment_type: "note" });
    await wakeOwner(
      ctx,
      after,
      `reopened:${reopened.id}:${reopened.settled_at}`,
      `${taskName(after)} waits on ${row.short_id} again: the decision was reopened, so its earlier answer no longer stands. Hold any work that depends on it until it is answered again.`,
    );
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
    await settleWaits(ctx, task, (w) => (hit(w) ? { state: "met", note: "passed" } : undefined));
  },
});

/** A task closed (tasks.afterStatusMove, tasks.cascadeClose, an org
 *  proposal's or an issue sync's close): the tasks it blocked whose last open
 *  blocker it was are unblocked. `task` is the row before the move.
 *  `closingLater` is a task closing in the same write whose own release comes
 *  after this one (a cascade's parent), read at its old status so a dependent
 *  of both is told once, by the later release. `closing` holds the ids of
 *  every task the same write closes: one of them is never told it is
 *  unblocked a moment before it closes. */
export async function releaseDependents(
  ctx: Ctx,
  task: Task,
  next: string | undefined,
  { closingLater: later, closing, ...by }: Omit<UnblockBy, "key"> & { closingLater?: Task; closing?: ReadonlySet<string> } = {},
): Promise<void> {
  if (!next || !isTerminalTaskStatus(next) || isTerminalTaskStatus(task.status) || !task.blocks?.length) return;
  const self = new Set([task.short_id, String(task._id)]);
  const known = new Map<string, { short_id?: string; status: string }>([...self].map((r) => [r, { short_id: task.short_id, status: next }]));
  if (later) for (const r of [later.short_id, String(later._id)]) if (r) known.set(r, { short_id: later.short_id, status: later.status });
  const workspace = workspaceForResource(task);
  for (const ref of new Set(task.blocks)) {
    const dep = await taskByRef(ctx, ref);
    if (!dep || isTerminalTaskStatus(dep.status) || closing?.has(String(dep._id)) || !isSameWorkspace(dep, workspace)) continue;
    if (!dep.blocked_by?.some((r) => self.has(r))) continue;
    if (await isTaskUnblocked(ctx, dep, (r) => known.get(r))) {
      await onUnblocked(ctx, dep, `${task.short_id} ${next}`, { ...by, key: `closed:${task.short_id}:${next}:${task.updated_at ?? 0}` });
    }
  }
}

/** Nothing in blocked_by is open and every wait is met, reading blockers from
 *  the database. `override` answers for rows the caller knows better. */
export async function isTaskUnblocked(ctx: Ctx, task: Task, override?: StatusOf): Promise<boolean> {
  const { statusOf } = await readinessLookups(ctx, [task]);
  return isUnblocked(task, override ? (r) => override(r) ?? statusOf(r) : statusOf);
}

// ---------------------------------------------------------------------------
// Telling the people and sessions doing the work
// ---------------------------------------------------------------------------

/** Wake the session that owns the task (lib/taskOwner) with `content`.
 *  `key` names the event, so a delivery of the same event is enqueued once.
 *  Returns false when no live session owns it, or the one that does is
 *  `skip` (the session that made the change). */
async function wakeOwner(ctx: Ctx, task: Task, key: string, content: string, skip?: Id<"conversations">): Promise<boolean> {
  const owner = (await boundSessionsOf(ctx, task)).find((c) => !c.inbox_killed_at);
  if (!owner) return false;
  if (skip && String(owner._id) === String(skip)) return true;
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
export async function onUnblocked(ctx: Ctx, task: Task, cause: string, by: UnblockBy = {}): Promise<void> {
  await insertTaskComment(ctx, task._id, { author: SENDER, text: `Unblocked: ${cause}`, comment_type: "note" });
  const woke = await wakeOwner(
    ctx,
    task,
    `unblocked:${by.key ?? `${cause}@${task.updated_at ?? 0}`}`,
    `${taskName(task)} is unblocked: ${cause}. Nothing it waits on is open any more, so continue the work.`,
    by.conversationId,
  );
  if (woke || task.ephemeral || !task.assignee) return;
  const assignee = ctx.db.normalizeId("users", task.assignee);
  const person = assignee ? await ctx.db.get(assignee) : null;
  if (!person || person.is_bot) return;
  await emitNotification(ctx, {
    event_type: "task_unblocked",
    actor_name: SENDER,
    ...(by.actorUserId ? { actor_user_id: by.actorUserId } : {}),
    entity_type: "task",
    entity_id: String(task._id),
    message: `${task.short_id} is unblocked: ${cause}`,
    recipient_ids: [person._id],
  });
}

/** A released task waits on open work again (a link moved its blockers): the
 *  task says so and its owner is woken, since it may have started. */
export async function onBlockedAgain(ctx: Ctx, task: Task, cause: string, by: UnblockBy = {}): Promise<void> {
  await insertTaskComment(ctx, task._id, { author: SENDER, text: `Blocked again: ${cause}`, comment_type: "blocker" });
  await wakeOwner(
    ctx,
    task,
    `reblocked:${by.key ?? `${cause}@${task.updated_at ?? 0}`}`,
    `${taskName(task)} is blocked again: ${cause}. Hold work that needs it until it is unblocked, and say on the task what you did.`,
    by.conversationId,
  );
}

/** A wait that can no longer be met keeps blocking; the task needs a new
 *  plan, so the task says so and its owner is woken. */
async function onWaitFailed(ctx: Ctx, task: Task, w: TaskWait, skip?: Id<"conversations">): Promise<void> {
  const what = blockerLabel(w, STORED);
  await insertTaskComment(ctx, task._id, { author: SENDER, text: `Still blocked: ${what}. This wait can no longer clear.`, comment_type: "blocker" });
  await wakeOwner(
    ctx,
    task,
    `failed:${w.id}:${w.settled_at}`,
    `${taskName(task)} is still blocked: ${what}. That wait can no longer clear, so the task needs a new plan: remove or replace the wait, or change the approach, and say what you decided on the task.`,
    skip,
  );
}
