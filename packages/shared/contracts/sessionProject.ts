// Which project a session works in (docs/architecture/session-projects.md).
//
// One home per fact: a session stores `project_id` only when a person or the
// project itself put it there (the composer's pick, a move, the project's
// default session). Everything else is derived here, at read time, by every
// reader (the inbox filter, the project page, the scope rules):
//
//   1. the session's own project_id;
//   2. the project of the task or plan it is bound to;
//   3. its parent's project: the session that started it (a worker, a spawn,
//      a fork), resolved by the same rule, so a project's workers and their
//      workers belong to it and follow it when the parent moves.
//
// The folder decides nothing: a project is a stream of work, not a checkout.

export type IdLike = { toString(): string } | string;

export interface SessionProjectRow {
  _id: IdLike;
  project_id?: IdLike | null;
  active_task_id?: IdLike | null;
  active_plan_id?: IdLike | null;
  parent_conversation_id?: IdLike | null;
  spawned_by_conversation_id?: IdLike | null;
}

export interface SessionProjectLookup<R extends SessionProjectRow> {
  session(id: string): R | null | undefined;
  /** The project of a task, or null when it has none or is unknown here. */
  taskProject(id: string): string | null | undefined;
  planProject(id: string): string | null | undefined;
}

/** The session this one inherits its project from: the parent link a worker
 *  or fork carries, else whoever spawned it. Broader than nesting
 *  (nestParentIdOf) on purpose: a plain spawn and a fork never nest, but both
 *  continue their starter's work. */
export function projectParentIdOf(conv: SessionProjectRow): string | null {
  return conv.parent_conversation_id?.toString() || conv.spawned_by_conversation_id?.toString() || null;
}

/** Rules 1 and 2: the project a session names for itself, without its parents. */
export function ownSessionProjectId(
  conv: SessionProjectRow,
  taskProject: (id: string) => string | null | undefined,
  planProject: (id: string) => string | null | undefined,
): string | null {
  if (conv.project_id) return conv.project_id.toString();
  if (conv.active_task_id) {
    const p = taskProject(conv.active_task_id.toString());
    if (p) return p;
  }
  if (conv.active_plan_id) {
    const p = planProject(conv.active_plan_id.toString());
    if (p) return p;
  }
  return null;
}

/** A chain longer than this is a cycle or corrupt data, never a real tree. */
export const SESSION_PROJECT_MAX_DEPTH = 32;

/** The project a session works in, or null. A parent missing from the lookup
 *  ends the walk with no answer rather than a guess. */
export function sessionProjectId<R extends SessionProjectRow>(conv: R, lookup: SessionProjectLookup<R>): string | null {
  const seen = new Set<string>();
  let cur: R | null | undefined = conv;
  while (cur && seen.size < SESSION_PROJECT_MAX_DEPTH) {
    const id = cur._id.toString();
    if (seen.has(id)) return null;
    seen.add(id);
    const own = ownSessionProjectId(cur, lookup.taskProject, lookup.planProject);
    if (own) return own;
    const parentId = projectParentIdOf(cur);
    cur = parentId ? lookup.session(parentId) : null;
  }
  return null;
}
