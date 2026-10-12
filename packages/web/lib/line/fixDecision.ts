// The decision a line run puts in front of the owner about its problem
// (line-workspace.md): a session_decisions row whose task_id is the problem and
// whose workflow_run_id is the run, asked by the run's own session. Inbox and
// Problems both ask "what decision waits on this problem?" through here, over
// the two store homes a fix decision can sit in: sessionDecisions (the viewer's
// own queue, the full row) and lineCards (every line card in the workspace,
// a slim row). Pure, so a test reads it.

export type FixDecisionRow = { _id: string; short_id?: string; status: string; task_id?: string; workflow_run_id?: string; created_at?: number; card?: unknown };
type Rows = Record<string, FixDecisionRow> | undefined;

/** A decision is a fix decision when a run asked it about a problem. */
export const isFixDecision = (d: FixDecisionRow): boolean => !!d.task_id && !!d.workflow_run_id;

const cache = new WeakMap<object, WeakMap<object, Map<string, FixDecisionRow>>>();
const EMPTY = {};

/**
 * Every open fix decision by its problem's task id, the newest when a problem
 * has several (a later run's card supersedes an earlier one). Cached by the two
 * collections' refs, so a selector may call it on every store change.
 */
export function openFixDecisions(own: Rows, line: Rows): Map<string, FixDecisionRow> {
  const a = own ?? EMPTY;
  const b = line ?? EMPTY;
  let inner = cache.get(a);
  if (!inner) { inner = new WeakMap(); cache.set(a, inner); }
  const hit = inner.get(b);
  if (hit) return hit;
  const out = new Map<string, FixDecisionRow>();
  // The own row wins over the line's slim copy of the same decision: it is the one answers land on first.
  const seen = new Map<string, FixDecisionRow>();
  for (const d of Object.values(b as Record<string, FixDecisionRow>)) seen.set(d._id, d);
  for (const d of Object.values(a as Record<string, FixDecisionRow>)) seen.set(d._id, d);
  for (const d of seen.values()) {
    if (d.status !== "pending" || !isFixDecision(d)) continue;
    const was = out.get(d.task_id!);
    if (!was || (d.created_at ?? 0) > (was.created_at ?? 0)) out.set(d.task_id!, d);
  }
  inner.set(b, out);
  return out;
}

/** The open fix decision waiting on one problem (its task id), or null. */
export function openFixDecisionFor(own: Rows, line: Rows, taskId: string | null | undefined): FixDecisionRow | null {
  return taskId ? openFixDecisions(own, line).get(taskId) ?? null : null;
}

/** How the line's address names a decision: its short id when it has one. */
export const decisionRef = (d: Pick<FixDecisionRow, "_id" | "short_id">): string => d.short_id ?? d._id;
