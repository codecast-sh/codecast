// The needs-input digest, in the one place the server and every client can read
// it. Convex folds the alerts here (notifications.performIdleDigestFlush) and
// the web bell folds the ROWS the same way, so the phone banner and the popup
// header can never name a different set or word it differently.

/** How long one alert covers. A settle inside the window rides the fold-up. */
export const IDLE_DIGEST_WINDOW_MS = 60 * 60 * 1000;

/** The notification type the fold-up alert is written under. */
export const IDLE_DIGEST_TYPE = "sessions_need_input";

/** The type each waiting session writes for itself. */
export const IDLE_TYPE = "session_idle";

// How many sessions the line NAMES before it starts counting. Two names plus a
// count reads in a phone banner; five names do not.
const NAMED = 2;

/** The fold-up's title and body, from the waiting sessions' titles. */
export function summarizeIdleDigest(titles: string[]): { title: string; message: string } {
  const n = titles.length;
  const verb = n === 1 ? "needs" : "need";
  const named = titles.slice(0, NAMED);
  const rest = n - named.length;
  const list =
    rest > 0
      ? `${named.join(", ")} and ${rest} other${rest === 1 ? "" : "s"}`
      : named.join(" and ");
  return {
    title: `${n} session${n === 1 ? "" : "s"} ${verb} your attention`,
    message: `${list} ${verb} your attention`,
  };
}

/** The shape the grouping needs off a notification row. */
export type IdleGroupRow = { type?: string; created_at?: number; read?: boolean };

export type IdleGrouped<T> =
  | { kind: "single"; row: T; key: string }
  | { kind: "group"; digest: T | null; rows: T[]; unread: number; newestAt: number; key: string };

/**
 * Collapse each waiting burst into one entry, newest first.
 *
 * The list arrives sorted newest first and the fold-up row is written AFTER the
 * sessions it covers, so it always sits directly above them: one walk over
 * adjacent rows partitions the list by window with no extra state. A lone
 * waiting session with no fold-up above it stays its own row — one session
 * waiting on you is not a burst, and hiding it behind a count would cost a
 * click to learn nothing.
 */
export function groupIdleNotifications<T extends IdleGroupRow>(
  rows: T[],
  keyOf: (row: T) => string,
): IdleGrouped<T>[] {
  const out: IdleGrouped<T>[] = [];
  let i = 0;
  while (i < rows.length) {
    const row = rows[i];
    const digest = row.type === IDLE_DIGEST_TYPE ? row : null;
    if (!digest && row.type !== IDLE_TYPE) {
      out.push({ kind: "single", row, key: keyOf(row) });
      i += 1;
      continue;
    }
    let j = digest ? i + 1 : i;
    const members: T[] = [];
    while (j < rows.length && rows[j].type === IDLE_TYPE) {
      members.push(rows[j]);
      j += 1;
    }
    // One row saying one thing stays one row: a lone session, or a fold-up
    // whose members have all been superseded.
    if (members.length + (digest ? 1 : 0) < 2) {
      out.push({ kind: "single", row, key: keyOf(row) });
      i += 1;
      continue;
    }
    const all = digest ? [digest, ...members] : members;
    out.push({
      kind: "group",
      digest,
      rows: members,
      unread: all.filter((r) => !r.read).length,
      newestAt: Math.max(...all.map((r) => r.created_at ?? 0)),
      key: `group:${keyOf(all[0])}`,
    });
    i = j;
  }
  return out;
}
