// The Changes timeline as data: one entry per day that has stories, newest
// first, with a finished week's notes where the timeline enters that week.
// The week in progress has none: its notes only restate its newest day.
// Pure, so the page and its tests share it.
import { isoWeekOf, topWeekStories, weekDates } from "@codecast/shared/changes";
import type { EditionRow, StoryRow } from "../../hooks/useSyncChanges";
import { byWeight, hasProse, inFocus, survives, type Person, type Ship } from "./editionModel";
import type { ChangesUrl } from "./useChangesUrlState";

export type TimelineDay = {
  kind: "day";
  date: string;
  /** The edition's one sentence about the day, once written. */
  summary: string | null;
  /** The day's stories that read as news, heaviest first. */
  stories: StoryRow[];
  /** Housekeeping (the edition's brief list, else importance 1), folded under one line. */
  small: StoryRow[];
  releases: Ship[];
  /** Stories on the day before the filters: the filtered count reads against it. */
  total: number;
};

export type TimelineWeek = {
  kind: "week";
  week: string;
  headline: string;
  /** The week told in a few sentences: what shipped and what it adds up to. */
  summary: string | null;
  /** The week's stories a teammate most needs to read, heaviest first. */
  top: string[];
};

export type TimelineItem = TimelineDay | TimelineWeek;

/** Housekeeping: the edition named it brief, or, before the edition, the story itself ranks it lowest. */
function isSmall(s: StoryRow, brief: ReadonlySet<string> | null): boolean {
  return brief ? brief.has(s.story_key) : s.importance <= 1;
}

export function buildTimeline(input: {
  stories: readonly StoryRow[];
  editions: readonly EditionRow[];
  weeks: readonly EditionRow[];
  url: ChangesUrl;
  person: Person | null;
  /** The team's today: its week is still being written, so it has no divider. */
  today: string;
  /** A week already shown above the timeline, so it gets no divider of its own. */
  skipWeek?: string;
}): TimelineItem[] {
  const { url, person } = input;
  const byDate = new Map<string, StoryRow[]>();
  for (const s of input.stories) {
    if (url.branches !== "all" && !s.on_default_branch) continue;
    const day = byDate.get(s.date) ?? [];
    day.push(s);
    byDate.set(s.date, day);
  }
  const editionOf = new Map(input.editions.map((e) => [e.date, e]));
  const summaries = new Set(input.editions.filter((e) => hasProse(e)).map((e) => e.headline!));
  const weekOf = new Map(finishedWeeks(input.weeks, input.today).filter((w) => !summaries.has(w.headline)).map((w) => [w.week, w]));

  const out: TimelineItem[] = [];
  let lastWeek: string | null = null;
  for (const date of [...byDate.keys()].sort().reverse()) {
    const all = byDate.get(date)!;
    const shown = all.filter((s) => inFocus(s, url) && survives(s, url, person)).sort(byWeight);
    if (!shown.length) continue;
    const week = isoWeekOf(date);
    if (week !== lastWeek) {
      lastWeek = week;
      const notes = weekOf.get(week);
      if (notes && notes.week !== input.skipWeek) out.push(notes);
    }
    const edition = editionOf.get(date);
    const brief = edition && hasProse(edition) && edition.brief_story_keys ? new Set(edition.brief_story_keys) : null;
    out.push({
      kind: "day",
      date,
      summary: edition && hasProse(edition) ? edition.headline! : null,
      stories: shown.filter((s) => !isSmall(s, brief)),
      small: shown.filter((s) => isSmall(s, brief)),
      releases: edition?.releases ?? [],
      total: all.length,
    });
  }
  return out;
}

/**
 * The finished weeks whose notes are written, newest first. The week in
 * progress has none: its notes only restate its newest day.
 */
export function finishedWeeks(weeks: readonly EditionRow[], today: string): TimelineWeek[] {
  const thisWeek = isoWeekOf(today);
  return weeks
    .filter((w) => hasProse(w) && w.date < thisWeek)
    .sort((a, b) => b.date.localeCompare(a.date))
    .map((w) => ({ kind: "week", week: w.date, headline: w.headline!, summary: w.narrative?.trim() || null, top: w.top_story_keys ?? [] }));
}

/** The week's picks that are still on the page, else (keys move when a day is rebuilt) its heaviest stories. */
export function weekTop(week: TimelineWeek, byKey: ReadonlyMap<string, StoryRow>): StoryRow[] {
  const picked = week.top.map((k) => byKey.get(k)).filter((s): s is StoryRow => !!s);
  if (picked.length) return picked;
  const days = new Set(weekDates(week.week) ?? []);
  return topWeekStories([...byKey.values()].filter((s) => days.has(s.date)));
}

/** The days the timeline shows, oldest last: what a "load earlier" reads to know it reached the fed range. */
export const timelineDates = (items: readonly TimelineItem[]) => items.filter((i): i is TimelineDay => i.kind === "day").map((d) => d.date);
