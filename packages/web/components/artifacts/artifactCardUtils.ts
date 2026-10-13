// Pure helpers for the artifact gallery cards — kept free of React imports so
// unit tests can exercise them without the component graph.

export function relativeTime(ts?: number | null): string | null {
  if (!ts) return null;
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(mo / 12)}y ago`;
}

// The owner edit link: ?edit=1 must be a QUERY param (cache-key-relevant,
// forwarded to origin) while the #o= owner key stays in the fragment (never
// sent to servers/logs) — so insert the param before the hash.
export function withEditParam(manageUrl: string): string {
  const hashAt = manageUrl.indexOf("#");
  if (hashAt === -1) return `${manageUrl}?edit=1`;
  return `${manageUrl.slice(0, hashAt)}?edit=1${manageUrl.slice(hashAt)}`;
}

// Gallery ordering and the timeline's day groups.
export type PageSort = "updated" | "published" | "views" | "title";

type Sortable = { title: string; slug: string; created_at: number; updated_at: number; views: number };

/** The moment a page sits at: its first publish when sorting by that, else its
 *  last update. */
export function pageTime(a: Sortable, sort: PageSort): number {
  return sort === "published" ? a.created_at : a.updated_at;
}

export function sortPages<T extends Sortable>(rows: T[], sort: PageSort): T[] {
  const byTime = (a: T, b: T) => pageTime(b, sort) - pageTime(a, sort);
  const cmp =
    sort === "views" ? (a: T, b: T) => b.views - a.views || byTime(a, b)
    : sort === "title" ? (a: T, b: T) => (a.title || a.slug).localeCompare(b.title || b.slug)
    : byTime;
  return [...rows].sort(cmp);
}

const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

export function dayLabel(ts: number, now = Date.now()): string {
  const d = new Date(ts);
  const today = new Date(now);
  if (dayKey(d) === dayKey(today)) return "Today";
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (dayKey(d) === dayKey(yesterday)) return "Yesterday";
  if (now - ts < 6 * 86_400_000) return d.toLocaleDateString([], { weekday: "long" });
  return d.toLocaleDateString([], {
    month: "short",
    day: "numeric",
    ...(d.getFullYear() !== today.getFullYear() ? { year: "numeric" } : {}),
  });
}

/** The timeline: one group per calendar day, newest day first; inside a day
 *  the chosen sort decides (views and title keep their order, the time sorts
 *  run newest first). */
export function groupByDay<T extends Sortable>(rows: T[], sort: PageSort, now = Date.now()) {
  const timeSort: PageSort = sort === "published" ? "published" : "updated";
  const days = new Map<string, { key: string; label: string; at: number; rows: T[] }>();
  for (const a of rows) {
    const at = pageTime(a, timeSort);
    const key = dayKey(new Date(at));
    const day = days.get(key) ?? { key, label: dayLabel(at, now), at, rows: [] };
    day.at = Math.max(day.at, at);
    day.rows.push(a);
    days.set(key, day);
  }
  return [...days.values()]
    .sort((a, b) => b.at - a.at)
    .map((d) => ({ ...d, rows: sortPages(d.rows, sort) }));
}
