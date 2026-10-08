// The server side of the task graph (docs/architecture/task-graph.md). The
// rules are graph.ts's; this module only reads what they need from the
// database. Nothing here infers a task's state from its absence in a page: a
// page that already dropped finished tasks must still see that a blocker
// finished, and a page filtered by project must still see that a parent is
// being worked.

import type { Doc } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import {
  blockerRefs,
  dependencyLoopError,
  isTerminalTaskStatus,
  parentStatusLookup,
  readinessOf,
  statusLookup,
  type DepNode,
  type ReadinessOptions,
} from "@codecast/shared/tasks";
import { isSameWorkspace, workspaceForResource, type AuthorizedWorkspace } from "./access";

type ReadCtx = Pick<QueryCtx, "db">;

/** The task a `blocked_by` ref names: a short id, or the `_id` a plan's older
 *  rows used. Null when it names nothing. */
export async function taskByRef(ctx: ReadCtx, ref: string): Promise<Doc<"tasks"> | null> {
  const id = ctx.db.normalizeId("tasks", ref);
  if (id) return await ctx.db.get(id);
  return await ctx.db.query("tasks").withIndex("by_short_id", (q) => q.eq("short_id", ref)).first();
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
  const refs = [...referrers.keys()];
  const rows = await Promise.all(refs.map((ref) => taskByRef(ctx, ref)));
  const tasks: Doc<"tasks">[] = [];
  const searched: string[] = [];
  refs.forEach((ref, i) => {
    const row = rows[i];
    if (!row) searched.push(ref);
    else if (referrers.get(ref)!.some((d) => isSameWorkspace(row, workspaceForResource(d)))) {
      tasks.push(row);
      searched.push(ref);
    }
  });
  return { tasks, searched };
}

/** The lookups `readinessOf` takes for `page`. Parents resolve through
 *  `statusOf` too, so `statusOf(parent_id)` is the parent row. */
export async function readinessLookups(ctx: ReadCtx, page: Doc<"tasks">[]) {
  const outside = await graphOutside(ctx, page);
  const statusOf = statusLookup([...page, ...outside.tasks], outside.searched);
  return { statusOf, parentStatusOf: parentStatusLookup(statusOf) };
}

/** The tasks of `page` that can be started now, with the lookups that decided it. */
export async function readyTasks<T extends Doc<"tasks">>(
  ctx: ReadCtx,
  page: T[],
  opts: Pick<ReadinessOptions, "viewer" | "includeSubtasks">,
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
 * Refuse a write that adds edges to `task` when one would close a loop, with
 * graph.ts's error naming the path. `task` carries its `blocked_by` as it will
 * be after the write; `added` names the new edges: blockers it now waits on
 * and tasks that now wait on it. Every new edge touches `task`, so any loop it
 * closes runs through what `task` waits on, transitively: that is all this
 * reads, one level at a time, among open tasks in `workspace` (an edge never
 * crosses workspaces, and a finished task holds nothing back).
 */
export async function assertNoDependencyLoop(
  ctx: ReadCtx,
  task: DepNode,
  workspace: AuthorizedWorkspace,
  added: { blocked_by?: readonly string[]; blocks?: readonly string[] },
): Promise<void> {
  const newBlockers = added.blocked_by ?? [];
  const newDependents = added.blocks ?? [];
  if (!newBlockers.length && !newDependents.length) return;

  const open = (t: Doc<"tasks"> | null): t is Doc<"tasks"> => !!t && !isTerminalTaskStatus(t.status) && isSameWorkspace(t, workspace);
  const nodes = new Map<string, DepNode>([[task.short_id, task]]);
  const looked = new Set<string>();
  while (nodes.size < LOOP_WALK_CAP) {
    const { shortIds, ids } = blockerRefs(nodes.values());
    const refs = [...shortIds, ...ids].filter((r) => !looked.has(r));
    if (!refs.length) break;
    for (const r of refs) looked.add(r);
    for (const t of await Promise.all(refs.map((r) => taskByRef(ctx, r)))) {
      if (open(t) && !nodes.has(t.short_id)) nodes.set(t.short_id, depNode(t));
    }
  }
  // Each new dependent now waits on `task`, whether or not the walk reached it.
  for (const ref of newDependents) {
    const d = await taskByRef(ctx, ref);
    if (!open(d)) continue;
    const prior = nodes.get(d.short_id)?.blocked_by ?? d.blocked_by ?? [];
    nodes.set(d.short_id, depNode(d, [...prior, task.short_id]));
  }

  const graph = [...nodes.values()];
  for (const blocker of newBlockers) {
    const err = dependencyLoopError(graph, task.short_id, blocker);
    if (err) throw new Error(err);
  }
  for (const dependent of newDependents) {
    const err = dependencyLoopError(graph, dependent, task.short_id);
    if (err) throw new Error(err);
  }
}
