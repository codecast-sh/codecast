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

/** A stored target stamp → "Oct 30", with the year when it is not this one:
 *  the stored day in every timezone, where formatShortDate would name the
 *  viewer's local day of the stamp's instant. */
export function formatTargetDay(ts: number, now: number = Date.now()): string {
  const [y, m, d] = targetDayOf(ts)!.split("-").map(Number);
  return formatShortDate(new Date(y, m - 1, d, 12).getTime(), now);
}

/** Whether a stored target day is over where the viewer is: their own
 *  calendar reads a later day. A day due today is late only tomorrow. */
export function targetDayPassed(ts: number, now: number = Date.now()): boolean {
  const d = new Date(now);
  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return targetDayOf(ts)! < today;
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

// A time a person types on a filter: "today", "yesterday", "7d", "2w ago",
// "24h", or anything Date.parse reads ("2026-09-01"). One reader for the CLI's
// -s/-e flags and the after:/before: operators of a session query, so both
// spellings of a window mean the same instant. null when it cannot be read.
export function parseRelativeDate(input: string, now: number = Date.now()): number | null {
  const lowered = input.toLowerCase().trim();

  if (lowered === "today") return new Date(now).setHours(0, 0, 0, 0);
  if (lowered === "yesterday") return now - DAY;

  const relMatch = lowered.match(/^(\d+)\s*(d|day|days|h|hour|hours|w|week|weeks)(\s*ago)?$/);
  if (relMatch) {
    const num = parseInt(relMatch[1]);
    const unit = relMatch[2][0];
    return now - num * (unit === "d" ? DAY : unit === "h" ? HOUR : 7 * DAY);
  }

  const parsed = Date.parse(input);
  return isNaN(parsed) ? null : parsed;
}

// End bounds read a date-only input as the END of that day, so a start and end
// of 2026-06-05 mean the whole day instead of an empty window (a bare date
// otherwise parses to the midnight that starts it).
export function parseEndDate(input: string, now: number = Date.now()): number | null {
  const parsed = parseRelativeDate(input, now);
  if (parsed === null) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(input.trim())) return parsed + DAY - 1;
  return parsed;
}

// "24h", "90m", "1.5h", "2d", "1w", "30s", "500ms" → milliseconds; the long
// unit spellings ("30min", "2hours", "1day", "2weeks") read the same. The one duration
// grammar for a length of time a person or a manifest writes: `cast trigger
// --in/--every`, `cast stack --policy`, `cast connector grant --until`, an app
// connector watch's `every`. Throws with a message that names the input.
export function parseDuration(raw: string): number {
  const m = raw.trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?|d|days?|w|wks?|weeks?)$/i);
  if (!m) throw new Error(`"${raw}" is not a duration (use 30m, 24h, 2d, 1w)`);
  const n = parseFloat(m[1]);
  const unit = m[2].toLowerCase();
  const ms = unit === "ms" ? 1 : unit[0] === "s" ? 1000 : unit[0] === "m" ? MINUTE : unit[0] === "h" ? HOUR : unit[0] === "w" ? 7 * DAY : DAY;
  const out = Math.round(n * ms);
  if (out <= 0) throw new Error("A duration must be positive");
  return out;
}

/** The inverse of parseDuration for whole units: 86_400_000 → "1d". */
export function formatDuration(ms: number): string {
  if (ms % DAY === 0) return `${ms / DAY}d`;
  if (ms % HOUR === 0) return `${ms / HOUR}h`;
  if (ms % MINUTE === 0) return `${ms / MINUTE}m`;
  return `${Math.round(ms / 1000)}s`;
}
