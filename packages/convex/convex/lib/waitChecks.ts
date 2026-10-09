// The one read of a checks wait's PR (docs/architecture/task-graph.md TG2,
// TG10). A `pr_checks_green` wait stays waiting while its PR's checks are red
// — only a new push can turn them green — so a surface that words such a wait
// "PR #42 checks to go green" with no state beside it sends a session dormant
// on checks that have been failing for hours. Every surface that words a
// blocker (`cast task show`, `tasks.list`/`update`'s `open_blockers`, the
// compaction block, the task page, the phone) therefore carries the PR's
// `checks_state` on the entry, and reads it here: the access rule and the read
// live in one place, so a change to either (a kind admitted by another grant,
// a wait on a closed PR) moves every one of them at once.

import type { QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { canAccessPullRequest } from "./access";
import { prByNumber } from "./gitRefs";
import { openBlockersOf } from "./taskGraph";
import { checksWaitPr, isTerminalTaskStatus, type Blocker, type TaskWait } from "@codecast/shared/tasks";

type ReadCtx = Pick<QueryCtx, "db">;

/** The `checks_state` of the PR one wait names, when it is a checks wait that
 *  still needs the read (`checksWaitPr` is that one rule) and `userId` may read
 *  the PR: a PR in a team the reader is not in lends nothing. */
export async function waitChecksState(
  ctx: ReadCtx,
  userId: Id<"users">,
  w: TaskWait,
  opts: { closed?: boolean } = {},
): Promise<string | undefined> {
  const target = checksWaitPr(w, opts);
  if (!target) return undefined;
  const pr = await prByNumber(ctx, target.repository, target.pr_number);
  return pr?.checks_state && (await canAccessPullRequest(ctx, userId, pr)) ? pr.checks_state : undefined;
}

/** The `checks_state` of the PR each of `task`'s still-waiting checks waits
 *  names, keyed by wait id, as `cast task show` ships them (`wait_checks`). */
export async function waitChecks(ctx: ReadCtx, userId: Id<"users">, task: Doc<"tasks">): Promise<Record<string, string>> {
  const closed = isTerminalTaskStatus(task.status);
  const out: Record<string, string> = {};
  for (const w of task.waits ?? []) {
    const checks = await waitChecksState(ctx, userId, w, { closed });
    if (checks) out[w.id] = checks;
  }
  return out;
}

/** `task`'s blockers with each still-waiting checks wait carrying its PR's
 *  `checks_state`, for the answers whose blockers are read as words with no
 *  state bracket beside them: `tasks.update`'s `open_blockers`, which `cast
 *  task start` prints as "Still blocked by: …" and then builds its parking
 *  advice from, `tasks.list`'s, which `cast task ls`, `ready` and `overview`
 *  word the same way (listedReadiness.ts), and the compaction block's
 *  (taskResume), the one surface that orders a session dormant.
 *
 *  Stamped on the entry rather than returned beside it: a task can hold two
 *  checks waits in different states, and every reader downstream labels one
 *  entry at a time. A row holding no checks wait short-circuits, so stamping a
 *  whole page costs a read only for the rows that have one. */
export async function stampWaitChecks(
  ctx: ReadCtx,
  userId: Id<"users">,
  task: Doc<"tasks">,
  blockers: Blocker[],
): Promise<Array<Blocker & { checks?: string }>> {
  if (!blockers.some((b) => b.kind === "pr_checks_green")) return blockers;
  const checks = await waitChecks(ctx, userId, task);
  return blockers.map((b) => (b.kind !== "task" && checks[b.id] ? { ...b, checks: checks[b.id] } : b));
}

/** `openBlockersOf` stamped by `stampWaitChecks`, for a caller holding one
 *  task and no page lookups of its own. */
export async function openBlockersWithChecks(ctx: ReadCtx, userId: Id<"users">, task: Doc<"tasks">): Promise<Array<Blocker & { checks?: string }>> {
  return await stampWaitChecks(ctx, userId, task, await openBlockersOf(ctx, task));
}
