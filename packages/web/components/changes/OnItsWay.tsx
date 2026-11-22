"use client";
// The Deploys page's "On its way" (docs/architecture/changes.md CH4): every
// change of a target's repository not yet live, on the lifecycle grid, above
// the commits already waiting on main.
import { useMemo } from "react";
import { useRepoChanges } from "../../hooks/useRepoChanges";
import { ChangeBoard } from "./ChangeBoard";
import { changeRowOf, isComing, isParked } from "../../lib/changes/rows";
import { useCoarseNow } from "../../hooks/useCoarseNow";

const HIDE = ["live", "closed"] as const;

export function OnItsWay({ repository }: { repository: string }) {
  const { ready, changes } = useRepoChanges(repository);
  // What has landed waits on main, listed just below by session: this grid is what has yet to get there.
  const rows = useMemo(() => changes.map(changeRowOf).filter((r) => !r.reach_ref), [changes]);
  const now = useCoarseNow(600_000);
  // What is really on its way: not live, not closed, and not parked.
  const coming = rows.filter((r) => isComing(r) && !isParked(r, now)).length;
  if (ready && !coming) return null;
  return (
    <section className="dpp-sec" data-deploy-on-its-way>
      <h3>On its way{coming ? <span className="dpp-num">{coming} {coming === 1 ? "change" : "changes"}</span> : null}</h3>
      <ChangeBoard rows={rows} hideGroups={HIDE} empty="Reading what is on its way…" />
    </section>
  );
}
