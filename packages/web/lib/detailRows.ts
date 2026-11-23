// The list rows every window holds, and the heavy fields kept off them.
//
// The server sends a task with its whole comment thread and a pull request
// with its files, patches, commits and checks. Held on the list rows, those
// fields were 43% of a window's store (16.6 MB of comments across 7,917
// tasks; 33 MB of files, commits and checks across 253 pull requests), read
// from disk at boot, held in every window and sent between windows on every
// change. A list draws none of them.
//
// So the rows of `tasks` and `pullRequests` are stored without those fields
// (thin*), and the fields live in a detail collection keyed by the same id:
// `taskComments` and `pullRequestDetails`. A detail row exists only for an
// object some surface opened (a task's page or thread, a pull request's page
// or diff, the line's problem list), and the store keeps the rows it holds
// current from every push that carries the fields (store/inboxStore.ts,
// DETAIL_SPLITS).
//
// A leaf module: relative imports only, because the phone's bundle reaches it
// through the shared store.

/** How long a detail row keeps its last-opened stamp before a feeder renews
 *  it: retention reads the stamp, and a fresh one on every push would rewrite
 *  the row to disk each time. */
export const CACHED_AT_GRAIN_MS = 6 * 60 * 60 * 1000;

export const cachedAt = (prev: { _cachedAt?: number } | undefined, now: number): number => {
  const held = prev?._cachedAt;
  return held !== undefined && now - held < CACHED_AT_GRAIN_MS ? held : now;
};

type Row = Record<string, any>;

// ── How many detail rows a window holds ─────────────────────────────────────
//
// A detail row enters when a surface opens its object. The caps hold while
// the window lives (the store evicts past them on every insert) and again at
// boot (store/cacheRetention). The task cap leaves room for every problem a
// line lists, which reads its threads at once (756 problems' threads measured
// 1.1 MB). A pull request's detail averages 175 KB, so its cap is the handful
// a person is working through, not a history. An evicted row is one read
// away: the surface that shows it fetches it again.
//
// `deployReach` is not split off a list row, but it is held the same way: a
// row per merged pull request or main commit a pill named, read by the pill
// that names it (hooks/useDeployReach), so the pill pins it and the rest age
// out by when they were last fed.
//
// `runGraphs` is held the same way: a pinned run's graph (up to ~30 KB), one
// row per version a run card opened, pinned by the card that draws it
// (hooks/useSyncWorkflows useRunWorkflow).
// `deployDetails` holds the names an opened deploy's push added and dropped
// (up to 500 each, so a row can reach tens of KB): the deploys a person opened
// lately, pinned by the open detail (hooks/useDeployDetail).
export const DETAIL_ROW_CAPS = { taskComments: 1500, pullRequestDetails: 12, deployReach: 300, runGraphs: 40, deployDetails: 50 } as const;
export type DetailKey = keyof typeof DETAIL_ROW_CAPS;
export const isDetailKey = (key: string): key is DetailKey => Object.prototype.hasOwnProperty.call(DETAIL_ROW_CAPS, key);

// What is on screen in this window: each mounted reader of a detail row pins
// it (useTaskComments, usePullRequestDetail, useSyncTaskThreads), and a
// pinned row is never evicted, whatever the cap and whichever window asked.
const pins: Record<DetailKey, Map<string, number>> = { taskComments: new Map(), pullRequestDetails: new Map(), deployReach: new Map(), runGraphs: new Map(), deployDetails: new Map() };

/** Hold these rows while a surface shows them. Returns the release. */
export function pinDetailRows(key: DetailKey, ids: readonly string[]): () => void {
  const held = pins[key];
  for (const id of ids) held.set(id, (held.get(id) ?? 0) + 1);
  return () => {
    for (const id of ids) {
      const n = (held.get(id) ?? 0) - 1;
      if (n > 0) held.set(id, n); else held.delete(id);
    }
  };
}

export function isDetailPinned(key: string, id: string): boolean {
  return isDetailKey(key) && pins[key].has(id);
}

/** Test seam. */
export function resetDetailPins(): void {
  for (const held of Object.values(pins)) held.clear();
}

/**
 * The rows to drop so `rows` fits its cap: the least recently opened first
 * (`_cachedAt`). Never one a surface has on screen, and never one `keep`
 * names (a row with an unsent write). The rows `fresh` names are the ones
 * this write brought: their reader may not have mounted yet, and its query
 * will not send them again, so they go only as far as the write alone is
 * over the cap (a snapshot of more rows than a window may hold). Empty when
 * the collection fits, or when everything over the cap is in use.
 */
export function detailRowsToEvict(
  key: DetailKey,
  rows: Record<string, { _cachedAt?: number }>,
  keep: (id: string) => boolean,
  fresh: (id: string) => boolean = () => false,
): string[] {
  const cap = DETAIL_ROW_CAPS[key];
  let count = 0;
  for (const _ in rows) count++;
  const over = count - cap;
  if (over <= 0) return [];
  const older: Array<{ id: string; at: number }> = [];
  const brought: Array<{ id: string; at: number }> = [];
  let broughtCount = 0;
  for (const id in rows) {
    const isFresh = fresh(id);
    if (isFresh) broughtCount++;
    if (pins[key].has(id) || keep(id)) continue;
    (isFresh ? brought : older).push({ id, at: rows[id]._cachedAt ?? 0 });
  }
  const byAge = (a: { at: number }, b: { at: number }) => a.at - b.at;
  const gone = older.sort(byAge).slice(0, over);
  const still = Math.min(over - gone.length, Math.max(0, broughtCount - cap));
  if (still > 0) gone.push(...brought.sort(byAge).slice(0, still));
  return gone.map((r) => r.id);
}

// ── Tasks ───────────────────────────────────────────────────────────────────

/** A task's comment thread as the store holds it, keyed by the task's id. */
export type TaskCommentsRow = {
  _id: string;
  comments: any[];
  /** The task's `last_comment_at` when this set was read: a task row with a
   *  newer one says the thread has moved since. */
  as_of: number;
  _cachedAt: number;
};

/** A task row as the `tasks` collection holds it: without its comments, with
 *  how many there are. A row that carries none is returned as it came. */
export function thinTaskRow<T extends Row>(row: T): T {
  if (!row || row.comments === undefined) return row;
  const { comments, ...rest } = row;
  if (Array.isArray(comments)) (rest as Row).comment_count = comments.length;
  return rest as T;
}

/** The thread a task row carries, or null when it carries none. */
export function taskCommentsRow(row: Row, prev: TaskCommentsRow | undefined, now: number): TaskCommentsRow | null {
  if (!row || !Array.isArray(row.comments)) return null;
  return {
    _id: String(row._id),
    comments: row.comments,
    as_of: typeof row.last_comment_at === "number" ? row.last_comment_at : prev?.as_of ?? 0,
    _cachedAt: cachedAt(prev, now),
  };
}

/** Whether the store's thread for a task is older than the task row says its
 *  comments are (or was never read). */
export function taskThreadStale(task: { last_comment_at?: number | null } | undefined, thread: TaskCommentsRow | undefined): boolean {
  if (!thread) return true;
  return (task?.last_comment_at ?? 0) > thread.as_of;
}

// ── Pull requests ───────────────────────────────────────────────────────────

/** The fields of a pull request row only its page and its diff draw. */
export const PULL_REQUEST_DETAIL_FIELDS = ["files", "commits", "checks"] as const;

export type PullRequestDetailRow = {
  _id: string;
  files?: any[];
  commits?: any[];
  checks?: any[];
  /** The pull request's `checks_state` when these checks were read. The inbox
   *  chip feed moves that state on the list row without the checks; a detail
   *  read under another state would contradict it (red checks under "checks
   *  passed"), so its checks are not shown until a full read sends them again. */
  checks_state: string | null;
  _cachedAt: number;
};

const carriesPullRequestDetail = (row: Row): boolean =>
  !!row && PULL_REQUEST_DETAIL_FIELDS.some((f) => row[f] !== undefined);

/** A pull request row as the `pullRequests` collection holds it: without its
 *  files, commits and checks. A row that carries none is returned as it came. */
export function thinPullRequestRow<T extends Row>(row: T): T {
  if (!carriesPullRequestDetail(row)) return row;
  const { files: _f, commits: _c, checks: _k, ...rest } = row;
  return rest as T;
}

/** The detail a full pull request row carries, or null for a row that carries none (a chip row). */
export function pullRequestDetailRow(row: Row, prev: PullRequestDetailRow | undefined, now: number): PullRequestDetailRow | null {
  if (!carriesPullRequestDetail(row)) return null;
  const out: PullRequestDetailRow = { _id: String(row._id), checks_state: row.checks_state ?? null, _cachedAt: cachedAt(prev, now) };
  for (const f of PULL_REQUEST_DETAIL_FIELDS) if (row[f] !== undefined) out[f] = row[f];
  return out;
}

/** A pull request as its page reads it: the list row with its detail laid on. */
export function joinPullRequestDetail<T extends Row>(row: T, detail: PullRequestDetailRow | undefined): T {
  if (!detail) return row;
  const out: Row = { ...row };
  if (detail.files !== undefined) out.files = detail.files;
  if (detail.commits !== undefined) out.commits = detail.commits;
  if (detail.checks !== undefined && detail.checks_state === (row.checks_state ?? null)) out.checks = detail.checks;
  return out as T;
}

// ── A list that reads threads ───────────────────────────────────────────────

const joinedRows = new WeakMap<object, { comments: any[]; row: Row }>();

/**
 * Task rows with the store's thread laid on as `comments`, for the rows
 * `wants` picks: the view a surface reads when it derives something from the
 * thread across a whole list (the line reads each problem's notes). A row
 * with no thread held is returned as it is, and a joined row keeps its
 * identity while its row and its thread do.
 */
export function withTaskComments<T extends { _id: string }>(rows: readonly T[], threads: Record<string, TaskCommentsRow> | undefined, wants: (row: T) => boolean): T[] {
  return rows.map((row) => {
    const comments = wants(row) ? threads?.[String(row._id)]?.comments : undefined;
    if (!comments) return row;
    const was = joinedRows.get(row);
    if (was && was.comments === comments) return was.row as T;
    const joined = { ...row, comments };
    joinedRows.set(row, { comments, row: joined });
    return joined;
  });
}
