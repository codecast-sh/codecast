"use client";
// The Deploys page's "On its way" (docs/architecture/changes.md CH4): every
// change of a target's repository not yet live, on the lifecycle grid, beside
// the commits already waiting on main. The page's filters narrow it: the
// viewer's own (Mine) and one group, picked by its name.
import { useMemo } from "react";
import { useRepoChanges } from "../../hooks/useRepoChanges";
import { ChangeBoard } from "./ChangeBoard";
import { changeRowOf, filterChanges, isComing, isParked, type ChangeGroupId, type ChangeRow, type ChangeViewer } from "../../lib/changes/rows";
import { changeMatches, type DeployFilters, type DeployFocus } from "../../lib/deploys/focus";
import { useCoarseNow } from "../../hooks/useCoarseNow";

const HIDE = ["live", "closed"] as const;

export function OnItsWay({ repository, filters, me, focus, onPickGroup }: {
  repository: string;
  filters: DeployFilters;
  me: ChangeViewer;
  focus: DeployFocus | null;
  onPickGroup: (g: ChangeGroupId | null) => void;
}) {
  const { ready, changes } = useRepoChanges(repository);
  // What has landed waits on main, listed beside it by session: this grid is what has yet to get there.
  const rows = useMemo(() => changes.map(changeRowOf).filter((r) => !r.reach_ref), [changes]);
  const now = useCoarseNow(600_000);
  // A filter never hides the row a link points at.
  const focused = useMemo(() => (focus ? (r: ChangeRow) => changeMatches(r, focus) : undefined), [focus]);
  const shown = useMemo(() => filterChanges(rows, filters, me, now, focused), [rows, filters, me, now, focused]);
  // What is really on its way: not live, not closed, and not parked.
  const coming = rows.filter((r) => isComing(r) && !isParked(r, now)).length;
  if (ready && !coming) return null;
  return (
    <section className="dpp-sec" data-deploy-on-its-way>
      <h3>On its way{coming ? <span className="dpp-num">{coming} {coming === 1 ? "change" : "changes"}</span> : null}</h3>
      <ChangeBoard
        rows={shown}
        hideGroups={HIDE}
        mine={filters.mine}
        pick={{ group: filters.group, onPick: onPickGroup }}
        focused={focused}
        empty={!ready ? "Reading what is on its way…" : filters.mine ? "None of yours" : "Nothing on its way"}
      />
    </section>
  );
}
