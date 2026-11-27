// The inbox filter's Top 3 / 5 / 10 (`pr:<n>` keys on the folder chip axis,
// store/workProjects): which rank a session holds among the viewer's
// priorities, read the way the Priorities view reads it (store/priorityOrder).
// A leaf beside inboxStore: types only from there, so no import cycle.
import type { InboxSession, ProjectFilterTerm } from "./inboxStore";
import { priorityRanks, sessionPriorityOf, type PriorityOrderState } from "./priorityOrder";
import { PRIORITY_TOP_NS, priorityChipKey, priorityChipKeysOf, priorityTopNOfChipKey, projectAxisNoun } from "./workProjects";

/** A session's rank among the viewer's own priorities in that priority's workspace, or null. */
export type PriorityRankOf = (s: { _id: string }) => number | null;

/** The rank resolver off a store snapshot. A session ranks when it is linked
 *  to one of the viewer's own active priorities, in any workspace, at that
 *  priority's place among the viewer's priorities in its workspace
 *  (store/priorityOrder priorityRanks): ranks mean something only within one
 *  workspace, so Top 3 is the top three of each. A teammate's priority (a
 *  session started on one) never counts. Ranks come from the live
 *  `priorities` rows, which hold every workspace; `priorityRanks` is left
 *  out: those ranks are fed only while the Priorities view is up, so outside
 *  it they can name a priority that has left. */
export function priorityRankOfFromState(state: PriorityOrderState): PriorityRankOf {
  const viewer = state.currentUser?._id ? String(state.currentUser._id) : null;
  const ranks = priorityRanks(state.priorities);
  return (s) => {
    const link = sessionPriorityOf(state.sessions?.[s._id] ?? (s as Parameters<typeof sessionPriorityOf>[0]));
    const row = link ? state.priorities?.[link.priorityId] : undefined;
    if (!row || !viewer || String(row.user_id) !== viewer || row.status !== "active") return null;
    return ranks.get(String(row._id)) ?? null;
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
