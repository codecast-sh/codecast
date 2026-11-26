"use client";
// The Deploys page's "On its way" (docs/architecture/changes.md CH4): every
// change of a target's repository not yet live, on the lifecycle grid, beside
// the commits already waiting on main. Its own filters narrow it: the
// viewer's own (Mine) and one group, picked here or by the group's name.
import { ChangeBoard } from "./ChangeBoard";
import { PICKABLE_GROUPS, groupName } from "../../lib/changes/rows";
import type { DeployFilters } from "../../lib/deploys/focus";
import { HIDE, type OnItsWayModel } from "../../hooks/useOnItsWay";

type Filters = DeployFilters["coming"];

export function OnItsWay({ model, filters, onFilters }: { model: OnItsWayModel; filters: Filters; onFilters: (f: Filters) => void }) {
  const { ready, focused, shown, counts, coming } = model;
  if (ready && !coming) return null;
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
        empty={!ready ? "Reading what is on its way…" : filters.group ? `Nothing ${filters.mine ? "of yours " : ""}in ${groupName(filters.group, filters.mine)}` : filters.mine ? "None of yours" : "Nothing on its way"}
      />
    </section>
  );
}
