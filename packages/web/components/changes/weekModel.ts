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
import { releaseLedger, statsHeadline, topWeekStories, weekStats, WEEK_TOP_STORIES, type LedgerLine } from "@codecast/shared/changes";
import type { EditionRow, LiveRow, StoryRow } from "../../hooks/useSyncChanges";
import { areaTouches, dayStats, inFocus, showingLine, storiesOfDay, survives, waitingKeys, type AreaTouch, type EditionStats } from "./editionModel";
import type { ChangesUrl } from "./useChangesUrlState";

export type WeekDayLine = { date: string; headline: string; prose: boolean; commits: number; quiet: boolean };

export type WeekModel = {
  /** The week's stories under the branch toggle, before filters. */
  stories: StoryRow[];
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
};

const PROSE_STATUSES = new Set(["written", "final"]);
const hasProse = (e: EditionRow | undefined) => !!e?.headline && PROSE_STATUSES.has(e.status ?? "");

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
  personName?: (id: string) => string;
}): WeekModel {
  const { days, url, week } = input;
  const perDay = days.map((date) => {
    const edition = input.editions.find((e) => e.scope === "day" && e.date === date);
    const stories = storiesOfDay(input.stories, date, url.branches);
    return { date, edition, stories, stats: dayStats(stories, edition, edition?.releases ?? []) };
  });
  const stories = perDay.flatMap((d) => d.stories);
  const ledger = releaseLedger(perDay.flatMap((d) => d.edition?.releases ?? []));
  const stats = weekStats(perDay.map((d) => d.stats), stories.flatMap((s) => s.author_names), ledger.reduce((n, l) => n + l.count, 0));

  const waiting = waitingKeys(stories, input.live ?? []);
  const pool = stories.filter((s) => inFocus(s, url) && survives(s, url, waiting));

  // The editor's pick first, then the heaviest of the rest, five in all.
  const byKey = new Map(pool.map((s) => [s.story_key, s]));
  const picked = (week?.top_story_keys ?? []).map((k) => byKey.get(k)).filter((s): s is StoryRow => !!s);
  const rest = topWeekStories(pool.filter((s) => !picked.includes(s)), WEEK_TOP_STORIES);
  const top = [...picked, ...rest].slice(0, WEEK_TOP_STORIES);

  const prose = hasProse(week);
  return {
    stories,
    headline: prose ? week!.headline! : statsHeadline(stats),
    prose,
    standfirst: prose && week!.narrative.trim() ? week!.narrative.trim() : null,
    stats,
    top,
    order: top.map((s) => s.story_key),
    matching: pool.length,
    filterLine: showingLine(url, pool.length, stories.length, input.personName),
    ledger,
    areas: areaTouches(stories),
    days: perDay.map((d) => ({
      date: d.date,
      headline: hasProse(d.edition) ? d.edition!.headline! : statsHeadline(d.stats),
      prose: hasProse(d.edition),
      commits: d.stats.commits,
      quiet: d.stats.stories === 0 && !d.edition,
    })),
  };
}
