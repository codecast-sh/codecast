// The server side of the task graph (docs/architecture/task-graph.md). The
// rules are graph.ts's; this module only reads what they need from the
// database. Nothing here infers a task's state from its absence in a page: a
// page that already dropped finished tasks must still see that a blocker
// finished, and a page filtered by project must still see that a parent is
// being worked.

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import {
  blockerRefs,
  blockersHoldingBack,
  dependencyLoopChecker,
  frontierOrder,
  GRAPH_LINK_CAP,
  isTerminalTaskStatus,
  parentStatusLookup,
  parseBlockerRef,
  readinessOf,
  statusLookup,
  type DepNode,
  type GraphRefStatus,
  type NotReadyReason,
  type ReadinessOptions,
  type StatusOf,
} from "@codecast/shared/tasks";
import { canAccessTask, isSameWorkspace, requireSameWorkspace, workspaceForResource, type AuthorizedWorkspace } from "./access";
import { notFound } from "./auth";
import { recordTaskChange, type TaskChangeBy } from "./taskHistory";

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

type Lookups = Pick<ReadinessOptions, "statusOf" | "parentStatusOf">;

/**
 * The lookups `readinessOf` takes for each task of `page`, by task. A row in
 * another workspace than the task naming it reads as unknown to that task
 * even when the page holds it (a page can mix workspaces: the web's team
 * view, a role's view), so every reader judges an edge alike. Parents resolve
 * through `statusOf` too, so `statusOf(parent_id)` is the parent row.
 */
export async function readinessLookups(ctx: ReadCtx, page: Doc<"tasks">[]): Promise<(task: Doc<"tasks">) => Lookups> {
  const outside = await graphOutside(ctx, page);
  const held = statusLookup([...page, ...outside.tasks], outside.searched);
  return (task) => {
    const workspace = workspaceForResource(task);
    const statusOf: StatusOf = (ref) => {
      const row = held(ref) as Doc<"tasks"> | null | undefined;
      return row && !isSameWorkspace(row, workspace) ? undefined : row;
    };
    return { statusOf, parentStatusOf: parentStatusLookup(statusOf) };
  };
}

/** `readinessLookups` for one task. */
export async function taskLookups(ctx: ReadCtx, task: Doc<"tasks">): Promise<Lookups> {
  return (await readinessLookups(ctx, [task]))(task);
}

/** What still holds one task back, as `tasks.list` attaches it to a row. */
export async function openBlockersOf(ctx: ReadCtx, task: Doc<"tasks">) {
  return blockersHoldingBack(task, (await taskLookups(ctx, task)).statusOf);
}

/**
 * Stamp each row of a list page with `graph_status`, what its blockers and
 * parent are, read by `graphOutside`: a ref the page left out (a finished
 * blocker, an older parent) resolves from the database, and one into another
 * workspace than the row's is left off, even when the page holds it, so it
 * stays unknown and blocks. The web board reads it beneath the store's live
 * rows (lib/taskBlockers), since the store does not hold every task a blocker
 * names (TG1). An array, not a record: a ref is whatever `blocked_by` stored,
 * and an object key must be plain ASCII.
 */
export async function stampGraphStatus(ctx: ReadCtx, page: (Doc<"tasks"> & { graph_status?: GraphRefStatus[] })[]): Promise<void> {
  const lookupsFor = await readinessLookups(ctx, page);
  for (const t of page) {
    const { statusOf } = lookupsFor(t);
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

/**
 * Why an open task is off the ready list when its blockers do not say
 * (`cast task show` and `context`): its parent is being worked or could not
 * be read, or it is not triaged. Null when it is ready, blocked (its Blocked
 * by lines say why), not open, or superseded (shown at the top). Readiness
 * for an ephemeral task depends on who asks, so it is judged as if it were
 * not one; the reader says whose it is.
 */
export async function offFrontierReason(ctx: ReadCtx, task: Doc<"tasks">): Promise<NotReadyReason | null> {
  if (task.status !== "open") return null;
  const r = readinessOf({ ...task, ephemeral: false }, { ...(await taskLookups(ctx, task)), viewer: null });
  return r.ready || r.reason === "blocked" || r.reason === "superseded" ? null : r.reason;
}

/** The tasks of `page` that can be started now, with the lookups that decided it. */
export async function readyTasks<T extends Doc<"tasks">>(
  ctx: ReadCtx,
  page: T[],
  opts: Pick<ReadinessOptions, "viewer" | "viewerSession" | "includeSubtasks">,
) {
  const lookupsFor = await readinessLookups(ctx, page);
  return { ready: page.filter((t) => readinessOf(t, { ...lookupsFor(t), ...opts }).ready), lookupsFor };
}

/** `tasks` in frontier order (TG7, shared frontierOrder): live before stale,
 *  priority, plan order, oldest. Reads the plans that order needs. */
export async function orderFrontier<T extends Doc<"tasks">>(ctx: ReadCtx, tasks: T[], now: number): Promise<T[]> {
  const planIds = [...new Set(tasks.flatMap((t) => (t.plan_id ? [t.plan_id] : [])))];
  const plans = await Promise.all(planIds.map((id) => ctx.db.get(id)));
  const position = new Map<string, number>();
  for (const plan of plans) (plan?.task_ids ?? []).forEach((id, i) => position.set(String(id), i));
  return frontierOrder(tasks, { now, planPosition: (t) => position.get(String(t._id)) });
}

// ---------------------------------------------------------------------------
// Edges as a write stores them (TG3)
// ---------------------------------------------------------------------------

/**
 * The refs of a blocked_by or blocks list, sorted by what they name. A tasks
 * `_id` (a plan's older rows name blockers that way) stays as is; any other
 * task ref becomes its canonical short id (ct-012 is ct-12), deduped. This
 * matters because a stored ref that names no task reads as missing, which
 * blocks nothing: "CT-12" or "#42" stored raw would leave the task ready.
 * `waits` holds the wait-shaped refs (#42, sd-4, 2h), `refused` the
 * grammar's error for each ref that is neither.
 */
export function sortGraphRefs(ctx: ReadCtx, refs: readonly string[]): { tasks: string[]; waits: string[]; refused: string[] } {
  const tasks = new Set<string>();
  const waits: string[] = [];
  const refused: string[] = [];
  for (const raw of refs) {
    const ref = raw.trim();
    if (ctx.db.normalizeId("tasks", ref)) {
      tasks.add(ref);
      continue;
    }
    const parsed = parseBlockerRef(ref);
    if (!parsed.ok) refused.push(parsed.error);
    else if (parsed.kind === "task") tasks.add(parsed.ref);
    else waits.push(ref);
  }
  return { tasks: [...tasks], waits, refused };
}

/**
 * The blocked_by and blocks a create or update stores (sortGraphRefs), for
 * the fields `args` names. A create passes `waits`: a wait-shaped blocked_by
 * ref joins its waits (addWaitsAtCreate), as an older CLI still sends one.
 * Any other ref that is not a task is refused with the grammar's error.
 */
export function storedGraphRefs(
  ctx: ReadCtx,
  args: { short_id?: string; blocked_by?: string[]; blocks?: string[]; waits?: string[] },
  opts: { waits?: boolean } = {},
): { blocked_by?: string[]; blocks?: string[]; waits?: string[] } {
  const out: { blocked_by?: string[]; blocks?: string[]; waits?: string[] } = {};
  for (const field of ["blocked_by", "blocks"] as const) {
    if (!args[field]) continue;
    const { tasks, waits, refused } = sortGraphRefs(ctx, args[field]);
    if (refused.length) throw new Error(refused[0]);
    if (waits.length && (field === "blocks" || !opts.waits)) {
      throw new Error(field === "blocks"
        ? `"${waits[0]}" is not a task: blocks names the tasks that wait on this one (ct-12)`
        : `"${waits[0]}" is a wait, not a task: add it with cast task dep ${args.short_id ?? "<task>"} --blocked-by "${waits[0]}"`);
    }
    out[field] = tasks;
    if (waits.length) out.waits = [...(args.waits ?? []), ...waits];
  }
  return out;
}

/**
 * The one writer of a task's edges: set its blocked_by or blocks to `next`
 * and stamp updated_at. A blocked_by change is the task's own history (TG11);
 * blocks only mirrors other rows' blocked_by and records none. `task` is the
 * row as read before the write; a `next` it already holds writes nothing.
 */
export async function writeEdges(
  ctx: Pick<MutationCtx, "db">,
  task: Pick<Doc<"tasks">, "_id" | "blocked_by" | "blocks">,
  field: "blocked_by" | "blocks",
  next: string[],
  by: TaskChangeBy,
  now = Date.now(),
): Promise<void> {
  const prev = task[field] ?? [];
  if (sameRefs(prev, next)) return;
  await ctx.db.patch(task._id, { [field]: next, updated_at: now });
  if (field === "blocked_by") await recordTaskChange(ctx, task._id, by, [["blocked_by", prev, next]], now);
}

const sameRefs = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((r, i) => r === b[i]);

/** The link fields and what each one holds, for `writeLink`. */
type LinkFields = { related: string[]; found_during: string | undefined; superseded_by: string | undefined };

/**
 * The one writer of a task's links that do not block (TG5): set `related`, or
 * set or clear `found_during` or `superseded_by`, stamp updated_at and record
 * the change (TG11). `task` is the row as read before the write; a `next` it
 * already holds writes nothing, so a caller passes what it wants stored
 * rather than checking first.
 */
export async function writeLink<F extends keyof LinkFields>(
  ctx: Pick<MutationCtx, "db">,
  task: Pick<Doc<"tasks">, "_id" | "related" | "found_during" | "superseded_by">,
  field: F,
  next: LinkFields[F],
  by: TaskChangeBy,
  now = Date.now(),
): Promise<void> {
  const prev = task[field];
  const same = field === "related"
    ? sameRefs((prev as string[]) ?? [], (next as string[]) ?? [])
    : (prev ?? "") === (next ?? "");
  if (same) return;
  await ctx.db.patch(task._id, { [field]: next, updated_at: now });
  await recordTaskChange(ctx, task._id, by, [[field, prev, next]], now);
}

// ---------------------------------------------------------------------------
// Edges that cannot loop (TG4)
// ---------------------------------------------------------------------------

/** How many tasks one loop check reads at most. A real chain is a few dozen. */
const LOOP_WALK_CAP = 2000;

const depNode = (t: Doc<"tasks">, blocked_by = t.blocked_by): DepNode => ({ short_id: t.short_id, _id: String(t._id), blocked_by });

/** Whether a task is an open task in `workspace`: the only kind a loop runs through. */
const openIn = (workspace: AuthorizedWorkspace) => (t: Doc<"tasks"> | null): t is Doc<"tasks"> =>
  !!t && !isTerminalTaskStatus(t.status) && isSameWorkspace(t, workspace);

/** `start` and every open task in `workspace` it waits on, transitively,
 *  keyed by short id, read one level at a time. A graph too large to walk
 *  whole is refused rather than half checked. */
async function walkUpstream(ctx: ReadCtx, start: DepNode, workspace: AuthorizedWorkspace): Promise<Map<string, DepNode>> {
  const open = openIn(workspace);
  const nodes = new Map<string, DepNode>([[start.short_id, start]]);
  const looked = new Set<string>();
  for (;;) {
    const refs = blockerRefs(nodes.values()).filter((r) => !looked.has(r));
    if (!refs.length) return nodes;
    if (nodes.size >= LOOP_WALK_CAP) {
      throw new Error(`Cannot check ${start.short_id}'s dependencies for a loop: more than ${LOOP_WALK_CAP} open tasks wait behind it.`);
    }
    for (const r of refs) looked.add(r);
    for (const t of await Promise.all(refs.map((r) => taskByRef(ctx, r)))) {
      if (open(t) && !nodes.has(t.short_id)) nodes.set(t.short_id, depNode(t));
    }
  }
}

/** The short ids of the open tasks `task` waits on, transitively, itself not
 *  among them; none when `task` is finished. A new edge "d waits on `task`"
 *  closes a loop exactly when d is one of them, so a write moving many
 *  dependents onto one task walks once and asks assertDependencyEdges only
 *  for the error of one that loops. */
export async function openUpstream(ctx: ReadCtx, task: Doc<"tasks">, workspace: AuthorizedWorkspace): Promise<Set<string>> {
  if (!openIn(workspace)(task)) return new Set();
  const nodes = await walkUpstream(ctx, depNode(task), workspace);
  nodes.delete(task.short_id);
  return new Set(nodes.keys());
}

/**
 * The stored blockers of `task` whose edge is part of a loop, each with the
 * error naming the path, judged among the open tasks of `workspace`. An edge
 * is checked when it is written (assertDependencyEdges), but only against
 * open tasks: an edge through a done or dropped task holds nothing back, so
 * it is accepted, and the moment that task leaves a terminal status the loop
 * is live and holds every task in it for good. Every loop through `task` runs
 * through one of its own `blocked_by` edges, so the edges named here break all
 * of them when they are cut (taskLinks cutReopenedLoops). A graph too large to
 * walk whole (walkUpstream's cap) names none: nothing can be proved about
 * those edges, and a reopen is not a write that may fail.
 */
export async function loopedBlockers(
  ctx: ReadCtx,
  task: Doc<"tasks">,
  workspace: AuthorizedWorkspace,
): Promise<{ ref: string; error: string }[]> {
  const refs = task.blocked_by ?? [];
  if (!refs.length || !openIn(workspace)(task)) return [];
  let nodes: Map<string, DepNode>;
  try {
    nodes = await walkUpstream(ctx, depNode(task), workspace);
  } catch {
    return [];
  }
  const loopError = dependencyLoopChecker(nodes.values());
  return refs.flatMap((ref) => {
    const error = loopError(task.short_id, ref);
    return error ? [{ ref, error }] : [];
  });
}

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

  const open = openIn(workspace);
  const nodes = await walkUpstream(ctx, task, workspace);
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
