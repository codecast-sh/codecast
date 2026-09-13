import { useMemo } from "react";
import type { PlanItem } from "../store/inboxStore";

/** The ids a scope covers, expanded the F1 way: a plan of a project in scope is in scope. */
export type ScopeIds = { projectIds: string[]; planIds: string[]; whole: boolean };

export function useScopeIds(scope: { project_ids: string[]; plan_ids: string[] } | null, plans: PlanItem[]): ScopeIds {
  return useMemo(() => {
    if (!scope) return { projectIds: [], planIds: [], whole: true };
    const whole = scope.project_ids.length === 0 && scope.plan_ids.length === 0;
    const projectIds = [...scope.project_ids];
    const planIds = new Set(scope.plan_ids);
    for (const p of plans) if ((p as any).project_id && projectIds.includes((p as any).project_id)) planIds.add(p._id);
    return { projectIds, planIds: Array.from(planIds), whole };
  }, [scope, plans]);
}

export const inScope = (ids: ScopeIds, row: { project_id?: string | null; plan_id?: string | null }): boolean =>
  ids.whole || (!!row.project_id && ids.projectIds.includes(row.project_id)) || (!!row.plan_id && ids.planIds.includes(row.plan_id));
