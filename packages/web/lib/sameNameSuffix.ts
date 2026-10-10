// Rows in one list that read the same name ("Decline dinner invitation" twice)
// keep the time column every row has. Only when two of them would also show
// the same column text (both "Yesterday") does a muted distinguisher follow
// the title, computed where the list is built and never stored: when each
// began, said in a form the column is not (the day, else the clock, else the
// date and clock). Rows told apart by their column get nothing.

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

/** A hosted row's time column: "now" within the minute, else dayWords. The
 *  rail, To-dos and Notes read it (lib/sessionCard formatRowTime). */
export function hostedRowTime(at: number | null | undefined, now: number): string {
  if (!at) return "";
  if (now - at < 60_000) return "now";
  return dayWords(at, now);
}

type SuffixRow = { _id: string; started_at?: number; _creationTime?: number; updated_at?: number };

/** id -> suffix for every row whose title and time column another row in
 *  `rows` shares. `columnOf` is the row's time column (hostedRowTime of its
 *  updated_at by default). */
export function sameNameSuffixes<T extends SuffixRow>(
  rows: readonly T[],
  titleOf: (row: T) => string,
  now = Date.now(),
  columnOf: (row: T) => string = (row) => hostedRowTime(row.updated_at, now),
): Map<string, string> {
  const titles = new Map<string, T[]>();
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const title = titleOf(row).trim().toLowerCase();
    if (!title) continue;
    const same = titles.get(title);
    if (same) same.push(row);
    else titles.set(title, [row]);
  }
  for (const [title, namesakes] of titles) {
    if (namesakes.length < 2) continue;
    for (const row of namesakes) {
      const key = `${title}\u0000${columnOf(row)}`;
      const same = groups.get(key);
      if (same) same.push(row);
      else groups.set(key, [row]);
    }
  }
  const out = new Map<string, string>();
  const startOf = (row: T) => row.started_at ?? row._creationTime ?? row.updated_at ?? 0;
  for (const same of groups.values()) {
    if (same.length < 2) continue;
    const column = columnOf(same[0]);
    const forms = [
      (at: number) => dayWords(at, now),
      clockWords,
      (at: number) => `${new Date(at).toLocaleDateString([], { month: "short", day: "numeric" })}, ${clockWords(at)}`,
    ];
    // The first form that tells every namesake apart and never repeats the column.
    let pick: string[] = [];
    for (const form of forms) {
      pick = same.map((row) => form(startOf(row)));
      if (new Set(pick).size === pick.length && !pick.includes(column)) break;
    }
    same.forEach((row, i) => out.set(row._id, pick[i]));
  }
  return out;
}
