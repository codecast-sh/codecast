// The server side of the task graph (docs/architecture/task-graph.md). The
// rules are graph.ts's; this module only reads what they need from the
// database. Nothing here infers a task's state from its absence in a page: a
// page that already dropped finished tasks must still see that a blocker
// finished, and a page filtered by project must still see that a parent is
// being worked.

import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import {
  blockerRefs,
  blockersHoldingBack,
  dependencyLoopChecker,
  isTerminalTaskStatus,
  parentStatusLookup,
  readinessOf,
  statusLookup,
  type DepNode,
  type GraphRefStatus,
  type ReadinessOptions,
} from "@codecast/shared/tasks";
import { canAccessTask, isSameWorkspace, requireSameWorkspace, workspaceForResource, type AuthorizedWorkspace } from "./access";
import { notFound } from "./auth";

type ReadCtx = Pick<QueryCtx, "db">;

/** The task a `blocked_by` ref names: a short id, or the `_id` a plan's older
 *  rows used. Null when it names nothing. */
export async function taskByRef(ctx: ReadCtx, ref: string): Promise<Doc<"tasks"> | null> {
  const id = ctx.db.normalizeId("tasks", ref);
  if (id) return await ctx.db.get(id);
  return await ctx.db.query("tasks").withIndex("by_short_id", (q) => q.eq("short_id", ref)).first();
}

/** The task `ref` names when `userId` may read it, else not found, naming
 *  the ref: a write naming several tasks says which one is wrong. */
export async function requireTaskByRef(ctx: ReadCtx, userId: Id<"users">, ref: string): Promise<Doc<"tasks">> {
  const t = await taskByRef(ctx, ref.trim());
  if (!t || !(await canAccessTask(ctx, userId, t))) notFound(`Task ${ref.trim()} not found`);
  return t!;
}

/**
 * The refs of the tasks that may wait on `task`: its `blocks` mirror, then any
 * task of its plan whose blocked_by names it. Rows written without the mirror
 * (an edge named before its blocker existed, older plan rows naming it by
 * `_id`) are found that way. A caller checks each one's blocked_by, since a
 * mirror entry can be stale.
 */
export async function dependentRefs(ctx: ReadCtx, task: Doc<"tasks">): Promise<string[]> {
  const refs = [...(task.blocks ?? [])];
  if (!task.plan_id) return refs;
  const self = new Set([task.short_id, String(task._id)]);
  const mates = await ctx.db.query("tasks").withIndex("by_plan_id", (q) => q.eq("plan_id", task.plan_id)).collect();
  for (const t of mates) {
    if (refs.includes(t.short_id) || refs.includes(String(t._id))) continue;
    if ((t.blocked_by ?? []).some((r) => self.has(r))) refs.push(t.short_id);
  }
  return refs;
}

// ---------------------------------------------------------------------------
// Readiness (TG1)
// ---------------------------------------------------------------------------

/**
 * The tasks `page`'s blockers and parents name outside it, read in parallel,
 * and the refs that were really looked up (statusLookup's `searched`). A row
 * is kept only for a task in its own workspace: a ref into another workspace
 * stays unknown and blocks, so readiness never reports whether a task the
 * caller may not read has finished.
 */
export async function graphOutside(ctx: ReadCtx, page: Doc<"tasks">[]): Promise<{ tasks: Doc<"tasks">[]; searched: string[] }> {
  const held = statusLookup(page);
  const referrers = new Map<string, Doc<"tasks">[]>();
  for (const t of page) {
    for (const ref of [...(t.blocked_by ?? []), ...(t.parent_id ? [String(t.parent_id)] : [])]) {
      if (held(ref) === undefined) referrers.set(ref, [...(referrers.get(ref) ?? []), t]);
    }
  }
  return await readInWorkspace(ctx, referrers);
}

/** How many `blocks` and how many `related` tasks one task page reads. Its
 *  blockers are read whole: readiness needs every one. */
const GRAPH_LINK_CAP = 50;

/**
 * The tasks one task's graph names (TG5, TG12): its blockers, what it
 * blocks, related, found during and superseded by, under `graphOutside`'s
 * workspace rule, so a task page shows each one's live state and title even
 * when the client's list never held it (a long finished blocker). `missing`
 * is the refs that name no task, so the page reports them as not found (TG1)
 * rather than unknown; a ref into another workspace is in neither list.
 * The workspace rule is not a read check: a caller shipping these rows to a
 * viewer filters them by canAccessTask.
 */
export async function graphNeighbors(ctx: ReadCtx, task: Doc<"tasks">): Promise<{ tasks: Doc<"tasks">[]; missing: string[] }> {
  const refs = [
    ...(task.blocked_by ?? []),
    ...(task.blocks ?? []).slice(0, GRAPH_LINK_CAP),
    ...(task.related ?? []).slice(0, GRAPH_LINK_CAP),
    task.found_during,
    task.superseded_by,
  ];
  const referrers = new Map<string, Doc<"tasks">[]>();
  for (const ref of refs) if (ref && ref !== task.short_id && ref !== String(task._id)) referrers.set(ref, [task]);
  const { tasks, missing } = await readInWorkspace(ctx, referrers);
  return { tasks, missing };
}

/** Read each ref, keeping a row only in one of its referrers' workspaces.
 *  `searched` is the refs answered (found here or missing); `missing` the
 *  ones that named nothing. */
async function readInWorkspace(
  ctx: ReadCtx,
  referrers: Map<string, Doc<"tasks">[]>,
): Promise<{ tasks: Doc<"tasks">[]; searched: string[]; missing: string[] }> {
  const refs = [...referrers.keys()];
  const rows = await Promise.all(refs.map((ref) => taskByRef(ctx, ref)));
  const tasks: Doc<"tasks">[] = [];
  const searched: string[] = [];
  const missing: string[] = [];
  refs.forEach((ref, i) => {
    const row = rows[i];
    if (!row) {
      searched.push(ref);
      missing.push(ref);
    } else if (referrers.get(ref)!.some((d) => isSameWorkspace(row, workspaceForResource(d)))) {
      tasks.push(row);
      searched.push(ref);
    }
  });
  return { tasks, searched, missing };
}

/** The lookups `readinessOf` takes for `page`. Parents resolve through
 *  `statusOf` too, so `statusOf(parent_id)` is the parent row. */
export async function readinessLookups(ctx: ReadCtx, page: Doc<"tasks">[]) {
  const outside = await graphOutside(ctx, page);
  const statusOf = statusLookup([...page, ...outside.tasks], outside.searched);
  return { statusOf, parentStatusOf: parentStatusLookup(statusOf) };
}

/** What still holds one task back, as `tasks.list` attaches it to a row. */
export async function openBlockersOf(ctx: ReadCtx, task: Doc<"tasks">) {
  const { statusOf } = await readinessLookups(ctx, [task]);
  return blockersHoldingBack(task, statusOf);
}

/**
 * Stamp each row of a list page with `graph_status`, what its blockers and
 * parent are, read by `graphOutside`: a ref the page left out (a finished
 * blocker, an older parent) resolves from the database, and one into another
 * workspace is left off, so it stays unknown and blocks. The web board reads
 * it beneath the store's live rows (lib/taskBlockers), since the store does
 * not hold every task a blocker names (TG1). An array, not a record: a ref is
 * whatever `blocked_by` stored, and an object key must be plain ASCII.
 */
export async function stampGraphStatus(ctx: ReadCtx, page: (Doc<"tasks"> & { graph_status?: GraphRefStatus[] })[]): Promise<void> {
  const { statusOf } = await readinessLookups(ctx, page);
  for (const t of page) {
    const refs = [...new Set([...(t.blocked_by ?? []), ...(t.parent_id ? [String(t.parent_id)] : [])])];
    const known = refs.flatMap((ref): GraphRefStatus[] => {
      const found = statusOf(ref);
      if (found === undefined) return [];
      if (found === null) return [{ ref, status: null }];
      return [{ ref, short_id: found.short_id ?? undefined, status: found.status ?? null }];
    });
    if (refs.length) t.graph_status = known;
  }
}

/** The tasks of `page` that can be started now, with the lookups that decided it. */
export async function readyTasks<T extends Doc<"tasks">>(
  ctx: ReadCtx,
  page: T[],
  opts: Pick<ReadinessOptions, "viewer" | "viewerSession" | "includeSubtasks">,
) {
  const lookups = await readinessLookups(ctx, page);
  return { ready: page.filter((t) => readinessOf(t, { ...lookups, ...opts }).ready), lookups };
}

// ---------------------------------------------------------------------------
// Edges that cannot loop (TG4)
// ---------------------------------------------------------------------------

/** How many tasks one loop check reads at most. A real chain is a few dozen. */
const LOOP_WALK_CAP = 2000;

const depNode = (t: Doc<"tasks">, blocked_by = t.blocked_by): DepNode => ({ short_id: t.short_id, _id: String(t._id), blocked_by });

/**
 * Refuse a write that adds edges to `task` (addDep, create and update with
 * `blocked_by`/`blocks`) when one names a task in another workspace or would
 * close a loop. `task` carries its `blocked_by` as it will be after the write;
 * `added` names the new edges: blockers it now waits on and tasks that now
 * wait on it.
 *
 * A cross-workspace edge is refused because readiness never reads across
 * workspaces (`graphOutside`): the blocker would stay unknown and hold the
 * task forever. A ref that names nothing is allowed; it reads as missing.
 *
 * Every new edge touches `task`, so any loop it closes runs through what
 * `task` waits on, transitively: that is all the loop check reads, one level
 * at a time, among open tasks in `workspace` (a finished task holds nothing
 * back). A graph too large to walk whole is refused rather than half checked.
 */
export async function assertDependencyEdges(
  ctx: ReadCtx,
  task: DepNode,
  workspace: AuthorizedWorkspace,
  added: { blocked_by?: readonly string[]; blocks?: readonly string[] },
): Promise<void> {
  const newBlockers = added.blocked_by ?? [];
  const newDependents = added.blocks ?? [];
  if (!newBlockers.length && !newDependents.length) return;

  const named = await Promise.all([...newBlockers, ...newDependents].map((r) => taskByRef(ctx, r)));
  for (const t of named) if (t) requireSameWorkspace(t, workspace, "dependency task");

  const open = (t: Doc<"tasks"> | null): t is Doc<"tasks"> => !!t && !isTerminalTaskStatus(t.status) && isSameWorkspace(t, workspace);
  const nodes = new Map<string, DepNode>([[task.short_id, task]]);
  const looked = new Set<string>();
  for (;;) {
    const { shortIds, ids } = blockerRefs(nodes.values());
    const refs = [...shortIds, ...ids].filter((r) => !looked.has(r));
    if (!refs.length) break;
    if (nodes.size >= LOOP_WALK_CAP) {
      throw new Error(`Cannot check ${task.short_id}'s dependencies for a loop: more than ${LOOP_WALK_CAP} open tasks wait behind it.`);
    }
    for (const r of refs) looked.add(r);
    for (const t of await Promise.all(refs.map((r) => taskByRef(ctx, r)))) {
      if (open(t) && !nodes.has(t.short_id)) nodes.set(t.short_id, depNode(t));
    }
  }
  // Each new dependent now waits on `task`, whether or not the walk reached it.
  for (const d of named.slice(newBlockers.length)) {
    if (!open(d)) continue;
    const prior = nodes.get(d.short_id)?.blocked_by ?? d.blocked_by ?? [];
    nodes.set(d.short_id, depNode(d, [...prior, task.short_id]));
  }

  const loopError = dependencyLoopChecker(nodes.values());
  for (const blocker of newBlockers) {
    const err = loopError(task.short_id, blocker);
    if (err) throw new Error(err);
  }
  for (const dependent of newDependents) {
    const err = loopError(dependent, task.short_id);
    if (err) throw new Error(err);
  }
}
