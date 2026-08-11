/**
 * Task provenance and subtask nesting — the shared rules behind both the CLI
 * (`cast task ls`) and the web task views, so the two never drift.
 *
 * Two separate ideas live here, from the Aug 11 huddle:
 *
 *   ORIGIN (who filed the task) answers "is this human work, something people
 *   agreed to in a meeting, or an agent's own bookkeeping". The complaint that
 *   started this was that agent bookkeeping buries the first two.
 *
 *   NESTING (tasks.parent_id) answers "what larger piece of work is this part
 *   of", so an agent's execution steps sit under the goal they serve instead
 *   of competing with it in a flat list.
 */

// ---------------------------------------------------------------------------
// Origin
// ---------------------------------------------------------------------------

/**
 * Every value tasks.source may hold. `template` and `fork` come from
 * plans.instantiateTemplate / plans.fork; `insight` from taskMining;
 * `plan_mode` / `todo_sync` from the agent transcript importers.
 */
export type TaskSource =
  | "human"
  | "agent"
  | "meeting"
  | "insight"
  | "import"
  | "plan_mode"
  | "todo_sync"
  | "template"
  | "fork";

/**
 * The three origins a human actually cares to tell apart.
 *
 * - `human`   — a person filed it themselves (web UI, or `cast task create --human`).
 * - `meeting` — an agent transcribed it out of a meeting with people in it. The
 *   agent typed it, but a human decided it, so it belongs on the human board.
 * - `agent`   — an agent filed it for its own work. This is the noisy class:
 *   interstitial execution steps that are meaningful inside one session and
 *   noise everywhere else.
 *
 * Anything not explicitly human or meeting counts as agent, so a new source
 * literal is quiet by default and never leaks onto the human board untriaged.
 */
export type TaskOrigin = "human" | "meeting" | "agent";

export function taskOrigin(task: { source?: string | null }): TaskOrigin {
  if (task.source === "human") return "human";
  if (task.source === "meeting") return "meeting";
  return "agent";
}

/** Origins whose tasks a human is expected to read, ignoring any promotion flag. */
export function isHumanOrigin(task: { source?: string | null }): boolean {
  return taskOrigin(task) !== "agent";
}

/**
 * A task that exists as real work: not a mined suggestion awaiting triage and
 * not dismissed. This is the ONE activity predicate — the web board, mobile,
 * subtask counts, and progress all call it, so their numbers can never
 * disagree about which rows count.
 */
export function isActiveTask(t: {
  triage_status?: string | null;
  source?: string | null;
  promoted?: boolean | null;
}): boolean {
  if (t.triage_status === "suggested" || t.triage_status === "dismissed") return false;
  if (t.source === "insight" && !t.promoted) return false;
  return true;
}

/** A subtask worth counting on a parent row: active and not finished. */
export function isCountableSubtask(t: {
  status?: string | null;
  triage_status?: string | null;
  source?: string | null;
  promoted?: boolean | null;
}): boolean {
  return isActiveTask(t) && t.status !== "done" && t.status !== "dropped";
}

// ---------------------------------------------------------------------------
// Nesting
// ---------------------------------------------------------------------------

export type TaskTreeInput = {
  _id: string;
  short_id?: string;
  parent_id?: string | null;
};

export type TaskTreeRow<T> = {
  task: T;
  /** True nesting depth: 0 for a root, 1 for its child, and so on. */
  depth: number;
  /**
   * Depth to indent by. Equal to `depth` until it hits `maxDepth`, then flat.
   * The huddle asked the UI to emphasise the top two levels; clamping the
   * indent (rather than hiding the row) keeps a deep task visible while
   * refusing to let a chain of agent steps march off the right edge.
   */
  indent: number;
  /** Direct children of this row, in the same order they appear in the output. */
  childCount: number;
  /** Every task below this one, at any depth. What a collapsed row summarises. */
  descendantCount: number;
};

export type BuildTaskTreeOptions = {
  /** Indent cap. Default 2 = the top two levels the huddle asked to emphasise. */
  maxDepth?: number;
};

/**
 * Flatten a task list into parent-then-children order, keeping the caller's
 * existing order within each level.
 *
 * The list handed in is already filtered and sorted by the view (status tab,
 * workspace scope, sort column), and this function never adds or removes a
 * task — it only reorders. That matters: a subtask whose PARENT was filtered
 * out is promoted to a root rather than dropped, so turning on "in progress"
 * can never make a matching task vanish because its parent is done. Cycles
 * (which resolveParentTask refuses to create, but old rows might carry) are
 * broken by treating the second visit as a root.
 */
export function buildTaskTree<T extends TaskTreeInput>(
  tasks: T[],
  options: BuildTaskTreeOptions = {},
): TaskTreeRow<T>[] {
  const maxDepth = options.maxDepth ?? 2;

  const present = new Map<string, T>();
  for (const t of tasks) present.set(String(t._id), t);

  // Children keyed by parent, in input order. A parent outside the visible set
  // is not a parent here — its child becomes a root.
  const childrenOf = new Map<string, T[]>();
  const roots: T[] = [];
  for (const t of tasks) {
    const parentKey = t.parent_id ? String(t.parent_id) : "";
    if (parentKey && present.has(parentKey) && parentKey !== String(t._id)) {
      const bucket = childrenOf.get(parentKey);
      if (bucket) bucket.push(t);
      else childrenOf.set(parentKey, [t]);
    } else {
      roots.push(t);
    }
  }

  const rows: TaskTreeRow<T>[] = [];
  const visited = new Set<string>();

  // Counting descendants needs the whole subtree, so each visit emits its row
  // first and back-fills the count once its children are done.
  const walk = (task: T, depth: number): number => {
    const key = String(task._id);
    if (visited.has(key)) return 0;
    visited.add(key);

    const children = childrenOf.get(key) ?? [];
    const row: TaskTreeRow<T> = {
      task,
      depth,
      indent: Math.min(depth, maxDepth),
      childCount: children.length,
      descendantCount: 0,
    };
    rows.push(row);

    let descendants = 0;
    for (const child of children) descendants += walk(child, depth + 1);
    row.descendantCount = descendants;
    return descendants + 1;
  };

  for (const root of roots) walk(root, 0);
  // A cycle among rows that are all present leaves every member unvisited
  // (none is a root). Emit them flat so nothing is silently lost.
  for (const t of tasks) if (!visited.has(String(t._id))) walk(t, 0);

  return rows;
}

/**
 * Descendants per task, keyed by task id.
 *
 * Views call this TWICE with different inputs, and the difference is the point:
 *
 *   - over the whole live workspace → the true subtask count, which is what a
 *     parent row shows. Agent execution subtasks are filtered off the human
 *     board, but the parent must still report that work is running under it —
 *     counted over the filtered list, that badge would read 0 and a task with
 *     five agent subtasks would look like a task with none. The clutter this
 *     nesting exists to fix is about rows, not awareness.
 *   - over the rows the view actually renders → how many are on screen.
 *
 * Subtracting the second from the first gives the count the view is hiding.
 */
export function descendantCounts<T extends TaskTreeInput>(tasks: T[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of buildTaskTree(tasks)) counts.set(String(row.task._id), row.descendantCount);
  return counts;
}

/** How many of a task's subtasks the current view is not rendering. Never negative. */
export function hiddenDescendantCount(
  taskId: string,
  total: Map<string, number>,
  visible: Map<string, number>,
): number {
  return Math.max(0, (total.get(String(taskId)) ?? 0) - (visible.get(String(taskId)) ?? 0));
}

/** Direct children of one task, in the order given. Used by detail views. */
export function directChildren<T extends TaskTreeInput>(tasks: T[], parentId: string): T[] {
  return tasks.filter((t) => t.parent_id && String(t.parent_id) === String(parentId));
}

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

export type SubtaskProgress = {
  /** Direct children that belong in the denominator: active, not dropped. */
  total: number;
  done: number;
  inProgress: number;
};

export type ProgressInput = TaskTreeInput & {
  status?: string | null;
  triage_status?: string | null;
  source?: string | null;
  promoted?: boolean | null;
};

/**
 * The one definition of subtask progress (a parent's `2/4`): DIRECT children
 * only; a dropped child leaves the denominator entirely; suggested/dismissed
 * mined rows never enter it; `done` means status done. The list chip, the
 * detail progress bar, and the close-guard's "N open" all read this — three
 * numbers on one screen that must agree.
 */
export function subtaskProgressOf(children: ProgressInput[]): SubtaskProgress {
  const p: SubtaskProgress = { total: 0, done: 0, inProgress: 0 };
  for (const c of children) {
    if (!isActiveTask(c) || c.status === "dropped") continue;
    p.total += 1;
    if (c.status === "done") p.done += 1;
    else if (c.status === "in_progress" || c.status === "in_review") p.inProgress += 1;
  }
  return p;
}

export type TaskFamilyIndex = {
  /** Countable (active, unfinished) descendants at any depth, per task id. */
  descendants: Map<string, number>;
  /** Direct-children progress per parent id (only parents with children appear). */
  progress: Map<string, SubtaskProgress>;
};

/**
 * The whole-workspace pass, computed once per render over the live task set:
 * deep descendant counts (what a parent's chip reports even when the view has
 * filtered the rows away) and direct-children progress, from the same walk.
 * View-scope passes (order, indent, on-screen counts) stay separate on
 * purpose — total minus visible is what tells a row how much it is hiding.
 */
export function taskFamilyIndex<T extends ProgressInput>(tasks: T[]): TaskFamilyIndex {
  const progress = new Map<string, SubtaskProgress>();
  const byParent = new Map<string, T[]>();
  for (const t of tasks) {
    const parentKey = t.parent_id ? String(t.parent_id) : "";
    if (!parentKey || parentKey === String(t._id)) continue;
    const bucket = byParent.get(parentKey);
    if (bucket) bucket.push(t);
    else byParent.set(parentKey, [t]);
  }
  for (const [parentId, children] of byParent) progress.set(parentId, subtaskProgressOf(children));

  const descendants = descendantCounts(tasks.filter(isCountableSubtask));
  return { descendants, progress };
}

// ---------------------------------------------------------------------------
// Write-side guards (pure mirrors of the server's resolveParentTask checks, so
// optimistic drafts can refuse the same writes the server will refuse)
// ---------------------------------------------------------------------------

/** Deepest depth a task may sit at (root = 0). Matches the render indent clamp. */
export const MAX_TASK_DEPTH = 2;
/** Safety cap on parent-chain walks; beyond this we assume a data cycle. */
export const MAX_PARENT_WALK = 64;

type ParentLookup = (id: string) => string | null | undefined;

/** Depth of a task (0 = root), walking parent_id via `parentOf`. Cycle-capped. */
export function taskDepth(id: string, parentOf: ParentLookup): number {
  let depth = 0;
  let cur = parentOf(String(id));
  const seen = new Set<string>([String(id)]);
  while (cur && !seen.has(String(cur)) && depth < MAX_PARENT_WALK) {
    seen.add(String(cur));
    depth += 1;
    cur = parentOf(String(cur));
  }
  return depth;
}

/** Would setting `childId`'s parent to `parentId` create a cycle? */
export function wouldCreateTaskCycle(childId: string, parentId: string, parentOf: ParentLookup): boolean {
  const child = String(childId);
  let cur: string | null | undefined = String(parentId);
  const seen = new Set<string>();
  while (cur) {
    if (String(cur) === child) return true;
    if (seen.has(String(cur)) || seen.size >= MAX_PARENT_WALK) return true;
    seen.add(String(cur));
    cur = parentOf(String(cur));
  }
  return false;
}
