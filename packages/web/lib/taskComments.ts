// A task row's comments as the list channels ship them and the detail fills
// them. A list row carries `comment_count` and, for a problem, its newest few
// comments' first lines (`recent_comments`); the whole thread lands in
// `comments` only from the detail query, while the task is open (or from an
// older server's list). These read one answer from whichever the row holds.

type CommentLike = { _id?: string; created_at?: number };
type TaskCommentFields<C extends CommentLike> = {
  comments?: ReadonlyArray<C> | null;
  recent_comments?: ReadonlyArray<C> | null;
  comment_count?: number | null;
};

/** How many comments the task has: the server's count, or the thread held when it holds more (an optimistic reply). */
export function taskCommentCount(task: TaskCommentFields<CommentLike> | null | undefined): number {
  if (!task) return 0;
  const held = Array.isArray(task.comments) ? task.comments.length : 0;
  return Math.max(typeof task.comment_count === "number" ? task.comment_count : 0, held);
}

const unionCache = new WeakMap<object, ReadonlyArray<CommentLike>>();
const NONE: ReadonlyArray<never> = [];

/** The comments the row holds, oldest first: the thread, with the list's newest ones over it (a held thread can be older than the row). */
export function taskCommentsOf<C extends CommentLike>(task: TaskCommentFields<C> | null | undefined): ReadonlyArray<C> {
  if (!task) return NONE;
  const full = Array.isArray(task.comments) ? task.comments : null;
  const recent = Array.isArray(task.recent_comments) ? task.recent_comments : null;
  if (!recent?.length) return full ?? NONE;
  if (!full?.length) return recent;
  const hit = unionCache.get(task as object);
  if (hit) return hit as ReadonlyArray<C>;
  const byId = new Map<string, C>();
  for (const c of full) byId.set(String(c._id), c);
  for (const c of recent) if (!byId.has(String(c._id))) byId.set(String(c._id), c);
  const out = [...byId.values()].sort((a, b) => (a.created_at ?? 0) - (b.created_at ?? 0));
  unionCache.set(task as object, out);
  return out;
}

/** A cached row written by a list that ships counts: its held thread is dropped, the detail brings it back when the task opens. */
export function withoutListThread<T extends TaskCommentFields<CommentLike>>(row: T): T {
  if (!row || typeof row.comment_count !== "number" || row.comments === undefined) return row;
  const { comments: _drop, ...rest } = row as any;
  return rest as T;
}
