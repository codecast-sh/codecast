// How a page follows live work without hammering the handler: one tick now,
// then one per interval while the page is on screen, and one at once when it
// comes back (a page hidden for an hour must not show stale numbers under a
// "running" badge for another interval). A product with a change feed follows
// GET /changes from a cursor; one without polls the page it shows. Pure: what
// "on screen" means comes in as a Visibility (the React layer reads the
// document and the host's pane).

import type { ChangesResponse } from '../contract';

/** How often to ask, and whether a hidden page stops asking. Used for every live view; a product without a change feed polls each resource by it. */
export interface PollPolicy {
  intervalMs: number;
  pauseWhenHidden: boolean;
}

/** Every 3 s while a view shows live work, paused while hidden. */
export const EVALS_POLL: PollPolicy = { intervalMs: 3_000, pauseWhenHidden: true };

/** Whether the page is on screen now, and a way to hear when that changes. */
export interface Visibility {
  visible(): boolean;
  subscribe(fn: () => void): () => void;
}

/** A page that is always on screen (a test, a server). */
export const ALWAYS_VISIBLE: Visibility = { visible: () => true, subscribe: () => () => {} };

/**
 * Runs `tick` now, then every interval while visible, and at once when the
 * page comes back on screen. A tick still running is never started twice.
 * Returns the stop.
 */
export function poll(tick: () => unknown, policy: PollPolicy, visibility: Visibility = ALWAYS_VISIBLE): () => void {
  let stopped = false;
  let running = false;
  const run = () => {
    if (stopped || running || (policy.pauseWhenHidden && !visibility.visible())) return;
    running = true;
    void Promise.resolve()
      .then(tick)
      .catch(() => {
        // A one-off miss waits for the next tick; a product's onFailure already saw it.
      })
      .finally(() => {
        running = false;
      });
  };
  run();
  const timer = setInterval(run, policy.intervalMs);
  const unsubscribe = visibility.subscribe(() => {
    if (visibility.visible()) run();
  });
  return () => {
    stopped = true;
    clearInterval(timer);
    unsubscribe();
  };
}

/** Whether a change answer holds anything new: any list in it that is not empty (runs, bisects, a product's own such as codecast's jobs). */
export const hasNews = (c: object): boolean => Object.values(c).some((v) => Array.isArray(v) && v.length > 0);

/**
 * Follows GET /changes from a cursor kept here, so each view follows from
 * when it opened: the first answer only sets the cursor, and each later one
 * with anything new goes to `onChanges`. Returns the stop.
 */
export function followChanges<C extends ChangesResponse<any>>(fetchChanges: (since: number) => Promise<C>, onChanges: (changes: C) => void, policy: PollPolicy = EVALS_POLL, visibility: Visibility = ALWAYS_VISIBLE): () => void {
  let cursor: number | null = null;
  let stopped = false;
  const stop = poll(
    async () => {
      const changes = await fetchChanges(cursor ?? 0);
      if (stopped) return;
      const first = cursor === null;
      cursor = changes.cursor;
      if (!first && hasNews(changes)) onChanges(changes);
    },
    policy,
    visibility,
  );
  return () => {
    stopped = true;
    stop();
  };
}

/**
 * New rows merged into a list by id, never by position or sequence (a
 * sequence can repeat when two writers race, and a page mounted twice can
 * land an old answer after a new one). A row whose id is already there
 * replaces it where it stands; a new id is appended. The same array comes
 * back when nothing changed, so a view keyed on it does not redraw.
 */
export function mergeById<T>(prev: readonly T[], next: readonly T[], idOf: (row: T) => string = (row) => (row as { id: string }).id): T[] {
  if (!next.length) return prev as T[];
  const at = new Map(prev.map((row, i) => [idOf(row), i]));
  let out: T[] | null = null;
  for (const row of next) {
    const i = at.get(idOf(row));
    if (i === undefined) {
      out ??= [...prev];
      at.set(idOf(row), out.length);
      out.push(row);
    } else if ((out ?? prev)[i] !== row) {
      out ??= [...prev];
      out[i] = row;
    }
  }
  return out ?? (prev as T[]);
}

/**
 * Where the next page of an append-only log starts, after a page read from
 * `current`: its last sequence number, or one before it when the page came
 * back full, so an entry sharing a sequence number across the page boundary
 * is read again (mergeById absorbs the overlap).
 */
export function nextSeqCursor(page: ReadonlyArray<{ seq: number }>, pageSize: number, current: number): number {
  const last = page.at(-1);
  if (!last) return current;
  return page.length >= pageSize ? last.seq - 1 : last.seq;
}
