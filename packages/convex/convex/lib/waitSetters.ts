// Telling the sessions that set a task's waits (`created_in`) while holding
// another task: parking such a session on the wait it set, and waking it when
// its wait is met, fails, is removed, or its task closes. taskWaits.ts calls
// in here; nothing here calls back into it.

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../functions";
import { enqueuePendingMessage } from "../pendingMessages";
import { ExecutionAuthorityError } from "../executionBindings";
import { bySystem, type TaskChangeBy } from "./taskHistory";
import { taskLookups } from "./taskGraph";
import { boundSessionsOf } from "./taskOwner";
import { holdsTask } from "./taskHolder";
import { PARKED_ON_CAP } from "./parkedWake";
import { STORED, storedWords, writeWaits } from "./waitWrite";
import {
  blockersHoldingBack,
  isTerminalTaskStatus,
  WAIT_PENDING_WORD,
  waitClause,
  waitSubject,
  type Blocker,
  type TaskWait,
  type WaitLabelOptions,
} from "@codecast/shared/tasks";
import { inlineForeignText } from "@codecast/shared/contracts";
import { rowPinPredatesTurn } from "@codecast/shared/contracts/inboxPlacement";

type Ctx = MutationCtx;
type Task = Doc<"tasks">;

/** "held": the caller is not the wait's setter, but its held task lists this
 *  task in blocked_by, so its own blocker stamp parks it and its held task
 *  unblocking wakes that task's owning session; the wait tells it nothing.
 *  `owns` (with "close"): the caller is its held task's owning session, so
 *  that wake reaches it (ownerOf). */
export type ParkAnswer = { parked?: boolean | "close" | "held"; owns?: boolean };

/** Sessions a wake passes over: the one that made the change, one told another way. */
export type Skip = readonly (Id<"conversations"> | undefined)[];

export const ownerOf = async (ctx: Ctx, task: Task) => (await boundSessionsOf(ctx, task)).find((c) => holdsTask(c, task._id));

export async function wakeSession(ctx: Ctx, task: Task, conv: Doc<"conversations">, key: string, content: string): Promise<boolean> {
  try {
    await enqueuePendingMessage(ctx, conv, conv.user_id, { content, origin: "scheduler", client_id: `task-wait:${task._id}:${key}` });
    return true;
  } catch (e) {
    if (!(e instanceof ExecutionAuthorityError)) throw e;
    console.warn(`[taskWaits] ${task.short_id}: could not wake ${conv._id}: ${e.message}`);
    return false;
  }
}

/** `parked` for a caller that is not the wait's setter (another session set
 *  it, or a replaced wait's owed setter kept it): "held" when the caller's
 *  held task lists `task` in blocked_by, since its own blocker stamp parks it
 *  (the wait, set by another, tells it nothing); false otherwise, and once
 *  the wait can no longer wake anyone (`settled`). */
export async function heldWaitsAnswer(ctx: Ctx, by: TaskChangeBy | undefined, task: Task, settled: boolean): Promise<ParkAnswer> {
  if (settled || !by?.conversation_id) return { parked: false };
  const conv = await ctx.db.get(by.conversation_id);
  return { parked: conv && (await heldStillWaiting(ctx, conv, task)) ? "held" : false };
}

/** Add the task its wait is on to the parked session's list
 *  (conversations.parked_on_task_ids, newest last, capped), so its
 *  parked_wake_kind counts that wait (lib/parkedWake.ts). Answers the add's
 *  `parked`: "close" when the session's held task waits on this task closing. */
export async function parkOn(ctx: Ctx, convId: Id<"conversations">, task: Task): Promise<ParkAnswer> {
  const conv = await ctx.db.get(convId);
  if (!conv) return { parked: true };
  const was = conv.parked_on_task_ids ?? [];
  if (String(was[was.length - 1] ?? "") !== String(task._id)) {
    const next = [...was.filter((id) => String(id) !== String(task._id)), task._id].slice(-PARKED_ON_CAP);
    await ctx.db.patch(convId, { parked_on_task_ids: next });
  }
  const h = await heldFacts(ctx, conv, task);
  return h?.stillWaits ? { parked: "close", owns: h.owns } : { parked: true };
}

/** The session parked on a wait `by` sets on `task`: the caller's own session
 *  holding another task, which nothing else wakes when the wait settles. One
 *  holding this task hears as its owner; one holding none is wiring the graph. */
export async function parkingSession(ctx: Ctx, userId: Id<"users">, task: Task, by: TaskChangeBy): Promise<Id<"conversations"> | undefined> {
  const conv = by.conversation_id ? await ctx.db.get(by.conversation_id) : null;
  if (!conv || String(conv.user_id) !== String(userId) || !conv.active_task_id || reviewsHeld(conv)) return undefined;
  return String(conv.active_task_id) === String(task._id) ? undefined : conv._id;
}

/** A session reviewing the task it holds: it holds it to review, not to do,
 *  so like a planner it parks on no wait. */
const reviewsHeld = (conv: Doc<"conversations">) => !!conv.active_task_id && String(conv.review_of_task_id ?? "") === String(conv.active_task_id);

/** What a setter is told, or null to pass it over. */
type Said = { key: string; content: string } | null;

/** Wake each live session that set some of `waits` (`created_in`) and is
 *  not one of `skip`, with what `say` makes of its own waits (null passes it
 *  over). A setter whose done pin answers its latest turn declared its work
 *  delivered, so it is not parked on them and is passed over. Same
 *  refusals as taskWaits.wakeOwner, and `key` keeps one event to one message per
 *  session. */
async function wakeSetters(
  ctx: Ctx,
  task: Task,
  waits: readonly TaskWait[],
  skip: Skip,
  say: (mine: TaskWait[], conv: Doc<"conversations">) => Promise<Said> | Said,
): Promise<void> {
  const passed = new Set(skip.filter(Boolean).map(String));
  const bySetter = new Map<string, TaskWait[]>();
  for (const w of waits) if (w.created_in && !passed.has(w.created_in)) bySetter.set(w.created_in, [...(bySetter.get(w.created_in) ?? []), w]);
  for (const [id, mine] of bySetter) {
    const convId = ctx.db.normalizeId("conversations", id);
    const conv = convId ? await ctx.db.get(convId) : null;
    // A done pin fresh for the latest turn (rowPinPredatesTurn) is work
    // delivered, not a park; an older one answered an earlier turn.
    if (!conv || conv.inbox_killed_at || (conv.thread_state_status === "done" && !rowPinPredatesTurn(conv))) continue;
    const said = await say(mine, conv);
    if (!said) continue;
    const { key, content } = said;
    await wakeSession(ctx, task, conv, key, content);
  }
}

const clauses = (waits: readonly TaskWait[], words: WaitLabelOptions) => waits.map((w) => waitClause(w, words)).join(", ");

/** A wait whose setter has yet to be dealt with: waiting, or met and not
 *  stamped (`setter_told_at`). */
export const setterOwed = (w: TaskWait) => !!w.created_in && (w.state === "waiting" || (w.state === "met" && !w.setter_told_at));

/** Waits someone removed (removeWaitCore), and who removed them. */
export type Removed = { waits: readonly TaskWait[]; who: string };

/**
 * Tell the sessions that set `task`'s waits, one message per session.
 * `unblocked`, the cause of an unblock: each met wait whose setter was not yet
 * dealt with is told, then stamped (`setter_told_at`) so no later unblock
 * tells it again, so a wait met while something else still blocked the task
 * is told by whichever change cleared the last blocker. `removed`: each
 * setter of a removed wait it was owed is told the wait is gone, whether or
 * not the task is still blocked. A setter in both hears one message. A
 * setter whose held task still waits on this one closing is told what still
 * holds that task and what it can do (heldWaitsLine). The owner of a task now
 * unblocked and `skip` hear another way.
 */
export async function tellSetters(ctx: Ctx, task: Task, skip: Skip, { unblocked, removed }: { unblocked?: string; removed?: Removed }): Promise<void> {
  const row = await ctx.db.get(task._id);
  if (!row) return;
  const met = unblocked === undefined ? [] : (row.waits ?? []).filter((w) => w.state === "met" && setterOwed(w));
  const gone = (removed?.waits ?? []).filter(setterOwed);
  if (!met.length && !gone.length) return;
  const words = await storedWords(ctx, row, [...(row.waits ?? []), ...gone]);
  const ownerConv = await ownerOf(ctx, row);
  const owner = unblocked === undefined ? undefined : ownerConv?._id;
  const name = taskName(row);
  await wakeSetters(ctx, row, [...met, ...gone], [...skip, owner], async (mine, conv) => {
    const m = mine.filter((w) => met.includes(w));
    const r = mine.filter((w) => gone.includes(w));
    const key = [m.length ? `met:${m.map((w) => w.id).join(",")}` : "", r.length ? `removed:${r.map((w) => w.id).join(",")}` : ""].filter(Boolean).join(";");
    // The setter's own held task still lists this one in blocked_by: its work
    // waits for this task to close, which nothing may do (a PR merged outside
    // a flow closes no task), so it is always told, with what still holds
    // its task and what it can do about that.
    const h = await heldFacts(ctx, conv, row);
    if (!m.length) {
      const state = unblocked === undefined ? `${row.short_id} is still blocked` : "Nothing it waits on is open any more";
      return { key, content: `${removed?.who} removed the wait ${clauses(r, words)} you set on ${name}, so it will not wake you.${h?.stillWaits ? ` ${heldWaitsLine(h, row, ownerConv, "removed")}` : ` ${state}. Check whether the work that waited on it can go ahead, and replan it if not.`}` };
    }
    const next = h?.stillWaits ? ` ${heldWaitsLine(h, row, ownerConv, "met")}` : h?.others.length ? ` ${heldBlockedLine(h)}` : null;
    if (!r.length) return { key, content: `${name} is unblocked: ${unblocked}.${next ?? ` You set the wait ${clauses(m, words)} on it, so continue the work that waited on it.`}` };
    return { key, content: `${name} is unblocked: ${unblocked}. You set the wait ${clauses(m, words)} on it, which was met, and the wait ${clauses(r, words)}, which ${removed?.who} removed.${next ?? " Check whether the work that waited on them can go ahead, and continue it or replan it."}` };
  });
  if (!met.length) return;
  const now = Date.now();
  await writeWaits(ctx, row, row.waits!.map((w) => (met.includes(w) ? { ...w, setter_told_at: now } : w)), bySystem, now);
}

/** The open task a setter holds, by short id, else null. */
async function heldBy(ctx: Ctx, conv: Doc<"conversations">): Promise<Task | null> {
  const held = conv.active_task_id && !reviewsHeld(conv) ? await ctx.db.get(conv.active_task_id) : null;
  return held && !isTerminalTaskStatus(held.status) ? held : null;
}

/** What a setter's own held task still waits on, for `task`'s setter texts.
 *  `stillWaits`: it lists `task` in blocked_by. `others`: every other open
 *  blocker holding it back, as "ct-9 to close", "PR #42 to merge". `owns`:
 *  the setter is the held task's owning session (ownerOf), so its unblocking
 *  wakes this setter; otherwise it wakes the session holding it. */
type HeldFacts = { held: string; stillWaits: boolean; others: string[]; owns: boolean; owner?: string };
async function heldFacts(ctx: Ctx, conv: Doc<"conversations">, task: Task): Promise<HeldFacts | null> {
  const held = await heldBy(ctx, conv);
  if (!held) return null;
  const isTask = (ref: string) => ref === task.short_id || ref === String(task._id);
  const stillWaits = !!held.blocked_by?.some(isTask);
  let others: string[] = [];
  if (held.blocked_by?.length || held.waits?.some((w) => w.state === "waiting")) {
    const { statusOf } = await taskLookups(ctx, held);
    others = blockersHoldingBack(held, statusOf).filter((b) => !(b.kind === "task" && isTask(b.ref))).map(waitsForClause);
  }
  const owner = await ownerOf(ctx, held);
  const owns = String(owner?._id ?? "") === String(conv._id);
  return { held: held.short_id, stillWaits, others, owns, owner: owner?.short_id };
}

/** "ct-9 to close", "PR #42 to merge", "sd-4 to be answered": what "still
 *  waits for" a blocker reads as. */
function waitsForClause(b: Blocker): string {
  if (b.kind === "task") return `${b.ref} to close`;
  if (b.kind === "pr_checks_green") return `green checks on ${waitSubject(b, STORED)}`;
  if (b.kind === "time") return waitSubject(b, STORED);
  return `${waitSubject(b, STORED)} ${WAIT_PENDING_WORD[b.kind]}`;
}

const andList = (xs: string[]) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

/** Who is woken when the held task unblocks: this setter only when it is the
 *  held task's owning session. */
const woken = (h: HeldFacts) =>
  h.owns ? `you are woken as ${h.held}'s owner when ${h.held} is unblocked` : `${h.held}'s owning session${h.owner ? ` (${h.owner})` : ""} is woken when it is unblocked`;

/** What a setter whose held task still waits on `task` closing can do, by
 *  whether `task` has an owning session. With one, that owner is told at the
 *  same moment to continue (or replan), so the setter asks it rather than
 *  closing the task itself. With none, nobody is told and nothing may close
 *  it: the setter closes a finished task, or pins blocked so a person moves it. */
function heldWaitsLine(h: HeldFacts, task: Task, owner: Doc<"conversations"> | undefined, event: "met" | "failed" | "removed"): string {
  const t = task.short_id;
  if (!owner) return `${h.held} still waits for ${t} to close. Nobody holds ${t}. If its work is done, close it; otherwise pin blocked naming ${t}, since a person has to move it.`;
  const who = owner.short_id ? `session ${owner.short_id}` : `${t}'s owner`;
  if (event === "failed") return `${h.held} still waits for ${t} to close, so replan with ${who}, or drop the dependency.`;
  if (event === "removed") return `${h.held} still waits for ${t} to close; ${woken(h)}. Pin dormant naming ${t} and end your turn.`;
  return `${h.held} still waits for ${t} to close: ask ${who} to close ${t} when its work is done; ${woken(h)}. Pin dormant naming ${t} and end your turn.`;
}

/** What a setter whose held task is held back by other open blockers does:
 *  stay parked on them. */
const heldBlockedLine = (h: HeldFacts) =>
  `${h.held} still waits for ${andList(h.others)}; ${woken(h)}. Pin dormant naming ${h.others.length === 1 ? "it" : "them"} and end your turn.`;

/** The setter's held task when it still lists `task` in blocked_by: it waits
 *  on `task` closing, not on the wait the setter set. */
async function heldStillWaiting(ctx: Ctx, conv: Doc<"conversations">, task: Task): Promise<string | null> {
  const held = await heldBy(ctx, conv);
  return held?.blocked_by?.some((ref) => ref === task.short_id || ref === String(task._id)) ? held.short_id : null;
}

/** `task` closed with waits still owed to the sessions that set them: each is
 *  told once that its wait will not wake it, and the waits are stamped
 *  (`setter_told_at`). The session that closed it hears nothing, nor does a
 *  setter whose held task waits on this one: the close releases that task,
 *  which wakes the setter as its owner (releaseDependents, the same call). */
export async function tellSettersClosed(ctx: Ctx, task: Task, status: string, closedBy: Id<"conversations"> | undefined): Promise<void> {
  const row = await ctx.db.get(task._id);
  const owed = (row?.waits ?? []).filter((w) => setterOwed(w) && !w.setter_told_at);
  if (!row || !owed.length) return;
  await wakeSetters(ctx, row, owed, [closedBy], async (mine, conv) => {
    if (await heldStillWaiting(ctx, conv, row)) return null;
    const waits = mine.length === 1 ? "wait" : "waits";
    return {
      key: `closed:${status}:${mine.map((w) => w.id).join(",")}`,
      content: status === "done"
        ? `${taskName(row)} was closed as done; the ${waits} you set on it will not wake you. Check whether your work can go ahead.`
        : `${taskName(row)} was closed (${status}); the ${waits} you set on it will not wake you. Replan your own work.`,
    };
  });
  const now = Date.now();
  await writeWaits(ctx, row, row.waits!.map((w) => (owed.includes(w) ? { ...w, setter_told_at: now } : w)), bySystem, now);
}

/** The task as a wake names it. Its title is foreign text in another
 *  session's prompt, so it stays one escaped line. */
export const taskName = (task: Task) => `${task.short_id}${task.title ? ` ("${inlineForeignText(task.title).replace(/"/g, "'").slice(0, 80)}")` : ""}`;

/** Waits on `task` that can no longer be met (`what` names why): each
 *  session that set some of them, whose work waited on them, is told once. */
export async function tellSettersFailed(ctx: Ctx, task: Task, failed: TaskWait[], what: (w: TaskWait) => string, skip: Skip): Promise<void> {
  // A setter of several hears of them in one message. The task's blockers are
  // its owner's to edit (onWaitsFailed told it), so the setter replans its own work. A
  // setter whose held task waits on this one closing is told too, what it
  // can do by whether the task has an owner (heldWaitsLine). Setters of met waits are not told: the owner is told to
  // replace the failed wait, so the task may still unblock, and a wait
  // stamp's lifetime bounds one that never does.
  const taskOwner = await ownerOf(ctx, task);
  await wakeSetters(ctx, task, failed, [...skip, taskOwner?._id], async (mine, conv) => {
    const h = await heldFacts(ctx, conv, task);
    // A replan, never also a pin-dormant order: the work that waited on this
    // wait has to change. What else holds its task is said, not acted on.
    const replan = h?.others.length ? "Replan the work that waited on it" : `Replan your own work${h ? ` (${h.held})` : ""}`;
    const theirs = taskOwner ? `, and leave ${task.short_id}'s blockers to its owner.` : `. Nobody holds ${task.short_id}, so no one else will replan it.`;
    const next = h?.stillWaits
      ? heldWaitsLine(h, task, taskOwner, "failed")
      : `${replan}${theirs}${h?.others.length ? ` ${h.held} also still waits for ${andList(h.others)}.` : ""}`;
    return {
      key: `failed:${mine.map((w) => `${w.id}:${w.settled_at}`).join(",")}`,
      content: `${taskName(task)} is still blocked: ${mine.map(what).join("; ")}, so the ${mine.length === 1 ? "wait" : "waits"} you set on it can no longer clear. ${next}`,
    };
  });
}
