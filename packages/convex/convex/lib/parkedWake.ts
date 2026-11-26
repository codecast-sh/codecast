// conversations.parked_wake_kind: the wake a parked session has that the
// server can see, so the inbox classifier counts it as verified with no read
// (shared/contracts/inboxProjection.ts). "blocker": its active task is held by
// an open task in its blocked_by, exact because every task write recomputes
// it. "run": a live routine run the session spawned, on its own machine.
// "wait": only waits stand, a waiting wait on its active task (a failed wait
// never clears, so it wakes nothing) or a wait it set on another task
// (parked_on_task_ids) that still owes it a wake; a wait rests on a
// webhook or a job that can be lost, so the classifier trusts it for 72h.
// Blocker beats run beats wait.
// Kept true by makeParkedWakeDb, which every wrapped mutation's db passes
// through (functions.ts): a write to a run, to a task's blockers, waits or
// closure, or to a session's binding recomputes the sessions it can change.

import type { Doc, Id } from "../_generated/dataModel";
import { blockersHoldingBack, isTerminalTaskStatus, type TaskWait } from "@codecast/shared/tasks";
import { taskByRef, taskLookups } from "./taskGraph";
import { holdsTask } from "./taskHolder";

export type ParkedWakeKind = "none" | "run" | "blocker" | "wait";

// LE1.4: a run that has not ended. Defined here, a leaf functions.ts can
// import, and re-exported by workflow_runs.ts for its callers.
export const LIVE_RUN_STATUSES = ["pending", "running", "paused"] as const;
const RUNS_PER_STATUS = 50;

type Conv = Pick<Doc<"conversations">, "_id" | "active_task_id" | "review_of_task_id" | "parked_on_task_ids" | "owner_device_id"> & { parked_wake_kind?: ParkedWakeKind };

/** How many tasks a session's waits elsewhere are remembered on, newest last. */
export const PARKED_ON_CAP = 10;

/** A live run parks its spawner when it is any routine run the spawner started,
 *  whatever task it ships (a lead shipping a builder's task holds none, or
 *  another), and not waiting on the spawner. That is safe because the run's end
 *  is itself the wake: a status change restamps its spawner (runChanged below),
 *  so the session comes back whether or not the end message reached it. A
 *  paused run waits at a gate on a person, so it parks only while that gate's
 *  card is out (gate_decision_id): with none, nobody sees it. A run counts only
 *  on the spawner's own machine (runner_device unset, or the session's
 *  owner_device_id): the classifier trusts a run only while the spawner's
 *  daemon reports, and a run placed on another machine (`cast flow run
 *  --device`, a cloud host) can die there unseen, so the spawner falls back to
 *  the 2h claim window. */
export function runParksSpawner(run: Doc<"workflow_runs">, conv: Conv): boolean {
  if (run.run_kind === "workflow") return false;
  if (run.runner_device && run.runner_device !== conv.owner_device_id) return false;
  if (run.status === "paused" && !run.gate_decision_id) return false;
  return run.waiting_on_session?.conversation_id !== String(conv._id);
}

/** A blocker task whose `blocks` mirror lacks the dependent, and the mirror it should have. */
type MirrorRepair = { id: Id<"tasks">; blocks: string[] };

/** A wait `conv` set will still wake it (taskWaits.setterOwed): waiting, or
 *  met while the task is still blocked and its setter not yet told. */
export const waitOwesSetter = (w: TaskWait, convId: string): boolean =>
  w.created_in === convId && (w.state === "waiting" || (w.state === "met" && !w.setter_told_at));

/**
 * What should wake `conv` now, read from its runs, its active task, and the
 * tasks it set waits on (parked_on_task_ids). `parkedOn` is that list kept to
 * the tasks whose waits still owe this session a wake. A task blocker that parks it is
 * returned in `repairs` when its `blocks` mirror lacks the held task (an edge
 * named before the blocker existed gets none, tasks.patchDepMirror), because
 * the blocker closing finds the sessions to recompute through that mirror. A
 * session reviewing the task it holds gets no blocker from it: owner wakes
 * pass reviewers over (lib/taskOwner.boundSessionsOf), so nothing would come.
 */
export async function parkedWakeOf(ctx: { db: any }, conv: Conv): Promise<{ kind: ParkedWakeKind; repairs: MirrorRepair[]; parkedOn: Id<"tasks">[] }> {
  const parkedOn: Id<"tasks">[] = [];
  for (const id of conv.parked_on_task_ids ?? []) {
    const task: Doc<"tasks"> | null = await ctx.db.get(id);
    if (task && !isTerminalTaskStatus(task.status) && task.waits?.some((w) => waitOwesSetter(w, String(conv._id)))) parkedOn.push(id);
  }
  const reviewing = !!conv.active_task_id && String(conv.review_of_task_id ?? "") === String(conv.active_task_id);
  const held = conv.active_task_id && !reviewing ? await heldTaskBlocker(ctx, conv.active_task_id) : null;
  if (held?.kind === "blocker") return { kind: "blocker", repairs: held.repairs, parkedOn };
  for (const status of LIVE_RUN_STATUSES) {
    const runs: Doc<"workflow_runs">[] = await ctx.db
      .query("workflow_runs")
      .withIndex("by_spawner_status", (q: any) => q.eq("spawner_conversation_id", conv._id).eq("status", status))
      .take(RUNS_PER_STATUS);
    if (runs.some((r) => runParksSpawner(r, conv))) return { kind: "run", repairs: held?.repairs ?? [], parkedOn };
  }
  return { kind: held || parkedOn.length ? "wait" : "none", repairs: held?.repairs ?? [], parkedOn };
}

/** What parks the held task's session: "blocker" (an open task in its
 *  blocked_by that a session holds, with the mirror repairs it rests on) or
 *  "wait" (only waiting waits, or open task blockers nobody holds), else null.
 *  A blocker task nobody holds is closed by nothing but a person or a webhook
 *  that can be lost (jx7cn1s's ct-99107), so it gets the wait's lifetime
 *  rather than the exact stamp. A later binding of it does not restamp the
 *  dependents, so the stamp can lag there; that errs toward surfacing. */
async function heldTaskBlocker(ctx: { db: any }, taskId: Id<"tasks">): Promise<{ kind: "blocker" | "wait"; repairs: MirrorRepair[] } | null> {
  const task: Doc<"tasks"> | null = await ctx.db.get(taskId);
  if (!task || isTerminalTaskStatus(task.status)) return null;
  const waiting = !!task.waits?.some((w) => w.state === "waiting");
  if (!task.blocked_by?.length) return waiting ? { kind: "wait", repairs: [] } : null;
  const { statusOf } = await taskLookups(ctx, task);
  const open = blockersHoldingBack(task, statusOf).filter((b) => b.kind === "task");
  if (!open.length) return waiting ? { kind: "wait", repairs: [] } : null;
  const repairs: MirrorRepair[] = [];
  for (const b of open) {
    const row = statusOf(b.ref) as Doc<"tasks"> | null | undefined;
    if (!row?._id || repairs.some((r) => r.id === row._id)) continue;
    const blocks = row.blocks ?? [];
    if (!blocks.some((r) => r === task.short_id || r === String(task._id))) repairs.push({ id: row._id, blocks: [...blocks, task.short_id] });
  }
  for (const b of open) {
    const row = statusOf(b.ref) as Doc<"tasks"> | null | undefined;
    if (row?._id && (await isTaskHeld(ctx, row._id))) return { kind: "blocker", repairs };
  }
  return { kind: "wait", repairs };
}

/** A session holds the task, by the one rule the owner wake uses too
 *  (lib/taskHolder.holdsTask: bound, not killed, not only reviewing; a
 *  completed session counts, since a wake resumes it), read over the
 *  by_active_task index. The wrapper restamps the dependents when a holder is
 *  killed, moves off the task or turns to review it (holderLeft). */
async function isTaskHeld(ctx: { db: any }, taskId: Id<"tasks">): Promise<boolean> {
  const bound: Doc<"conversations">[] = await ctx.db
    .query("conversations")
    .withIndex("by_active_task", (q: any) => q.eq("active_task_id", taskId))
    .take(BOUND_CAP);
  return bound.some((c) => holdsTask(c, taskId));
}

/**
 * Recompute `conv`'s stamp, prune parked_on_task_ids to the tasks that still
 * owe it a wake, and repair the mirrors it rests on, writing through `writeDb`
 * (nothing when `dry`) and only what changed. Returns the new kind when it
 * changed.
 */
export async function stampParkedWake(ctx: { db: any }, writeDb: any, conv: Conv, dry = false): Promise<{ changed: ParkedWakeKind | null; repaired: number }> {
  const { kind, repairs, parkedOn } = await parkedWakeOf(ctx, conv);
  const changed = (conv.parked_wake_kind ?? "none") === kind ? null : kind;
  const pruned = parkedOn.length !== (conv.parked_on_task_ids ?? []).length;
  if (!dry) {
    for (const r of repairs) await writeDb.patch(r.id, { blocks: r.blocks });
    if (changed || pruned) {
      await writeDb.patch(conv._id, {
        ...(changed ? { parked_wake_kind: kind } : {}),
        ...(pruned ? { parked_on_task_ids: parkedOn.length ? parkedOn : undefined } : {}),
      });
    }
  }
  return { changed, repaired: repairs.length };
}

// Bound on the sessions holding one task (one, normally) that a write recomputes.
const BOUND_CAP = 20;

const RUN_FIELDS = ["status", "spawner_conversation_id", "waiting_on_session", "run_kind", "gate_decision_id", "runner_device"] as const;
const TASK_FIELDS = ["status", "blocked_by", "waits"] as const;
const CONV_FIELDS = ["active_task_id", "review_of_task_id", "parked_on_task_ids", "owner_device_id"] as const;
// What makes a session stop holding its task (holdsTask): leaving it, being
// killed, or turning to review it. Completing does not: a wake resumes it.
const HOLDER_FIELDS = ["active_task_id", "inbox_killed_at", "review_of_task_id"] as const;

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const runMoved = (a: any, b: any) => RUN_FIELDS.some((f) => !same(a?.[f], b?.[f]));
const closedFlipped = (a: any, b: any) => isTerminalTaskStatus(a?.status) !== isTerminalTaskStatus(b?.status);
const blockersMoved = (a: any, b: any) => !same(a?.blocked_by, b?.blocked_by) || !same(a?.waits, b?.waits);

/**
 * The db a mutation sees, with parked_wake_kind following the writes it
 * derives from. Reads go through the raw db; the stamp is written through
 * `db`, the layer beneath, so it rides the sync log and never re-enters here.
 * Runs are patched constantly (node_statuses, activity): only a patch naming
 * a field the fact reads costs a read, and only a real change recomputes.
 */
export function makeParkedWakeDb(db: any, rawDb: any): any {
  if (typeof rawDb?.normalizeId !== "function") return db;
  const is = (table: string, id: any) => !!rawDb.normalizeId(table, String(id));

  async function restamp(convs: Iterable<any>) {
    const seen = new Set<string>();
    for (const conv of convs) {
      if (!conv || seen.has(String(conv._id))) continue;
      seen.add(String(conv._id));
      await stampParkedWake({ db: rawDb }, db, conv);
    }
  }
  const restampIds = async (ids: (Id<"conversations"> | undefined)[]) =>
    restamp(await Promise.all(ids.filter(Boolean).map((id) => rawDb.get(id))));

  // Sessions whose active task is `taskId`. Review sessions included: the
  // fact is about any session's active task.
  const boundTo = (taskId: Id<"tasks">): Promise<any[]> =>
    rawDb.query("conversations").withIndex("by_active_task", (q: any) => q.eq("active_task_id", taskId)).order("desc").take(BOUND_CAP);

  async function runChanged(before: any, after: any) {
    if (!runMoved(before, after)) return;
    await restampIds([before?.spawner_conversation_id, after?.spawner_conversation_id]);
  }

  // A task's own sessions follow its blockers and its closing; the sessions
  // of the tasks it blocks follow its closing (ct-99107 done clears ct-99108's).
  // Dependents come from the `blocks` mirror alone: a stamp that rests on a
  // task blocker repairs that mirror (stampParkedWake), so no plan scan. The
  // sessions that set its waits (`created_in`, old and new) follow too, since
  // a session parked on a wait elsewhere rests on it (parked_on_task_ids).
  async function taskChanged(before: any, after: any) {
    const task = after ?? before;
    const closed = closedFlipped(before, after) || !after;
    if (!closed && !blockersMoved(before, after)) return;
    const convs = await boundTo(task._id);
    const setters = new Set([...(before?.waits ?? []), ...(after?.waits ?? [])].map((w: TaskWait) => w.created_in).filter(Boolean));
    for (const s of setters) {
      const id = rawDb.normalizeId("conversations", s);
      if (id) convs.push(await rawDb.get(id));
    }
    // Every dependent in `blocks`, uncapped, so none is left stamped. A close
    // can only take a "blocker" or "wait" stamp away (an unheld blocker task
    // stamps "wait"), so it recomputes only those (two index reads per
    // dependent otherwise); a reopen can add one anywhere.
    if (closed) {
      const reopened = !!after && !isTerminalTaskStatus(after.status);
      for (const ref of task.blocks ?? []) {
        const dependent = await taskByRef({ db: rawDb }, ref);
        if (!dependent) continue;
        for (const c of await boundTo(dependent._id)) if (reopened || c.parked_wake_kind === "blocker" || c.parked_wake_kind === "wait") convs.push(c);
      }
    }
    await restamp(convs);
  }

  // A session stopped holding a task (killed, moved off it, or reviewing
  // it): the tasks that task blocks may have lost their only live
  // holder's exactness, so their holders stamped "blocker" recompute (an
  // unheld blocker stamps "wait"). The same reach a close uses: the `blocks`
  // mirror, uncapped.
  async function holderLeft(taskId: Id<"tasks"> | undefined) {
    const task = taskId ? await rawDb.get(taskId) : null;
    if (!task?.blocks?.length) return;
    const convs: any[] = [];
    for (const ref of task.blocks) {
      const dependent = await taskByRef({ db: rawDb }, ref);
      if (dependent) for (const c of await boundTo(dependent._id)) if (c.parked_wake_kind === "blocker") convs.push(c);
    }
    await restamp(convs);
  }

  return {
    ...db,
    get: (...args: any[]) => db.get(...args),
    query: (...args: any[]) => db.query(...args),
    normalizeId: (...args: any[]) => db.normalizeId(...args),
    system: db.system,
    async insert(table: string, doc: any) {
      const id = await db.insert(table, doc);
      if (table === "workflow_runs") await runChanged(null, doc);
      else if (table === "conversations" && (doc?.active_task_id || doc?.parked_on_task_ids?.length)) await restampIds([id]);
      // A new task has no bound session yet. A dependent already naming its
      // short id is not found here (no index holds blocked_by refs).
      return id;
    },
    async patch(id: any, fields: any) {
      const runField = fields && RUN_FIELDS.some((f) => f in fields) && is("workflow_runs", id);
      const taskField = !runField && fields && TASK_FIELDS.some((f) => f in fields) && is("tasks", id);
      const convField = fields && (CONV_FIELDS.some((f) => f in fields) || HOLDER_FIELDS.some((f) => f in fields)) && is("conversations", id);
      const before = runField || taskField || convField ? await rawDb.get(id) : null;
      const res = await db.patch(id, fields);
      if (!before) return res;
      const after = { ...before, ...fields };
      if (runField) await runChanged(before, after);
      else if (taskField) await taskChanged(before, after);
      else {
        if (CONV_FIELDS.some((f) => !same(before[f], after[f]))) await restampIds([id]);
        if (!same(before.active_task_id, after.active_task_id)) await holderLeft(before.active_task_id);
        else if (HOLDER_FIELDS.some((f) => !same(before[f], after[f]))) await holderLeft(after.active_task_id);
      }
      return res;
    },
    async replace(id: any, doc: any) {
      const watched = is("workflow_runs", id) ? "run" : is("tasks", id) ? "task" : is("conversations", id) ? "conv" : null;
      const before = watched ? await rawDb.get(id) : null;
      const res = await db.replace(id, doc);
      if (watched === "run") await runChanged(before, doc);
      else if (watched === "task" && before) await taskChanged(before, { ...doc, _id: id });
      // A replace drops a stamp the new doc leaves out: recompute it outright.
      else if (watched === "conv") await restampIds([id]);
      return res;
    },
    async delete(id: any) {
      const watched = is("workflow_runs", id) ? "run" : is("tasks", id) ? "task" : null;
      const before = watched ? await rawDb.get(id) : null;
      const res = await db.delete(id);
      if (before && watched === "run") await runChanged(before, null);
      else if (before && watched === "task") await taskChanged(before, null);
      return res;
    },
  };
}
