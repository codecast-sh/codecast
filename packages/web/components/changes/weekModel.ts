// The shape of one week edition (spec 3, level 4), worked out from store rows.
// Pure: the page hands in the week's days, their day editions and stories, and
// the week row, and gets back what to paint. Every fact is read off the day
// editions and stories with the same shared helpers the server's week build
// uses, so a week paints whole before its row arrives; the row adds the
// editor's headline, standfirst and choice of the five biggest stories.
//
// Filters never rewrite prose, here as on the day. The week has no section
// blocks whose shape dimming would keep, so every filter narrows the biggest
// stories to those it matches; the head, the ledger and the day lines stay.
import { releaseLedger, topWeekStories, weekStats, WEEK_TOP_STORIES, type LedgerLine } from "@codecast/shared/changes";
import type { EditionRow, LiveRow, StoryRow } from "../../hooks/useSyncChanges";
import type { RosterIdentity } from "../../hooks/useTeamRoster";
import { areaTouches, dayStats, echoesHeadline, editionHeadline, hasProse, inFocus, nameOfPerson, peopleOf, personFor, showingLine, storiesOfDay, survives, waitingKeys, type AreaTouch, type EditionStats, type Person } from "./editionModel";
import type { ChangesUrl } from "./useChangesUrlState";

export type WeekDayLine = { date: string; headline: string; prose: boolean; commits: number; stories: number; quiet: boolean };

export type WeekModel = {
  /** The week's stories under the branch toggle, before filters. */
  stories: StoryRow[];
  /** Everyone behind `stories`, by name. */
  people: Person[];
  /** Commits on main the day editions and stories count now, to tell week notes written from fewer. */
  mainCommits: number;
  /** The same, day by day. */
  mainByDay: Record<string, number>;
  headline: string;
  /** The headline and standfirst are the week edition's prose, not the stats line. */
  prose: boolean;
  standfirst: string | null;
  stats: EditionStats;
  /** The week's biggest stories matching the filters, the editor's pick first. */
  top: StoryRow[];
  /** story_key of every story j/k visits, in reading order. */
  order: string[];
  /** Stories matching every filter. */
  matching: number;
  /** "Showing 3 of 41 stories (cli)" while a filter is on. */
  filterLine: string | null;
  ledger: LedgerLine[];
  areas: AreaTouch[];
  /** One line per day so far, Monday first. */
  days: WeekDayLine[];
  /** The top story's headline repeats the week headline, so its card opens with its dek. */
  leadEchoesHeadline: boolean;
};

export function buildWeek(input: {
  /** The week's days that have begun, Monday first. */
  days: readonly string[];
  stories: readonly StoryRow[];
  /** Day editions; any outside the week are ignored. */
  editions: readonly EditionRow[];
  week: EditionRow | undefined;
  url: ChangesUrl;
  /** The live strip, for the waiting filter. */
  live?: readonly LiveRow[];
  roster?: readonly RosterIdentity[];
  personName?: (id: string) => string;
}): WeekModel {
  const { days, url, week } = input;
  const perDay = days.map((date) => {
    const edition = input.editions.find((e) => e.scope === "day" && e.date === date);
    const stories = storiesOfDay(input.stories, date, url.branches);
    const releases = edition?.releases ?? [];
    const main = url.branches === "main" ? stories : storiesOfDay(input.stories, date, "main");
    return { date, edition, stories, stats: dayStats(stories, edition, releases, url.branches), mainCommits: dayStats(main, edition, releases).commits };
  });
  const stories = perDay.flatMap((d) => d.stories);
  const ledger = releaseLedger(perDay.flatMap((d) => d.edition?.releases ?? []));
  const people = peopleOf(stories, input.roster);
  // The header counts the people the person chips show, as the day does.
  const stats = { ...weekStats(perDay.map((d) => d.stats), stories.flatMap((s) => s.author_names), ledger.reduce((n, l) => n + l.count, 0)), people: people.length };

  const waiting = waitingKeys(stories, input.live ?? []);
  const person = url.person ? personFor(url.person, people) : null;
  const pool = stories.filter((s) => inFocus(s, url) && survives(s, url, waiting, person));

  // The editor's pick first, then the heaviest of the rest, five in all.
  const byKey = new Map(pool.map((s) => [s.story_key, s]));
  const picked = (week?.top_story_keys ?? []).map((k) => byKey.get(k)).filter((s): s is StoryRow => !!s);
  const rest = topWeekStories(pool.filter((s) => !picked.includes(s)), WEEK_TOP_STORIES);
  const top = [...picked, ...rest].slice(0, WEEK_TOP_STORIES);

  const prose = hasProse(week);
  return {
    stories,
    people,
    mainCommits: perDay.reduce((n, d) => n + d.mainCommits, 0),
    mainByDay: Object.fromEntries(perDay.map((d) => [d.date, d.mainCommits])),
    headline: editionHeadline(week, stats),
    prose,
    standfirst: prose && week!.narrative.trim() ? week!.narrative.trim() : null,
    stats,
    top,
    order: top.map((s) => s.story_key),
    matching: pool.length,
    filterLine: showingLine(url, pool.length, stories.length, nameOfPerson(people, input.personName)),
    ledger,
    areas: areaTouches(stories),
    days: perDay.map((d) => ({
      date: d.date,
      headline: editionHeadline(d.edition, d.stats),
      prose: hasProse(d.edition),
      commits: d.stats.commits,
      stories: d.stats.stories,
      quiet: d.stats.stories === 0 && !d.edition,
    })),
    leadEchoesHeadline: prose && !!top[0] && echoesHeadline(top[0].headline, week!.headline!),
  };
}

/** What the week's written notes stand on, for the header and the footer. */
export type WeekNotes = {
  /** Commits on main, and team sessions, the notes were written from. */
  written: number;
  sessions: number;
  /** Commits on main in the week's ended days now. */
  ended: number;
  /** Commits on main today now; null for a week that is over. */
  today: number | null;
  /** How many of today's commits the notes hold, known while no ended day has moved since they were written. */
  todayIn: number | null;
  /** When a day that has ended moved after the notes were written: they wait to be rewritten since then. */
  staleSince: number | null;
};

/**
 * The basis of a week's written notes, or null while it has none. A week is
 * rebuilt only after one of its days ends, and the build reads all seven
 * days, today's commits so far included; a rebuild that finds nothing new
 * leaves the notes as they were. So new commits today never make the notes
 * stale. They are stale when an ended day's edition moved (was rewritten, or
 * marked for a rewrite) after them and the week's count is no longer the one
 * they were written from; the earliest such move is when they went stale.
 * While no ended day has moved, the ended days are as the notes saw them, and
 * the rest of the notes' count is today's commits they hold.
 */
export function weekNotes(model: Pick<WeekModel, "days" | "mainByDay">, row: EditionRow | undefined, dayEditions: readonly EditionRow[], today: string): WeekNotes | null {
  if (!row?.stats || (row.status !== "written" && row.status !== "final")) return null;
  const ended = model.days.filter((d) => d.date < today);
  const endedCommits = ended.reduce((n, d) => n + (model.mainByDay[d.date] ?? 0), 0);
  let moved: number | null = null;
  for (const d of ended) {
    const e = dayEditions.find((x) => x.scope === "day" && x.date === d.date);
    for (const t of [e?.generated_at, e?.dirty_since]) if (t != null && t > row.generated_at && (moved == null || t < moved)) moved = t;
  }
  const current = model.days.some((d) => d.date === today);
  const todayNow = current ? model.mainByDay[today] ?? 0 : null;
  const written = row.stats.commits;
  return {
    written,
    sessions: row.stats.sessions,
    ended: endedCommits,
    today: todayNow,
    todayIn: todayNow != null && moved == null ? Math.min(todayNow, Math.max(0, written - endedCommits)) : null,
    staleSince: moved != null && written !== endedCommits + (todayNow ?? 0) ? moved : null,
  };
}
