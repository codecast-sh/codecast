// What the Deploys page's "On its way" grid shows, read once for the page: the grid draws it, and the page's focus
// chip says where a linked change stands from the same read (components/changes/OnItsWay draws it).
import { useMemo } from "react";
import { useRepoChanges } from "./useRepoChanges";
import { useCoarseNow } from "./useCoarseNow";
import { PICKABLE_GROUPS, changeRowOf, filterChanges, groupOf, isComing, isParked, type ChangeRow, type ChangeViewer } from "../lib/changes/rows";
import { changeMatches, type DeployFilters, type DeployFocus } from "../lib/deploys/focus";

export const HIDE = ["live", "closed"] as const;

/** Where a linked change stands on its way: moving toward main, parked there, not read yet, or not drawn in this grid. */
export type FocusComing = "coming" | "parked" | "reading" | null;

type Filters = DeployFilters["coming"];

/** The grid's rows as filtered, each group's count, how many are really coming, and where a linked change stands. */
export type OnItsWayModel = {
  ready: boolean;
  focused: ((r: ChangeRow) => boolean) | undefined;
  shown: ChangeRow[];
  counts: Map<string, number>;
  coming: number;
  found: FocusComing;
};

/**
 * Every change of a repository not yet live, read once for the page: the grid draws it and the page's focus chip says
 * where a linked change stands from the same read. A null repository (a target that only records deploys) reads nothing.
 */
export function useOnItsWay(repository: string | null, filters: Filters, me: ChangeViewer, focus: DeployFocus | null): OnItsWayModel {
  const { ready, changes } = useRepoChanges(repository);
  // What has landed waits on main, listed beside it by session: this grid is what has yet to get there.
  const rows = useMemo(() => changes.map(changeRowOf).filter((r) => !r.reach_ref), [changes]);
  const now = useCoarseNow(600_000);
  // A filter never hides the row a link points at.
  const focused = useMemo(() => (focus ? (r: ChangeRow) => changeMatches(r, focus) : undefined), [focus]);
  const shown = useMemo(() => filterChanges(rows, filters, me, now, focused), [rows, filters, me, now, focused]);
  // Each group's count under Mine alone, so a group's button says what pressing it shows.
  const counts = useMemo(() => {
    const mineRows = filterChanges(rows, { mine: filters.mine, group: null }, me, now, focused);
    return new Map<string, number>(PICKABLE_GROUPS.map((id) => [id, mineRows.filter((r) => groupOf(r, now) === id).length]));
  }, [rows, filters.mine, me, now, focused]);
  // What is really on its way: not live, not closed, and not parked.
  const coming = rows.filter((r) => isComing(r) && !isParked(r, now)).length;
  // A linked row counts where the grid draws it, by the group it draws it in: parked, or any group it shows; a live or
  // closed one is hidden, and with nothing coming the grid draws nothing.
  const group = focused && coming ? shown.filter(focused).map((r) => groupOf(r, now)).find((g) => !!g && !HIDE.includes(g as (typeof HIDE)[number])) ?? null : null;
  const found: FocusComing = !focused || !repository ? null : !ready ? "reading" : !group ? null : group === "parked" ? "parked" : "coming";
  return { ready, focused, shown, counts, coming, found };
}

