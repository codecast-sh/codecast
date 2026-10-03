// The Changes timeline as data: one entry per day that has stories, newest
// first, with a week divider where the timeline crosses into a week whose
// edition has notes. Pure, so the page and its tests share it.
import { isoWeekOf } from "@codecast/shared/changes";
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

export type TimelineWeek = { kind: "week"; week: string; headline: string };

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
  const weekHeadline = new Map(input.weeks.filter((w) => hasProse(w)).map((w) => [w.date, w.headline!]));

  const out: TimelineItem[] = [];
  let lastWeek: string | null = null;
  for (const date of [...byDate.keys()].sort().reverse()) {
    const all = byDate.get(date)!;
    const shown = all.filter((s) => inFocus(s, url) && survives(s, url, person)).sort(byWeight);
    if (!shown.length) continue;
    const week = isoWeekOf(date);
    if (week !== lastWeek) {
      lastWeek = week;
      const headline = weekHeadline.get(week);
      if (headline) out.push({ kind: "week", week, headline });
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

/** The days the timeline shows, oldest last: what a "load earlier" reads to know it reached the fed range. */
export const timelineDates = (items: readonly TimelineItem[]) => items.filter((i): i is TimelineDay => i.kind === "day").map((d) => d.date);
