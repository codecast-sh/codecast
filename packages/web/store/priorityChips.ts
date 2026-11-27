// The inbox filter's Top 3 / 5 / 10 (`pr:<n>` keys on the folder chip axis,
// store/workProjects): which rank a session holds among the viewer's
// priorities, read the way the Priorities view reads it (store/priorityOrder).
// A leaf beside inboxStore: types only from there, so no import cycle.
import type { InboxSession, ProjectFilterTerm } from "./inboxStore";
import { priorityPlaceReader, sessionPriorityOf, type PriorityOrderState } from "./priorityOrder";
import { PRIORITY_TOP_NS, priorityChipKey, priorityChipKeysOf, priorityTopNOfChipKey, projectAxisNoun } from "./workProjects";

/** A session's rank among the viewer's priorities in the active workspace, or null. */
export type PriorityRankOf = (s: { _id: string }) => number | null;

/** The rank resolver off a store snapshot: the Priorities view's own reader
 *  (store/priorityOrder), kept to the active workspace's live priority rows,
 *  so "Top 3" is the three priorities that view puts first. The reader's
 *  fallback to `priorityRanks` is left out: those ranks are fed only while
 *  the view is up, so outside it they can name a priority that has left. */
export function priorityRankOfFromState(state: PriorityOrderState): PriorityRankOf {
  const placeOf = priorityPlaceReader(state);
  return (s) => {
    const place = placeOf(s);
    if (!place || place.workspace) return null;
    const link = sessionPriorityOf(state.sessions?.[s._id] ?? (s as Parameters<typeof sessionPriorityOf>[0]));
    return link && state.priorities?.[link.priorityId] ? place.rank : null;
  };
}

/** The rank resolver only while a `pr:` term is in the filter: building it
 *  reads every priority, and most filters never ask. */
export function priorityRankOfForFilters(state: PriorityOrderState, terms: readonly ProjectFilterTerm[]): PriorityRankOf | undefined {
  return terms.some((t) => priorityTopNOfChipKey(t.id) != null) ? priorityRankOfFromState(state) : undefined;
}

/** A card's rank for whether the menus offer Top N: the best rank among the
 *  card and every session nested under it (workers, and a role's riders,
 *  which chipFilterSection can show in the card's place), so the section
 *  appears whenever some filter would show something. */
export function cardPriorityRankOf(
  rankOf: PriorityRankOf,
  subsByParent: ReadonlyMap<string, readonly InboxSession[]>,
): PriorityRankOf {
  const best = (row: { _id: string }, seen: Set<string>): number | null => {
    if (seen.has(row._id)) return null;
    seen.add(row._id);
    let rank = rankOf(row);
    for (const sub of subsByParent.get(row._id) ?? []) {
      const r = best(sub, seen);
      if (r != null && (rank == null || r < rank)) rank = r;
    }
    return rank;
  };
  return (row) => best(row, new Set());
}

/** The Top 3 / 5 / 10 rows the menus offer, each with how many of `rows`
 *  rank there; none when no row does, so the menus leave the section out.
 *  The menus show no count on these rows (workProjects axisKeyShowsCount). */
export function priorityChipRows(rows: readonly { _id: string }[], rankOf: PriorityRankOf | undefined): Array<[string, number]> {
  if (!rankOf) return [];
  const counts = new Map<string, number>();
  for (const row of rows) for (const key of priorityChipKeysOf(rankOf(row))) counts.set(key, (counts.get(key) ?? 0) + 1);
  return counts.size ? PRIORITY_TOP_NS.map((n) => [priorityChipKey(n), counts.get(priorityChipKey(n)) ?? 0]) : [];
}

/** The Top N rows a menu lists: the offered ones, or all three while a Top N
 *  term is in the filter and nothing ranks there now, so it can be undone. */
export function priorityMenuRows(offered: Array<[string, number]>, terms: readonly ProjectFilterTerm[]): Array<[string, number]> {
  if (offered.length || !terms.some((t) => projectAxisNoun(t.id) === "priority")) return offered;
  return PRIORITY_TOP_NS.map((n) => [priorityChipKey(n), 0]);
}
