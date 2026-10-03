// The week edition's arithmetic (docs/proposals/changes-page.md 3, level 4):
// ISO week keys, and the facts a week reads off its seven day editions and
// their stories. Pure, so Convex's week build and the web's week view agree on
// every count, ledger line and ranking.
import { personKey } from "./people";

const WEEK_KEY = /^(\d{4})-W(\d{2})$/;
const DAY = 86_400_000;

const ymd = (t: number) => new Date(t).toISOString().slice(0, 10);
const utc = (day: string) => Date.parse(`${day}T00:00:00Z`);

/** The ISO week a YYYY-MM-DD falls in, `2026-W40`. */
export function isoWeekOf(day: string): string {
  const d = new Date(utc(day));
  const weekday = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - weekday);
  const jan1 = Date.UTC(d.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((d.getTime() - jan1) / DAY + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/** The Monday of an ISO week, YYYY-MM-DD, or null when the week is malformed or its year has no such week. */
export function weekMonday(week: string): string | null {
  const m = WEEK_KEY.exec(week);
  if (!m) return null;
  const jan4 = Date.UTC(Number(m[1]), 0, 4);
  const firstMonday = jan4 - ((new Date(jan4).getUTCDay() || 7) - 1) * DAY;
  const monday = ymd(firstMonday + (Number(m[2]) - 1) * 7 * DAY);
  // W00, or W53 of a 52 week year, rolls into a neighbouring year's week.
  return isoWeekOf(monday) === week ? monday : null;
}

/** The seven days of an ISO week, Monday to Sunday, or null when the week is malformed. */
export function weekDates(week: string): string[] | null {
  const monday = weekMonday(week);
  if (!monday) return null;
  return Array.from({ length: 7 }, (_, i) => ymd(utc(monday) + i * DAY));
}

/** Stories a week edition leads with (spec 3). */
export const WEEK_TOP_STORIES = 5;

export type WeekRelease = { surface: string; version?: string; sha: string; at: number };

export type LedgerLine = {
  surface: string;
  /** Ships of the surface this week. */
  count: number;
  /** The first and last ship's name: a version, else a short sha. */
  first: string;
  last: string;
  /** When the last one went out. */
  at: number;
};

const shipName = (r: WeekRelease) => r.version ?? r.sha.slice(0, 7);

/**
 * The week's release ledger: one line per surface, its first and last ship
 * and how many went out. Ships seen twice (a day edition lists the ships of
 * its own day only, but a rebuild can repeat one) count once.
 */
export function releaseLedger(releases: readonly WeekRelease[]): LedgerLine[] {
  const bySurface = new Map<string, Map<string, WeekRelease>>();
  for (const r of releases) {
    const ships = bySurface.get(r.surface) ?? new Map<string, WeekRelease>();
    ships.set(r.sha, r);
    bySurface.set(r.surface, ships);
  }
  return [...bySurface.entries()]
    .map(([surface, ships]) => {
      const list = [...ships.values()].sort((a, b) => a.at - b.at || a.sha.localeCompare(b.sha));
      return { surface, count: list.length, first: shipName(list[0]), last: shipName(list[list.length - 1]), at: list[list.length - 1].at };
    })
    .sort((a, b) => b.count - a.count || b.at - a.at || a.surface.localeCompare(b.surface));
}

/** "cli 1.1.157 to 1.1.163, 7 releases", or "backend 3250f11, 1 release". */
export function ledgerLabel(line: LedgerLine): string {
  const span = line.count > 1 && line.first !== line.last ? `${line.first} to ${line.last}` : line.last;
  return `${line.surface} ${span}, ${line.count} ${line.count === 1 ? "release" : "releases"}`;
}

/** The story fields the week reads: its facts and its (already gated) text. */
export type WeekStoryFacts = {
  story_key: string;
  area: string;
  importance: number;
  insertions: number;
  deletions: number;
  area_counts: Record<string, number>;
};

export type AreaTotal = { area: string; stories: number; files: number };

/** Per area over the week: the stories it leads and the files its commits touched, busiest first. */
export function weekAreaTotals(stories: readonly WeekStoryFacts[]): AreaTotal[] {
  const totals = new Map<string, AreaTotal>();
  const at = (area: string) => {
    let t = totals.get(area);
    if (!t) totals.set(area, (t = { area, stories: 0, files: 0 }));
    return t;
  };
  for (const s of stories) {
    at(s.area).stories += 1;
    for (const [area, files] of Object.entries(s.area_counts)) at(area).files += files;
  }
  return [...totals.values()].sort((a, b) => b.files - a.files || b.stories - a.stories || a.area.localeCompare(b.area));
}

/** Heaviest first: importance, then lines, then key, as the day edition ranks. */
export function byStoryWeight(a: WeekStoryFacts, b: WeekStoryFacts): number {
  return b.importance - a.importance || b.insertions + b.deletions - (a.insertions + a.deletions) || a.story_key.localeCompare(b.story_key);
}

/** The week's biggest stories before an editor picks: the heaviest five. */
export function topWeekStories<T extends WeekStoryFacts>(stories: readonly T[], n = WEEK_TOP_STORIES): T[] {
  return [...stories].sort(byStoryWeight).slice(0, n);
}

export type WeekStats = { commits: number; stories: number; releases: number; people: number; sessions: number; private_sessions: number };

type DayStats = Omit<WeekStats, "people">;

/**
 * The week's counts: the day editions' counts summed, and people counted once
 * across the week from the stories' commit authors, by personKey (a day's count cannot be
 * summed: the same person works every day).
 */
export function weekStats(days: ReadonlyArray<DayStats | null | undefined>, authors: Iterable<string>, releases: number): WeekStats {
  const people = new Set([...authors].map((a) => personKey(a)).filter(Boolean)).size;
  const out: WeekStats = { commits: 0, stories: 0, releases, people, sessions: 0, private_sessions: 0 };
  for (const d of days) {
    if (!d) continue;
    out.commits += d.commits;
    out.stories += d.stories;
    out.sessions += d.sessions;
    out.private_sessions += d.private_sessions;
  }
  return out;
}
