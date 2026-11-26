"use client";
// The Deploys page's "On its way" (docs/architecture/changes.md CH4): every
// change of a target's repository not yet live, on the lifecycle grid, beside
// the commits already waiting on main. Its own filters narrow it: the
// viewer's own (Mine) and one group, picked here or by the group's name.
import { useMemo } from "react";
import { useRepoChanges } from "../../hooks/useRepoChanges";
import { ChangeBoard } from "./ChangeBoard";
import { PICKABLE_GROUPS, changeRowOf, filterChanges, groupName, groupOf, isComing, isParked, type ChangeRow, type ChangeViewer } from "../../lib/changes/rows";
import { changeMatches, type DeployFilters, type DeployFocus } from "../../lib/deploys/focus";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { useChangesSetAside, withSetAside } from "../../hooks/useChangesSetAside";

const HIDE = ["live", "closed"] as const;

type Filters = DeployFilters["coming"];

export function OnItsWay({ repository, filters, onFilters, me, focus }: {
  repository: string;
  filters: Filters;
  onFilters: (f: Filters) => void;
  me: ChangeViewer;
  focus: DeployFocus | null;
}) {
  const { ready, changes } = useRepoChanges(repository);
  // What has landed waits on main, listed beside it by session: this grid is what has yet to get there.
  const { marks, setAside } = useChangesSetAside(repository);
  const rows = useMemo(() => withSetAside(changes.map(changeRowOf).filter((r) => !r.reach_ref), repository, marks), [changes, repository, marks]);
  const now = useCoarseNow(600_000);
  // A filter never hides the row a link points at.
  const focused = useMemo(() => (focus ? (r: ChangeRow) => changeMatches(r, focus) : undefined), [focus]);
  const shown = useMemo(() => filterChanges(rows, filters, me, now, focused), [rows, filters, me, now, focused]);
  // Each group's count under Mine alone, so a group's button says what pressing it shows.
  const counts = useMemo(() => {
    const mineRows = filterChanges(rows, { mine: filters.mine, group: null }, me, now, focused);
    return new Map(PICKABLE_GROUPS.map((id) => [id, mineRows.filter((r) => groupOf(r, now) === id).length]));
  }, [rows, filters.mine, me, now, focused]);
  // What is really on its way: not live, not closed, and not parked.
  const coming = rows.filter((r) => isComing(r) && !isParked(r, now)).length;
  // A change set aside keeps the grid on screen, so its Parked row can still be brought back.
  if (ready && !coming && !rows.some((r) => r.set_aside)) return null;
  const pickGroup = (group: Filters["group"]) => onFilters({ ...filters, group });
  return (
    <section className="dpp-sec" data-deploy-on-its-way>
      <h3>On its way{coming ? <span className="dpp-num">{coming} {coming === 1 ? "change" : "changes"}</span> : null}</h3>
      <div className="dpp-filters" data-deploy-filters="coming">
        <button type="button" className="dpp-mine" aria-pressed={filters.mine} onClick={() => onFilters({ ...filters, mine: !filters.mine })} aria-label="Only my changes" data-deploy-mine="coming">Mine</button>
        <span className="dpp-labels" role="group" aria-label="Group shown" data-deploy-groups>
          {PICKABLE_GROUPS.map((id) => (
            <button key={id} type="button" aria-pressed={filters.group === id} onClick={() => pickGroup(filters.group === id ? null : id)} data-deploy-group-pick={id}>
              {groupName(id, filters.mine)}<span className="dpp-pick-n">{counts.get(id) ?? 0}</span>
            </button>
          ))}
        </span>
      </div>
      <ChangeBoard
        rows={shown}
        hideGroups={HIDE}
        mine={filters.mine}
        pick={{ group: filters.group, onPick: pickGroup }}
        focused={focused}
        onSetAside={setAside}
        empty={!ready ? "Reading what is on its way…" : filters.group ? `Nothing ${filters.mine ? "of yours " : ""}in ${groupName(filters.group, filters.mine)}` : filters.mine ? "None of yours" : "Nothing on its way"}
      />
    </section>
  );
}
