// Timestamp formatting shared by web, mobile and the CLI. One set of
// thresholds for every relative stamp, and one rule for when a stamp stops
// being relative and becomes a calendar date, so the same doc reads the same
// age on every surface.

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

/** Relative stamps become calendar dates past this age. */
export const RELATIVE_WINDOW_MS = 7 * DAY;

// A target day (an initiative's `target_date`) is a calendar day, not a
// moment: "2026-12-31" must read back as the same day in every timezone. It
// is stored as the last instant of that day in UTC and read back as the UTC
// day, so the CLI and the web picker agree on the day and neither opens a day
// late west of UTC. Every writer and reader goes through this pair.
const TARGET_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** "YYYY-MM-DD" → the stamp to store, or null for a malformed or rolled day (Feb 30). */
export function targetDayStamp(day: string): number | null {
  const m = TARGET_DAY.exec(day.trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const ts = Date.UTC(y, mo - 1, d, 23, 59, 59, 999);
  const back = new Date(ts);
  return back.getUTCFullYear() === y && back.getUTCMonth() === mo - 1 && back.getUTCDate() === d ? ts : null;
}

/** A stored target stamp → "YYYY-MM-DD"; undefined when there is none. */
export function targetDayOf(ts?: number | null): string | undefined {
  return ts ? new Date(ts).toISOString().slice(0, 10) : undefined;
}

// Compact relative age, e.g. "now", "3m", "2h", "5d" (no "ago" suffix — meant
// for tight badges/chips). For full "3m ago" phrasing use formatRelative.
// Pass `now` when the caller already holds a shared clock (useCoarseNow), so
// every stamp on a surface ages off the same tick.
export function relTimeShort(ms: number, now: number = Date.now()): string {
  const diff = now - ms;
  if (diff < MINUTE) return "now";
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)}m`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)}h`;
  return `${Math.floor(diff / DAY)}d`;
}

/** "just now" / "12m ago" / "3h ago" / "2d ago" — relTimeShort with the
 *  suffix; one set of thresholds for every relative stamp. */
export function formatRelative(ts: number, now: number = Date.now()): string {
  const short = relTimeShort(ts, now);
  return short === "now" ? "just now" : `${short} ago`;
}

/** "Aug 2" — the short calendar form for a date that is past the relative
 *  range; the year is added only when it is not the current one. */
export function formatShortDate(ts: number, now: number = Date.now()): string {
  const d = new Date(ts);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return d.toLocaleDateString("en-US", sameYear
    ? { month: "short", day: "numeric" }
    : { month: "short", day: "numeric", year: "numeric" });
}

/** The long form a relative stamp's tooltip shows. */
export function formatDateFull(ts: number): string {
  return new Date(ts).toLocaleDateString("en-US", {
    weekday: "long", month: "long", day: "numeric", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

/** The one rule for a human-facing stamp: relative while it is recent
 *  ("3h ago"), a calendar date once it is older than a week ("Aug 2",
 *  "Aug 2, 2025"). */
export function formatDateSmart(ts: number, now: number = Date.now()): string {
  return now - ts < RELATIVE_WINDOW_MS ? formatRelative(ts, now) : formatShortDate(ts, now);
}

export type DatedRow = { created_at: number; updated_at?: number | null };

// A row's first write also stamps updated_at, and a follow-up write in the
// same minute (the title heading rewrite, a sync echo) is still "creation" to
// a reader. Only a later edit counts as an update.
const EDIT_GRACE_MS = MINUTE;

/** Was the row edited after it was created? */
export function wasEdited(row: DatedRow): boolean {
  const updated = row.updated_at ?? row.created_at;
  return updated - row.created_at > EDIT_GRACE_MS;
}

/** The short label for a row's dates: "Created 3h ago", or when it was edited
 *  later, "Created Aug 2 · Updated 3h ago". */
export function describeDates(row: DatedRow, now: number = Date.now()): string {
  const created = `Created ${formatDateSmart(row.created_at, now)}`;
  if (!wasEdited(row)) return created;
  return `${created} · Updated ${formatDateSmart(row.updated_at!, now)}`;
}

/** The long form for a tooltip: one full date per line. */
export function describeDatesFull(row: DatedRow): string {
  const created = `Created ${formatDateFull(row.created_at)}`;
  if (!wasEdited(row)) return created;
  return `${created}\nUpdated ${formatDateFull(row.updated_at!)}`;
}
