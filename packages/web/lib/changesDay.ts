// The day a /changes view names (docs/proposals/changes-page.md 6.3): the
// `d=` query carries a team-local YYYY-MM-DD. Pure, so the tab title, the
// palette and the page format and pick days the same way.

const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** A YYYY-MM-DD as a calendar date at UTC midnight, or null when it is not a real day. */
export function parseDay(ymd: string): Date | null {
  const m = YMD.exec(ymd);
  if (!m) return null;
  const date = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  // Date.UTC rolls 2026-02-31 into March; a rolled date is not the day asked for.
  return date.getUTCDate() === Number(m[3]) && date.getUTCMonth() === Number(m[2]) - 1 ? date : null;
}

/** "Fri 2 Oct" for "2026-10-02". The string names a calendar day, so no time zone applies. */
export function changesDayLabel(ymd: string | null | undefined): string | null {
  const date = ymd ? parseDay(ymd) : null;
  if (!date) return null;
  return `${WEEKDAYS[date.getUTCDay()]} ${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}`;
}

/** The viewer's local calendar day, `offset` days from `now` (-1 is yesterday). */
export function localDay(offset = 0, now: number = Date.now()): string {
  const d = new Date(now);
  d.setDate(d.getDate() + offset);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
