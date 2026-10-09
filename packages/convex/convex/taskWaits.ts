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
  accessStampFor,
  canAccessPullRequest,
  canAccessTask,
  isSameWorkspace,
  resolveSessionConversation,
  workspaceForConversation,
  workspaceForResource,
  workspacesMatch,
} from "./lib/access";
import { isTeamMember } from "./privacy";
import { installationForRepo } from "./githubApp";
import { bySystem, byUser, recordTaskChange, type TaskChangeBy, type TaskFieldChange } from "./lib/taskHistory";
import { patchTask } from "./lib/taskWrite";
import { dependentRefs, taskByRef, taskLookups } from "./lib/taskGraph";
import { prByNumber } from "./lib/gitRefs";
import { boundSessionsOf } from "./lib/taskOwner";
import { waitTargetValidator } from "./lib/taskWaitValidator";
import { enqueuePendingMessage } from "./pendingMessages";
import { ExecutionAuthorityError } from "./executionBindings";
import { emitNotification } from "./notificationRouter";
import { insertTaskComment } from "./tasks";
import { answerLabel, userMayRead, verdictOfRow, type Verdict } from "./sessionDecisions";
import {
  isTerminalTaskStatus,
  isUnblocked,
  failedWaitAdvice,
  isWaitId,
  newWaitId,
  noWaitOnLine,
  parseBlockerRef,
  prRef,
  isPrWaitTarget,
  prWords,
  sameWaitTarget,
  STORED_WAIT_WORDS,
  waitClause,
  waitFailedCause,
  waitFailedWord,
  waitIsReplaceable,
  waitLabel,
  waitLine,
  waitMetCause,
  waitMetNote,
  waitTimeRef,
  type PrWaitTarget,
  type TimeWaitTarget,
  type StatusOf,
  type TaskWait,
  type WaitLabelOptions,
  type WaitTarget,
} from "@codecast/shared/tasks";
import { inlineForeignText, normalizeRepository, repositoryKeyOfRemote } from "@codecast/shared/contracts";

type Ctx = MutationCtx;
type Task = Doc<"tasks">;
type PR = Doc<"pull_requests">;

/** Who signs what codecast writes on a task on its own: the waits' and the
 *  graph's comments and notices. */
export const SENDER = "codecast";
/** Stored text about a wait is read later, in other zones (TG11). The words
 *  are the shared ones, so this and the claim's skip reason (taskFrontier)
 *  cannot drift from the client twin agents read them beside. */
const STORED = STORED_WAIT_WORDS;

/** The repositories of a task's work, read at most once however many callers
 *  in one mutation ask for them: taskRepositories walks the directory mappings
 *  and up to twenty of the task's sessions, and one addWait asks twice (a bare
 *  `#42` resolving its repository, then the words its history is stored in). */
type TaskRepos = () => Promise<string[]>;

function taskReposOnce(ctx: Ctx, task: Task): TaskRepos {
  let read: Promise<string[]> | undefined;
  return () => (read ??= taskRepositories(ctx, task));
}

/** STORED for `task`'s own text. It is also read away from any checkout, so a
 *  PR outside the task's one repository (taskRepositories) is named in full. */
async function storedWords(ctx: Ctx, task: Task, waits: TaskWait[] = task.waits ?? [], repos = taskReposOnce(ctx, task)): Promise<WaitLabelOptions> {
  if (!waits.some(isPrWaitTarget)) return STORED;
  const named = await repos();
  return { ...STORED, ...prWords(named.length === 1 ? named[0] : null) };
}

// ---------------------------------------------------------------------------
// The one writer
// ---------------------------------------------------------------------------

/**
 * Replace `task`'s waits with `next`. Recomputes `waiting_since` (kept while
 * any wait still waits, cleared otherwise), writes one history line per wait
 * that was added, settled, reopened or removed, and links each new PR or
 * decision wait from its target (`waiting_task_ids`). Returns the row as
 * written and the words its waits are stored in (storedWords), for the
 * caller's own text about them.
 */
export async function writeWaits(
  ctx: Ctx,
  task: Task,
  next: TaskWait[],
  by: TaskChangeBy,
  now = Date.now(),
  repos = taskReposOnce(ctx, task),
): Promise<{ task: Task; words: WaitLabelOptions }> {
  const prev = task.waits ?? [];
  const waiting_since = next.some((w) => w.state === "waiting") ? (task.waiting_since ?? now) : undefined;
  await patchTask(ctx, task, { waits: next, waiting_since, updated_at: now });

  const before = new Map(prev.map((w) => [w.id, w]));
  const kept = new Set(next.map((w) => w.id));
  const gone = prev.filter((w) => !kept.has(w.id));
  const moved = next.filter((w) => before.get(w.id) !== w);
  // The words are what a wait's history line is stored in, so they are read
  // only when a line can move; a write that left every wait as it was reads
  // the task's repositories for nothing. Both sides of a line are rendered in
  // today's words, so a wait rebuilt unchanged renders the same twice and
  // recordTaskChange writes nothing for it.
  const words = gone.length || moved.length ? await storedWords(ctx, task, [...prev, ...next], repos) : STORED;
  const changes: TaskFieldChange[] = [
    ...gone.map((w): TaskFieldChange => ["waits", waitLine(w, words), ""]),
    ...moved.map((w): TaskFieldChange => ["waits", before.has(w.id) ? waitLine(before.get(w.id)!, words) : "", waitLine(w, words)]),
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
  return { task: { ...task, waits: next, waiting_since, updated_at: now }, words };
}

/** Add `taskId` to a wait target's back reference. Exported for the one-off
 *  that links the PR waits set before PR rows carried one
 *  (migrations.linkPrWaits); every live write of it is writeWaits's. */
export async function linkTask(ctx: Ctx, target: Doc<"session_decisions"> | PR, taskId: Id<"tasks">): Promise<boolean> {
  const linked = target.waiting_task_ids ?? [];
  if (linked.some((id) => String(id) === String(taskId))) return false;
  await ctx.db.patch(target._id, { waiting_task_ids: [...linked, taskId] });
  return true;
}

async function decisionByShortId(ctx: Pick<Ctx, "db">, shortId: string) {
  return await ctx.db.query("session_decisions").withIndex("by_short_id", (q) => q.eq("short_id", shortId)).first();
}

/**
 * The note on a decision wait the answer meets: "answered: Ship it" when
 * everyone who can read the task can read the decision, else just "answered".
 * The note reaches the task's history, its comment, the owner's wake and the
 * bell, so a private session's answer must not ride it onto a team task.
 * `atOnce` for a wait met the moment it was set (waitMetNote).
 */
async function answeredNote(ctx: Ctx, row: Doc<"session_decisions">, verdict: Verdict, task: Task, atOnce = false): Promise<string> {
  const label = answerLabel(row, verdict);
  const ws = workspaceForResource(task);
  const conv = label && ws.type === "team" ? await ctx.db.get(row.conversation_id) : null;
  const shared = !!label && (ws.type === "personal"
    ? await taskReadersMayRead(ctx, task, ws.userId, row)
    : !!conv && workspacesMatch(workspaceForConversation(conv), ws));
  return waitMetNote("decision", { atOnce, ...(shared ? { answer: unmention(inlineForeignText(label).slice(0, 120)) } : {}) });
}

/** Whether EVERY reader a personally-keyed task admits can read the decision,
 *  not just its owner: a task routed to a team keeps a personal access key and
 *  can still be assigned to another member (assigneeScopeOf), and an assignee
 *  is an explicit read grant (accessStampFor), so the answer text in the note
 *  would reach someone the decision does not. The team branch needs no such
 *  walk — a team task's assignee is a member of the team the note is already
 *  judged against. */
async function taskReadersMayRead(ctx: Ctx, task: Task, owner: Id<"users">, row: Doc<"session_decisions">): Promise<boolean> {
  const stamp = await accessStampFor(ctx, "tasks", task);
  const readers = new Set<string>([String(owner), ...(stamp?.access_grants ?? [])]);
  for (const id of readers) if (!(await userMayRead(ctx, id as Id<"users">, row))) return false;
  return true;
}

/** An answer quoted in a system note addresses nobody: "@bob" there would
 *  subscribe Bob through a comment no one typed at him. It is also foreign
 *  text bound for another session's wake, so it stays one escaped line, as
 *  the task's title does (taskName). */
const unmention = (text: string) => text.replace(/(^|[^\w/])@(?=[A-Za-z0-9])/g, "$1");

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
  if (raw && isPrWaitTarget(raw)) {
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
async function resolveTarget(ctx: Ctx, userId: Id<"users">, task: Task, input: AddWaitInput, now: number, repos: TaskRepos): Promise<WaitTarget> {
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
    : await repositoryForBarePr(ctx, userId, task, target.pr_number, str(input.repository), repos);
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
 * sees PR #42; still several, or none, the caller's checkout settles it when
 * it is one of them, else it fails with the candidates.
 */
async function repositoryForBarePr(ctx: Ctx, userId: Id<"users">, task: Task, n: number, fallback: string | undefined, repos: TaskRepos): Promise<string> {
  const fromProject = await repos();
  const candidates = fromProject.length ? fromProject : fallback ? [normalizeRepository(fallback)] : [];
  if (!candidates.length) throw new Error(`#${n}: ${task.short_id} names no repository to find it in. Write owner/repo#${n}.`);
  if (candidates.length === 1) return candidates[0];
  const seen: string[] = [];
  for (const repo of candidates) {
    const pr = await prByNumber(ctx, repo, n);
    if (pr && (await canAccessPullRequest(ctx, userId, pr))) seen.push(repo);
  }
  if (seen.length === 1) return seen[0];
  const pool = seen.length ? seen : candidates;
  const own = fallback && normalizeRepository(fallback);
  if (own && pool.includes(own)) return own;
  throw new Error(`#${n} is ambiguous for ${task.short_id}: write one of ${pool.map((r) => `${r}#${n}`).join(", ")}`);
}

/** Why checkTarget refuses a target that already failed. */
const NEVER_CLEARS = "so a wait on it would never clear";

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
    const verdict = verdictOfRow(row);
    if (verdict?.status === "answered") return { met: true, note: await answeredNote(ctx, row, verdict, task, true) };
    if (row.status !== "pending") throw new Error(`${t.decision} was ${waitFailedWord(t.kind, row.status)}, ${NEVER_CLEARS}`);
    return { met: false };
  }
  const name = `PR ${prRef(t, { fullRef: true })}`;
  const pr = await prByNumber(ctx, t.repository, t.pr_number);
  if (!pr || !(await canAccessPullRequest(ctx, userId, pr))) {
    // A covered repository answers for its other PRs, so only this one is in doubt.
    const why = (await installationForRepo(ctx, { repository: t.repository, user_id: userId }))
      ? "it has not synced, or does not exist"
      : `no GitHub app installation of yours covers ${t.repository}`;
    throw new Error(`codecast cannot see ${name}: ${why}. A wait on it would never clear.`);
  }
  if (!(await prReachesTask(ctx, pr, task))) {
    throw new Error(`${name} belongs to a team ${task.short_id} is not in, so its events never reach the task`);
  }
  if (t.kind === "pr_merged") {
    if (pr.state === "merged") return { met: true, note: waitMetNote(t.kind, { atOnce: true }) };
    if (pr.state === "closed") throw new Error(`${name} was ${waitFailedWord(t.kind)}, ${NEVER_CLEARS}`);
    return { met: false };
  }
  if (pr.checks_state === "success") return { met: true, note: waitMetNote(t.kind, { atOnce: true }) };
  if (pr.state !== "open") throw new Error(`${name} was ${waitFailedWord(t.kind, pr.state)}, ${NEVER_CLEARS}`);
  return { met: false };
}

/** The task a caller may write waits on, by short id. */
async function writableTask(ctx: Ctx, userId: Id<"users">, shortId: string): Promise<Task> {
  const task = await ctx.db.query("tasks").withIndex("by_short_id", (q) => q.eq("short_id", shortId)).first();
  if (!task || !(await canAccessTask(ctx, userId, task))) throw new Error("Task not found");
  return task;
}

/**
 * Set a wait on a task. The web's retry finds its wait by id, whatever became
 * of it. A wait on the same target that is still waiting or met for good is
 * returned as is, so a retry adds nothing; a replaceable one (waitIsReplaceable)
 * gives way to the new one, which is checked afresh: a failed wait would keep
 * blocking beside it, and a met checks wait may stand on checks a push has
 * since turned red. A replacement met at once unblocks the task the way a
 * settle does. A time wait schedules the job that settles it.
 */
export async function addWaitCore(
  ctx: Ctx,
  userId: Id<"users">,
  shortId: string,
  input: AddWaitInput,
  by: TaskChangeBy & { created_by?: string } = byUser(userId),
): Promise<AddWaitResult> {
  const now = Date.now();
  const task = await writableTask(ctx, userId, shortId);
  const repos = taskReposOnce(ctx, task);
  const target = await resolveTarget(ctx, userId, task, input, now, repos);
  const waits = task.waits ?? [];
  const id = str(input.id);
  const own = id ? waits.find((w) => w.id === id) : undefined;
  if (own) return { wait: own, met: own.state === "met", existing: true };
  const existing = waits.find((w) => !waitIsReplaceable(w) && sameWaitTarget(w, target));
  // The web paints its wait under its own id; one that lands on another wait
  // is refused, so the client rolls its draft back instead of holding a copy.
  if (existing && id) {
    throw new Error(`${task.short_id} ${existing.state === "met" ? "already has a wait" : "is already waiting"} ${waitClause(existing, STORED)}`);
  }
  if (existing) return { wait: existing, met: existing.state === "met", existing: true };
  if (id && !isWaitId(id)) throw new Error(`"${id}" is not a wait id (shared/tasks newWaitId)`);

  const check = await checkTarget(ctx, userId, task, target, now);
  const wait: TaskWait = {
    ...target,
    id: id ?? newWaitId(now),
    state: check.met ? "met" : "waiting",
    created_at: now,
    created_by: by.created_by ?? String(userId),
    ...(check.met ? { settled_at: now, note: check.note } : {}),
  };
  const { created_by: _createdBy, ...changeBy } = by;
  const replaced = waits.filter((w) => waitIsReplaceable(w) && sameWaitTarget(w, target));
  const wasUnblocked = replaced.length && check.met ? await isTaskUnblocked(ctx, task) : true;
  const { task: after, words } = await writeWaits(ctx, task, [...waits.filter((w) => !replaced.includes(w)), wait], changeBy, now, repos);
  if (!wasUnblocked && !isTerminalTaskStatus(after.status) && (await isTaskUnblocked(ctx, after))) {
    await onUnblocked(ctx, after, waitMetCause(wait, { ...words, fullRef: true }), unblockBy(changeBy, `met:${wait.id}`));
  }
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
  by: TaskChangeBy = byUser(userId),
): Promise<{ removed: TaskWait[] }> {
  const task = await writableTask(ctx, userId, shortId);
  const waits = task.waits ?? [];
  let match: (w: TaskWait) => boolean;
  let byTime = false;
  const ref = str(which.ref);
  if (str(which.wait_id)) match = (w) => w.id === which.wait_id;
  else if (ref) {
    // A met time wait stays as history, so its time may be past.
    const p = parseBlockerRef(ref, { timeZone: str(which.time_zone), allowPast: true });
    if (!p.ok) throw new Error(p.error);
    // Refused where it is parsed, symmetric to resolveTarget on the way in: a
    // task ref matches no wait, and the refusal below would then point at a
    // list of waits that could never hold it.
    if (p.kind === "task") throw new Error(`${p.ref} is a task: remove it as a dependency (blocked_by), not a wait`);
    byTime = p.kind === "time";
    // A bare `#42` has no repository, which sameWaitTarget matches in any.
    const { ok: _ok, ...target } = p;
    match = (w) => sameWaitTarget(w, target as WaitTarget);
  } else throw new Error("Name the wait to remove: its id or what it waits on");
  const removed = waits.filter(match);
  // By id is the web's dispatch, whose retry finds its wait already gone.
  if (!removed.length && str(which.wait_id)) return { removed };
  if (!removed.length) {
    // A relative time ("2h") names a new moment each time it is read, so a
    // time wait is removed by its id or the moment it names. The moment is
    // offered as the ref the flag takes, pinned to UTC: a bare time is read as
    // wall time in the caller's zone, so an agent shown the stored absolute
    // ("Oct 9, 2026 05:02 UTC") and writing it back bare is the usual way to
    // land here off UTC, and a hint spelling that same clock time again would
    // name what was just refused (TG11).
    const times = byTime
      ? waits
        .filter((w): w is TaskWait & TimeWaitTarget => w.kind === "time")
        .map((w) => `${w.id} (${waitLabel(w, STORED)}; as a ref ${waitTimeRef(w.at)})`)
      : [];
    // The sentence is shared with the CLI's own version of this refusal
    // (noWaitRemovedLine): both exit non-zero, so both say where to look
    // (TG12). Only the time-wait tail is this path's own.
    throw new Error(noWaitOnLine(
      task.short_id,
      `on ${ref ?? which.wait_id}`,
      times.length ? `. Remove a time wait by its id, or by the moment in UTC: ${times.join(", ")}` : undefined,
    ));
  }
  const wasUnblocked = await isTaskUnblocked(ctx, task);
  const { task: after, words } = await writeWaits(ctx, task, waits.filter((w) => !match(w)), by);
  if (!wasUnblocked && !isTerminalTaskStatus(after.status) && (await isTaskUnblocked(ctx, after))) {
    // The full ref, as the met and failed causes use: the comment is frozen
    // text, so a bare `#42` in it could never resolve to a live pill.
    const what = removed.map((w) => `the wait ${waitClause(w, { ...words, fullRef: true })}`).join(", ");
    await onUnblocked(ctx, after, `${await writerName(ctx, by)} removed ${what}`, unblockBy(by, `removed:${removed.map((w) => w.id).join(",")}`));
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
async function cliWriter(ctx: Ctx, userId: Id<"users">, conversationId: string | undefined) {
  const conv = conversationId ? await resolveSessionConversation(ctx, userId, conversationId) : null;
  return conv
    ? { user_id: userId, actor_type: "agent" as const, conversation_id: conv._id, created_by: conv.short_id ?? String(conv._id) }
    : { user_id: userId, actor_type: "user" as const };
}

/** A CLI mutation's caller: the token's user, `writer` (cliWriter, which
 *  signs a wait's created_by) and `by`, the same without it, for history. */
export async function cliCaller(ctx: Ctx, args: { api_token: string; conversation_id?: string }) {
  const auth = await verifyApiToken(ctx, args.api_token);
  if (!auth) throw new Error("Unauthorized");
  const writer = await cliWriter(ctx, auth.userId, args.conversation_id);
  const { created_by: _c, ...by } = writer;
  return { userId: auth.userId as Id<"users">, writer, by: by as TaskChangeBy };
}

/** `cast task create --blocked-by #42,2h`: the new task's waits, added inside
 *  its create, so a refused wait files nothing and the task is never ready
 *  before its waits hold it. */
export async function addWaitsAtCreate(
  ctx: Ctx,
  userId: Id<"users">,
  shortId: string,
  args: { waits?: string[]; repository?: string; time_zone?: string; conversation_id?: string },
): Promise<AddWaitResult[] | undefined> {
  if (!args.waits?.length) return undefined;
  const by = await cliWriter(ctx, userId, args.conversation_id);
  const added: AddWaitResult[] = [];
  for (const ref of args.waits) added.push(await addWaitCore(ctx, userId, shortId, { ref, repository: args.repository, time_zone: args.time_zone }, by));
  return added;
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
    const { userId, writer } = await cliCaller(ctx, args);
    const { api_token: _t, short_id, conversation_id: _c, ...input } = args;
    return await addWaitCore(ctx, userId, short_id, input, writer);
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
    const { userId, by } = await cliCaller(ctx, args);
    return await removeWaitCore(ctx, userId, args.short_id, args, by);
  },
});

// ---------------------------------------------------------------------------
// Settling
// ---------------------------------------------------------------------------

/** What a settle makes of one wait. */
type Settle = { state: "met" | "failed"; note: string };

/** Who an unblock is by (their own change rings no bell of theirs and wakes
 *  no session that made it), `told`, a session that hears of it another way
 *  (a decision's asker gets the answer as its own message), and `key`,
 *  naming what cleared it so the wake is delivered once; it defaults to the
 *  cause at the row's version. */
type UnblockBy = { actorUserId?: Id<"users">; conversationId?: Id<"conversations">; told?: Id<"conversations">; key?: string };

/** The unblock a history writer `by` made, delivered once per `key`. */
export const unblockBy = (by: TaskChangeBy, key: string): UnblockBy => ({ actorUserId: by.user_id, conversationId: by.conversation_id, key });

/**
 * Settle the waits of `task` that `settle` decides (undefined leaves a wait
 * as it is), then tell whoever works
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
  const { task: after, words } = await writeWaits(ctx, task, next, bySystem, now);
  if (isTerminalTaskStatus(after.status)) return after;
  // One event can fail several of a task's waits at once (a PR that closes
  // without merging fails both a merge wait and a checks wait on it), and the
  // task needs one new plan, not one per wait: the failed side is told in a
  // single comment and a single wake, as the met side is.
  const failed = settled.filter((w) => w.state === "failed");
  if (failed.length) await onWaitFailed(ctx, after, failed, words, now, by);
  if (!failed.length && (await isTaskUnblocked(ctx, after))) {
    // The full ref, as onWaitFailed's comment uses, so the met PR renders as a
    // live pill in the task's comment stream too.
    const met = settled.map((w) => waitMetCause(w, { ...words, fullRef: true })).join(", ");
    await onUnblocked(ctx, after, met, { ...by, key: `met:${settled.map((w) => w.id).join(",")}@${now}` });
  }
  return after;
}

type PrWait = Extract<TaskWait, PrWaitTarget>;

/** The note on a PR wait whose task left the PR's team. */
const UNREACHED = "belongs to a team the task left";

/** What a PR as it now stands makes of a wait on it. A checks wait whose PR
 *  merged or closed before going green can no longer clear. */
function prSettle(pr: PR, w: PrWait): Settle | undefined {
  if (w.kind === "pr_merged") {
    if (pr.state === "merged") return { state: "met", note: waitMetNote(w.kind) };
    return pr.state === "closed" ? { state: "failed", note: waitFailedWord(w.kind) } : undefined;
  }
  if (pr.checks_state === "success") return { state: "met", note: waitMetNote(w.kind) };
  return pr.state === "open" ? undefined : { state: "failed", note: waitFailedWord(w.kind, pr.state) };
}

/** The ids of `task`'s waiting waits on `pr`. The waits naming the PR's own
 *  repository, and only those when there are any. A wait naming the PR's
 *  number under a repository where no PR row is found any more is on it too,
 *  but only as a fallback: the repository was renamed or moved since the wait
 *  was set and the row followed, so the wait follows the row. Number alone is
 *  too weak to settle on while an exact match is in hand — a task holding
 *  `old-org/api#42`, whose row is gone, and `acme/web#42` would otherwise have
 *  the first marked "merged" by the second's merge. */
async function waitsOnPr(ctx: Ctx, pr: PR, task: Task): Promise<Set<string>> {
  const repository = normalizeRepository(pr.repository);
  const onNumber = (task.waits ?? []).filter((w): w is PrWait => w.state === "waiting" && isPrWaitTarget(w) && w.pr_number === pr.number);
  const exact = onNumber.filter((w) => normalizeRepository(w.repository) === repository);
  if (exact.length) return new Set(exact.map((w) => w.id));
  const out = new Set<string>();
  for (const w of onNumber) if (!(await prByNumber(ctx, w.repository, w.pr_number))) out.add(w.id);
  return out;
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
    const still: Id<"tasks">[] = [];
    for (const id of pr.waiting_task_ids) {
      let task = await ctx.db.get(id);
      const mine = task ? await waitsOnPr(ctx, pr, task) : new Set<string>();
      const onThis = (w: TaskWait): w is PrWait => w.state === "waiting" && mine.has(w.id);
      if (!task?.waits?.some(onThis)) continue;
      // A task moved out of the PR's reach since the wait was set never
      // hears from this PR again: a wait that cannot settle is a trap (TG2).
      const settle = (await prReachesTask(ctx, pr, task)) ? (w: PrWait) => prSettle(pr, w) : (): Settle => ({ state: "failed", note: UNREACHED });
      task = await settleWaits(ctx, task, (w) => (onThis(w) ? settle(w) : undefined));
      if (task.waits?.some(onThis)) still.push(id);
    }
    if (still.length !== pr.waiting_task_ids.length) await ctx.db.patch(pr._id, { waiting_task_ids: still });
  },
});

/** The tasks a decision's waits sit on, through its back reference. */
async function tasksWaitingOn(ctx: Ctx, row: Doc<"session_decisions">): Promise<Task[]> {
  const rows = await Promise.all((row.waiting_task_ids ?? []).map((id) => ctx.db.get(id)));
  return rows.filter((t): t is Task => !!t);
}

/** Which of a task's waits one decision's resolution decides: `on` names the
 *  decision at all (the back reference is kept for those), `hit` still waits,
 *  and `stale` was met before the row's latest resolution, so it holds an
 *  answer a person has since changed (an advisory override,
 *  settleClientResolution). */
function decisionWaits(row: Doc<"session_decisions">) {
  const on = (w: TaskWait) => w.kind === "decision" && w.decision === row.short_id;
  return {
    on,
    hit: (w: TaskWait) => w.state === "waiting" && on(w),
    stale: (w: TaskWait) => w.state === "met" && on(w) && (w.settled_at ?? 0) < (row.resolved_at ?? 0),
  };
}

/** The session an answer reaches another way: delivered to its asker as a
 *  message of its own (deliverAnswer, or the web client's send), which wakes
 *  it, so a session that parked on its own question is not woken twice. A
 *  silent card, a run's gate and an answer with no words deliver nothing
 *  there. */
function answerTold(row: Doc<"session_decisions">, verdict: Verdict): Id<"conversations"> | undefined {
  const answered = verdict.status === "answered";
  return answered && !row.silent && !row.workflow_run_id && !!answerLabel(row, verdict) ? row.conversation_id : undefined;
}

/** One task's waits on a decision settle: answered meets them, dismissed or
 *  withdrawn fails them, and an answer changed since the wait was met is
 *  restated. `by` is who resolved it, told nothing of their own act. */
async function settleTaskWaitsOn(ctx: Ctx, row: Doc<"session_decisions">, verdict: Verdict, task: Task, by: Omit<UnblockBy, "key">): Promise<void> {
  const { hit, stale } = decisionWaits(row);
  const answered = verdict.status === "answered";
  const told = answerTold(row, verdict);
  if (answered && task.waits?.some(stale)) task = await restateAnswer(ctx, task, row, verdict, stale, [by.conversationId, told]);
  if (!task.waits?.some(hit)) return;
  const settle: Settle = answered
    ? { state: "met", note: await answeredNote(ctx, row, verdict, task) }
    : { state: "failed", note: waitFailedWord("decision", verdict.status) };
  await settleWaits(ctx, task, (w) => (hit(w) ? settle : undefined), { ...by, told });
}

/**
 * Every waiting task of a decision settled in THIS transaction. Only the
 * session purge uses it (sessionDelete): the decision row goes with the
 * session, so there is no row left for a job of its own to read, and a task
 * whose wait it fails would otherwise wait on something gone. Every other
 * resolution goes through `scheduleDecisionSettle`, which gives each task its
 * own job and prunes the back reference, because this walk writes a waits
 * patch, history rows, a comment, a notification and an owner wake for each
 * task in one transaction.
 */
export async function settleTaskWaits(ctx: Ctx, row: Doc<"session_decisions">, verdict: Verdict, by: Omit<UnblockBy, "key"> = {}): Promise<void> {
  if (!row.short_id) return;
  for (const task of await tasksWaitingOn(ctx, row)) await settleTaskWaitsOn(ctx, row, verdict, task, by);
}

/** A person changed the answer that met `task`'s wait: the wait carries the
 *  new answer, and the task and its owner hear of the change. */
async function restateAnswer(
  ctx: Ctx,
  task: Task,
  row: Doc<"session_decisions">,
  verdict: Verdict,
  stale: (w: TaskWait) => boolean,
  skip: readonly (Id<"conversations"> | undefined)[],
): Promise<Task> {
  const now = Date.now();
  const note = await answeredNote(ctx, row, verdict, task);
  const changed = task.waits!.find(stale)!;
  const { task: after } = await writeWaits(ctx, task, task.waits!.map((w) => (stale(w) ? { ...w, note, settled_at: now } : w)), bySystem, now);
  if (isTerminalTaskStatus(after.status)) return after;
  await insertTaskComment(ctx, after._id, { author: SENDER, text: `${row.short_id} was answered again (${note}).`, comment_type: "note" });
  await wakeOwner(
    ctx,
    after,
    `restated:${changed.id}:${row.resolved_at}`,
    `${taskName(after)}: the answer to ${row.short_id} changed (${note}). Check that the work follows the new answer.`,
    skip,
  );
  return after;
}

/** A decision resolved (sessionDecisions.settleResolution, the org
 *  proposals' card withdraw): its waits settle in a job of their own, so a
 *  failure there never rolls back the answer. */
export async function scheduleDecisionSettle(
  // Only the scheduler, so the decision modules, which type their ctx
  // structurally, reach the one scheduler of a settle without `ctx as any`
  // erasing the check on a boundary that goes on to write task rows,
  // comments, notifications and session wakes.
  ctx: Pick<Ctx, "scheduler">,
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

/** Who the settle is by: the row when it names them (every answer and
 *  dismissal does), so a job from before a reopen settles as the latest
 *  answer's. A withdraw names nobody on the row, so its job carries the
 *  actor. */
const decisionSettleBy = (row: Doc<"session_decisions">, args: { actor_user_id?: Id<"users">; conversation_id?: Id<"conversations"> }) =>
  row.answered_by
    ? { actorUserId: row.resolved_by, conversationId: row.answered_by.via }
    : { actorUserId: args.actor_user_id, conversationId: args.conversation_id };

/**
 * The fan-out: it reads the decision as it stands, so a repeat settles the
 * same way and one reopened since settles nothing, and hands each waiting
 * task to a job of its own.
 *
 * One task's settle writes a waits patch, history rows, a comment, a
 * notification and an owner wake, so walking them all here would run a
 * decision's whole set in one transaction: a throw on any row, or the
 * per-mutation ceiling, would roll back every sibling's settle and leave only
 * the quarter-hourly sweep to recover them. That is the coupling
 * `settleOneOverdueTask` exists to undo, and this is the same shape — one
 * task per transaction, each reading the decision again, so a settle that
 * throws cannot strand its mates.
 *
 * It also prunes the back reference, which `writeWaits` only ever appends to:
 * an id whose task is gone, or which no longer holds a wait naming this
 * decision, can never be settled or reopened again, while a MET wait's id
 * stays, because a reopen has to find it (schema.ts session_decisions).
 * Without the prune every later resolution of a long-lived decision — an
 * advisory re-answer, reopen-then-answer — would re-read every task that ever
 * waited on it.
 */
export const settleDecision = internalMutation({
  args: { decision_id: v.id("session_decisions"), actor_user_id: v.optional(v.id("users")), conversation_id: v.optional(v.id("conversations")) },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.decision_id);
    const verdict = row && verdictOfRow(row);
    if (!row || !verdict || !row.short_id) return;
    const { on, hit, stale } = decisionWaits(row);
    const answered = verdict.status === "answered";
    const waiting = row.waiting_task_ids ?? [];
    const still: Id<"tasks">[] = [];
    let scheduled = 0;
    for (const id of waiting) {
      const task = await ctx.db.get(id);
      if (!task?.waits?.some(on)) continue;
      still.push(id);
      if (!task.waits.some(hit) && !(answered && task.waits.some(stale))) continue;
      scheduled++;
      await ctx.scheduler.runAfter(0, internal.taskWaits.settleDecisionTask, {
        decision_id: row._id,
        task_id: id,
        ...(args.actor_user_id ? { actor_user_id: args.actor_user_id } : {}),
        ...(args.conversation_id ? { conversation_id: args.conversation_id } : {}),
      });
    }
    if (still.length !== waiting.length) await ctx.db.patch(row._id, { waiting_task_ids: still });
    return { scheduled, pruned: waiting.length - still.length };
  },
});

/** One task's share of a decision's settle, in its own transaction
 *  (`settleDecision`). It re-reads both rows, so a decision reopened or a
 *  wait removed between the fan-out and this job settles nothing. */
export const settleDecisionTask = internalMutation({
  args: {
    decision_id: v.id("session_decisions"),
    task_id: v.id("tasks"),
    actor_user_id: v.optional(v.id("users")),
    conversation_id: v.optional(v.id("conversations")),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.decision_id);
    const verdict = row && verdictOfRow(row);
    if (!row || !verdict || !row.short_id) return;
    const task = await ctx.db.get(args.task_id);
    if (!task) return;
    await settleTaskWaitsOn(ctx, row, verdict, task, decisionSettleBy(row, args));
  },
});

/** The met waits one reopened decision takes back. */
const reopenableWaits = (row: Doc<"session_decisions">) => (w: TaskWait) =>
  w.state === "met" && w.kind === "decision" && w.decision === row.short_id;

/** A reopened decision (sessionDecisions.reopenCore): its met waits go back
 *  to waiting in jobs of their own, so a failure there never rolls back the
 *  reopen itself. The settle side is scheduled for that reason
 *  (scheduleDecisionSettle), and this side needs it more: the quarter-hourly
 *  sweep only settles waits and never puts a met one back, so a reopen rolled
 *  back by one task's throw would leave the decision pending with its waits
 *  still met and nothing to recover them. */
export async function scheduleDecisionReopen(
  // Only the scheduler, as scheduleDecisionSettle takes: the decision modules
  // type their ctx structurally and reach the reopen without `ctx as any`
  // erasing the check on a boundary that goes on to write task rows, comments
  // and session wakes.
  ctx: Pick<Ctx, "scheduler">,
  row: Doc<"session_decisions">,
): Promise<void> {
  if (!row.waiting_task_ids?.length) return;
  await ctx.scheduler.runAfter(0, internal.taskWaits.reopenDecision, { decision_id: row._id });
}

/** The reopen's fan-out, settleDecision's shape: it reads the decision as it
 *  stands, so one answered again since the reopen takes nothing back, and
 *  hands each task holding a met wait on it a job of its own. The back
 *  reference is not pruned here — a met wait's id is exactly what a reopen
 *  needs to find, and the settle path prunes what nothing can settle again. */
export const reopenDecision = internalMutation({
  args: { decision_id: v.id("session_decisions") },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.decision_id);
    if (!row?.short_id || row.status !== "pending") return;
    const hit = reopenableWaits(row);
    let scheduled = 0;
    for (const id of row.waiting_task_ids ?? []) {
      const task = await ctx.db.get(id);
      if (!task?.waits?.some(hit)) continue;
      scheduled++;
      await ctx.scheduler.runAfter(0, internal.taskWaits.reopenDecisionTask, { decision_id: row._id, task_id: id });
    }
    return { scheduled };
  },
});

/** One task's share of a reopen, in its own transaction (`reopenDecision`).
 *  It re-reads both rows, so a decision answered again or a wait removed
 *  between the fan-out and this job takes nothing back. */
export const reopenDecisionTask = internalMutation({
  args: { decision_id: v.id("session_decisions"), task_id: v.id("tasks") },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.decision_id);
    if (!row?.short_id || row.status !== "pending") return;
    const task = await ctx.db.get(args.task_id);
    if (task) await reopenTaskWait(ctx, row, task);
  },
});

/** One task's met waits on `row` go back to waiting, and the task and its
 *  owner hear that the answer no longer stands. */
async function reopenTaskWait(ctx: Ctx, row: Doc<"session_decisions">, task: Task): Promise<void> {
  const hit = reopenableWaits(row);
  const reopened = task.waits?.find(hit);
  if (!reopened) return;
  const next = task.waits!.map((w) => {
    if (!hit(w)) return w;
    const { settled_at: _s, note: _n, ...rest } = w;
    return { ...rest, state: "waiting" as const };
  });
  const { task: after } = await writeWaits(ctx, task, next, bySystem);
  if (isTerminalTaskStatus(after.status)) return;
  await insertTaskComment(ctx, after._id, { author: SENDER, text: `Waiting again: ${row.short_id} was reopened, so its answer no longer stands.`, comment_type: "note" });
  await wakeOwner(
    ctx,
    after,
    `reopened:${reopened.id}:${reopened.settled_at}`,
    `${taskName(after)} waits on ${row.short_id} again: the decision was reopened, so its earlier answer no longer stands. Hold any work that depends on it until it is answered again.`,
  );
}

/** A time wait's job. It settles only a wait that still exists, still waits
 *  and still names this time, so removing a wait needs no cancellation. */
export const settleTimeWait = internalMutation({
  args: { task_id: v.id("tasks"), wait_id: v.string(), at: v.number() },
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.task_id);
    if (!task) return;
    const hit = (w: TaskWait) => w.id === args.wait_id && w.kind === "time" && w.at === args.at && w.state === "waiting";
    await settleWaits(ctx, task, (w) => (hit(w) ? { state: "met", note: waitMetNote("time") } : undefined));
  },
});

/**
 * What the state of a still-waiting wait's own target makes of it now. This is
 * the settle the dedicated jobs run, reached from the target rather than from
 * an event: `prSettle` against the PR row as it stands (the same read
 * `settlePr` makes), the decision's current verdict (the same read
 * `settleDecision` makes), and the clock for a time wait. A target that cannot
 * be read lends no verdict, and a PR whose events no longer reach the task is
 * left to `settlePr` on its next move rather than failed here, so the sweep
 * invents no outcome of its own.
 */
async function overdueSettle(ctx: Ctx, task: Task, w: TaskWait, now: number): Promise<Settle | undefined> {
  if (isPrWaitTarget(w)) {
    const pr = await prByNumber(ctx, w.repository, w.pr_number);
    return pr && (await prReachesTask(ctx, pr, task)) ? prSettle(pr, w) : undefined;
  }
  if (w.kind === "decision") {
    const row = await decisionByShortId(ctx, w.decision);
    const verdict = row && verdictOfRow(row);
    if (!row || !verdict) return undefined;
    return verdict.status === "answered"
      ? { state: "met", note: await answeredNote(ctx, row, verdict, task) }
      : { state: "failed", note: waitFailedWord("decision", verdict.status) };
  }
  return w.kind === "time" && w.at <= now ? { state: "met", note: waitMetNote("time") } : undefined;
}

/**
 * The recovery for a wait whose settle never completed. Every kind settles
 * from exactly one scheduled job — `settleTimeWait` at the moment addWaitCore
 * queues, `settlePr` on a PR's state or checks move, `settleDecision` on a
 * decision resolving — and Convex does not retry a scheduled mutation that
 * threw. The settle commits the waits patch, the history rows, the task
 * comment, the notification and the owner's wake in one transaction, so a
 * throw anywhere downstream rolls the whole settle back. Nothing then looks at
 * the wait again: a resolved decision has no later resolution to settle from,
 * and a merged PR makes no further move for patchPullRequest to schedule on.
 * The wait stays `waiting` for good, holding the task and every dependent of
 * it on something no event can clear — TG2's rule is that a wait which cannot
 * settle is a trap.
 *
 * So the sweep walks the tasks that still hold a wait its own target could
 * have settled and hands each to `settleOneOverdueTask`, which reads that
 * target and settles the wait the way its job would (`overdueSettle`). That is idempotent by
 * construction: it sees only waits that still wait, and a target it cannot
 * read or that has not moved yet lends no verdict, so a run where every job
 * did fire writes nothing. `tasks.by_waiting_since` is sparse — writeWaits
 * keeps the field set exactly while a wait is open — so a page holds tasks
 * with open waits and nothing else.
 */
export const settleOverdueWaits = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, { cursor }) => {
    const now = Date.now();
    const page = await ctx.db
      .query("tasks")
      .withIndex("by_waiting_since", (q) => q.gt("waiting_since", 0))
      .paginate({ cursor: cursor ?? null, numItems: 200 });
    // The sweep only READS: one mutation per task does the settling, and the
    // cursor is handed on whatever any of them makes of its row. A settle
    // reads its own targets (the PR row, the decision, the task's
    // repositories and sessions) and writes the waits patch, the history, a
    // comment, a notification and the owner's wake, so a page of them in one
    // transaction would run at Convex's per-mutation ceiling and let one
    // poisoned row roll back every task on the page AND the hand-on with it —
    // the coupling this recovery exists to undo, at page scale.
    //
    // A wait on a moment still to come is the one case the page can decide for
    // itself, so the usual task — parked on a time days out — costs no job.
    //
    // A closed task holds nothing (blockersHoldingBack), so an unsettled wait
    // left on it is history and settling it would write a patch, a history row
    // and a `[met]` entry nothing reads. It keeps its `waiting_since` all the
    // same — the index entry has to survive, or a task reopened after its
    // scheduled settles have fired would never be swept again — so the filter
    // is what skips it, every pass, for no job.
    const due = page.page.filter(
      (t) => !isTerminalTaskStatus(t.status) && (t.waits ?? []).some((w) => w.state === "waiting" && (w.kind !== "time" || w.at <= now)),
    );
    for (const task of due) {
      await ctx.scheduler.runAfter(0, internal.taskWaits.settleOneOverdueTask, { task_id: task._id });
    }
    // The whole index in one pass, a page at a time: a cron carries no cursor
    // from one firing to the next, so the run hands its own cursor on.
    if (!page.isDone) await ctx.scheduler.runAfter(0, internal.taskWaits.settleOverdueWaits, { cursor: page.continueCursor });
    return { scheduled: due.length, done: page.isDone };
  },
});

/**
 * One task's overdue settle, each from its own targets and in its own
 * transaction (settleOverdueWaits). A decision's settle walks every task in
 * its `waiting_task_ids` in one transaction, so one bad row there strands all
 * of them; the recovery must not repeat that coupling, at any scale.
 *
 * It re-reads the row, so a wait that settled between the sweep's read and
 * this one no longer waits and lends no verdict, and a task whose waits were
 * removed in between settles nothing.
 */
export const settleOneOverdueTask = internalMutation({
  args: { task_id: v.id("tasks") },
  handler: async (ctx, { task_id }) => {
    const now = Date.now();
    const task = await ctx.db.get(task_id);
    if (!task) return { settled: 0 };
    const decided = new Map<string, Settle>();
    for (const w of task.waits ?? []) {
      if (w.state !== "waiting") continue;
      const s = await overdueSettle(ctx, task, w, now);
      if (s) decided.set(w.id, s);
    }
    if (!decided.size) return { settled: 0 };
    // A wait id is stable within its task, so the settle lands on the waits
    // these verdicts were read for.
    await settleWaits(ctx, task, (w) => (w.state === "waiting" ? decided.get(w.id) : undefined));
    return { settled: decided.size };
  },
});

/** A task closed (tasks.afterStatusMove, tasks.cascadeClose, an org
 *  proposal's or an issue sync's close): the tasks it blocked whose last open
 *  blocker it was are unblocked. They are found as redirectDependents finds
 *  them (dependentRefs), so a dependent missing from the blocks mirror is
 *  told too. `task` is the row before the move.
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
  if (!next || !isTerminalTaskStatus(next) || isTerminalTaskStatus(task.status)) return;
  const self = new Set([task.short_id, String(task._id)]);
  const known = new Map<string, { short_id?: string; status: string }>([...self].map((r) => [r, { short_id: task.short_id, status: next }]));
  if (later) for (const r of [later.short_id, String(later._id)]) if (r) known.set(r, { short_id: later.short_id, status: later.status });
  const workspace = workspaceForResource(task);
  for (const ref of new Set(await dependentRefs(ctx, task))) {
    const dep = await taskByRef(ctx, ref);
    if (!dep || isTerminalTaskStatus(dep.status) || closing?.has(String(dep._id)) || !isSameWorkspace(dep, workspace)) continue;
    if (!dep.blocked_by?.some((r) => self.has(r))) continue;
    if (await isTaskUnblocked(ctx, dep, (r) => known.get(r))) {
      await onUnblocked(ctx, dep, `${task.short_id} ${next}`, { ...by, key: `closed:${task.short_id}:${next}:${task.updated_at ?? 0}` });
    }
  }
}

/** A task a write may release: the row before it, the refs it loses, and
 *  those refs as the comment names them (short ids). */
export type PendingRelease = { task: Task; lost: string[]; named: string[] };

/**
 * A write that shrinks blocked_by or blocks (tasks.update's whole arrays,
 * removeDepCore's one edge, an edge cut across workspaces). Read before the
 * write, the tasks it may release: `task` when its blocked_by loses an entry,
 * and each task dropped from its blocks (whose blocked_by loses `task`
 * through the mirror). Only ones blocked now count. `tellReleased` reads them
 * again after the write.
 */
export async function pendingReleases(ctx: Ctx, task: Task, next: { blocked_by?: string[]; blocks?: string[] }): Promise<PendingRelease[]> {
  const out: PendingRelease[] = [];
  const lost = next.blocked_by ? (task.blocked_by ?? []).filter((r) => !next.blocked_by!.includes(r)) : [];
  // An older plan row names a blocker by its `_id`; the comment names it by short id.
  const named = await Promise.all(lost.map(async (r) => (ctx.db.normalizeId("tasks", r) ? (await taskByRef(ctx, r))?.short_id : undefined) ?? r));
  if (lost.length) out.push({ task, lost, named: [...new Set(named)] });
  for (const ref of next.blocks ? (task.blocks ?? []).filter((r) => !next.blocks!.includes(r)) : []) {
    const dep = await taskByRef(ctx, ref);
    if (dep && !isTerminalTaskStatus(dep.status)) out.push({ task: dep, lost: [task.short_id], named: [task.short_id] });
  }
  const blocked: PendingRelease[] = [];
  for (const r of out) if (!(await isTaskUnblocked(ctx, r.task))) blocked.push(r);
  return blocked;
}

/** Tell each `pendingReleases` task whose blocked_by the write shrank and
 *  that nothing holds back any more. */
export async function tellReleased(ctx: Ctx, pending: PendingRelease[], by: TaskChangeBy): Promise<void> {
  for (const { task, lost, named } of pending) {
    const after = await ctx.db.get(task._id);
    if (!after || isTerminalTaskStatus(after.status)) continue;
    // Released only when a ref it was blocked on is really gone: an overwrite
    // may swap an open blocker for a finished one without shrinking the list.
    const still = after.blocked_by ?? [];
    if (!lost.some((r) => !still.includes(r)) || !(await isTaskUnblocked(ctx, after))) continue;
    const one = named.length === 1;
    await onUnblocked(ctx, after, `the blocker${one ? "" : "s"} ${named.join(", ")} ${one ? "was" : "were"} removed`, unblockBy(by, `dep-removed:${named.join(", ")}@${after.updated_at}`));
  }
}

/** Nothing in blocked_by is open and every wait is met, reading blockers from
 *  the database. `override` answers for rows the caller knows better, and
 *  speaks for a ref only when it answers something: `undefined` (not looked
 *  up) falls through to the database, while `null` (looked up, gone) stands,
 *  as StatusOf defines them. */
export async function isTaskUnblocked(ctx: Ctx, task: Task, override?: StatusOf): Promise<boolean> {
  const { statusOf } = await taskLookups(ctx, task);
  const lookup: StatusOf = override
    ? (r) => {
      const known = override(r);
      return known === undefined ? statusOf(r) : known;
    }
    : statusOf;
  return isUnblocked(task, lookup);
}

// ---------------------------------------------------------------------------
// Telling the people and sessions doing the work
// ---------------------------------------------------------------------------

/** Wake the session that owns the task (lib/taskOwner) with `content`.
 *  `key` names the event, so a delivery of the same event is enqueued once.
 *  Returns false when no live session owns it, or when the owner refuses
 *  messages now (an ExecutionAuthorityError from the admission check, thrown
 *  before anything is written): the caller then tells a person instead, and
 *  the event that woke it still stands. Any other error is rethrown, since
 *  the message may already be queued. One of `skip` (the session that made the change, one told another
 *  way) owns it but is not woken. A machine wake, so it acknowledges no
 *  assignment ping. */
async function wakeOwner(ctx: Ctx, task: Task, key: string, content: string, skip: readonly (Id<"conversations"> | undefined)[] = []): Promise<boolean> {
  const owner = (await boundSessionsOf(ctx, task)).find((c) => !c.inbox_killed_at);
  if (!owner) return false;
  if (skip.some((s) => s && String(owner._id) === String(s))) return true;
  try {
    await enqueuePendingMessage(ctx, owner, owner.user_id, { content, origin: "scheduler", client_id: `task-wait:${task._id}:${key}` });
    return true;
  } catch (e) {
    if (!(e instanceof ExecutionAuthorityError)) throw e;
    console.warn(`[taskWaits] ${task.short_id}: could not wake ${owner._id}: ${e.message}`);
    return false;
  }
}

/** The task as a wake names it. Its title is foreign text in another
 *  session's prompt, so it stays one escaped line. */
const taskName = (task: Task) => `${task.short_id}${task.title ? ` ("${inlineForeignText(task.title).replace(/"/g, "'").slice(0, 80)}")` : ""}`;

/** The person to tell when no live session could be woken: the task's
 *  assignee, when the assignee names a user rather than an agent label
 *  ("agent:codex") or a bot. Null when there is nobody, or when the task is
 *  ephemeral bookkeeping, which rings nobody (TG9).
 *
 *  The task's own comment is not a substitute for this. A comment reaches
 *  people through taskThreadParticipants, and taskThreadMembership admits the
 *  assignee only on a human task or from an assignee row a human wrote, so on
 *  an agent-filed task whose assignee an agent set the comment reaches nobody
 *  at all. */
async function assigneeToTell(ctx: Ctx, task: Task): Promise<Doc<"users"> | null> {
  if (task.ephemeral || !task.assignee) return null;
  const assignee = ctx.db.normalizeId("users", task.assignee);
  const person = assignee ? await ctx.db.get(assignee) : null;
  return !person || person.is_bot ? null : person;
}

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
    [by.conversationId, by.told],
  );
  if (woke) return;
  const person = await assigneeToTell(ctx, task);
  if (!person) return;
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
    [by.conversationId],
  );
}

/** Waits that can no longer be met keep blocking; the task needs a new plan,
 *  so the task says so and its owner is woken. Every wait one event failed is
 *  told at once, keyed on the set, so the owner spends one turn on it and
 *  reads one message rather than a near-identical one per wait. */
async function onWaitFailed(ctx: Ctx, task: Task, failed: TaskWait[], words: WaitLabelOptions, now: number, by: Omit<UnblockBy, "key"> = {}): Promise<void> {
  // The full ref, so the comment renders each PR as a live pill.
  const what = failed.map((w) => waitFailedCause(w, { ...words, fullRef: true })).join(", ");
  const one = failed.length === 1;
  await insertTaskComment(ctx, task._id, {
    author: SENDER,
    text: `Still blocked: ${what}, so ${one ? "this wait" : "these waits"} can no longer clear.`,
    comment_type: "blocker",
  });
  const woke = await wakeOwner(
    ctx,
    task,
    `failed:${failed.map((w) => w.id).join(",")}@${now}`,
    `${taskName(task)} is still blocked: ${what}, so ${one ? "that wait" : "those waits"} can no longer clear. The task needs a new plan: ${failedWaitAdvice(task.short_id, failed)}`,
    [by.conversationId],
  );
  // The failure path needs a person more than any other wake does: the wait
  // keeps blocking, so the task is off `cast task ready` until somebody
  // re-plans it, and no later event can clear it. The other wakes here say
  // "hold work" about a state that still settles on its own, so they leave
  // the task's comment to carry them rather than ring a person's phone.
  if (woke) return;
  const person = await assigneeToTell(ctx, task);
  if (!person) return;
  await emitNotification(ctx, {
    event_type: "task_blocked",
    actor_name: SENDER,
    // Whoever dismissed or withdrew it rings no bell of their own (TG2), the
    // same rule onUnblocked's notification keeps.
    ...(by.actorUserId ? { actor_user_id: by.actorUserId } : {}),
    entity_type: "task",
    entity_id: String(task._id),
    message: `${task.short_id} is still blocked: ${what}, so ${one ? "that wait" : "those waits"} can no longer clear`,
    recipient_ids: [person._id],
  });
}
