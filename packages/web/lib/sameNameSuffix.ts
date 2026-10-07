// Rows in one list that read the same name ("Decline dinner invitation" twice)
// get a muted distinguisher after the title, computed where the list is built
// and never stored: when each began, as a clock time for today, "Yesterday",
// a weekday within the week, else a date ("Mar 26"); a clock time also when
// two of them began on the same day. Rows with a unique name get nothing.

const DAY_MS = 24 * 60 * 60 * 1000;

function startOfDay(at: number): number {
  const d = new Date(at);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function clockWords(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/** When something happened, as a list row says it: a clock time for today,
 *  "Yesterday", a weekday within the week, else a date. */
export function dayWords(at: number, now: number): string {
  const days = Math.round((startOfDay(now) - startOfDay(at)) / DAY_MS);
  if (days <= 0) return clockWords(at);
  if (days === 1) return "Yesterday";
  if (days < 7) return new Date(at).toLocaleDateString([], { weekday: "short" });
  return new Date(at).toLocaleDateString([], { month: "short", day: "numeric" });
}

/** id -> suffix for every row whose title another row in `rows` shares. */
export function sameNameSuffixes<T extends { _id: string; started_at?: number; _creationTime?: number; updated_at?: number }>(
  rows: readonly T[],
  titleOf: (row: T) => string,
  now = Date.now(),
): Map<string, string> {
  const byTitle = new Map<string, T[]>();
  for (const row of rows) {
    const key = titleOf(row).trim().toLowerCase();
    if (!key) continue;
    const same = byTitle.get(key);
    if (same) same.push(row);
    else byTitle.set(key, [row]);
  }
  const out = new Map<string, string>();
  for (const same of byTitle.values()) {
    if (same.length < 2) continue;
    const startOf = (row: T) => row.started_at ?? row._creationTime ?? row.updated_at ?? 0;
    const days = same.map((row) => dayWords(startOf(row), now));
    const distinctDays = new Set(days).size === same.length;
    same.forEach((row, i) => {
      const at = startOf(row);
      out.set(row._id, distinctDays ? days[i] : clockWords(at));
    });
  }
  return out;
}
