// The scope rules of an org role (docs/architecture/scopes-and-feed.md F1),
// as pure functions over ids so the mutation, the feed and the tests share one
// reading of "inside" and "overlapping".
//
// A scope is a set of projects and a set of plans. Scope is opt in
// (org-staffing.md S26): empty sets name no area, and a role with no area owns
// no work. Only the Head of People with no scope stands for the whole
// workspace, and that rule lives in shared/contracts/orgLead.ts
// (isWholeWorkspaceRole), never here: these functions read ids alone and say
// nothing about who owns what. A plan belongs to a project (`plans.project_id`), so a plan is
// inside a scope that names its project even when the plan itself is not
// listed; `planProjectOf` carries that edge for every plan the caller touches.

import { Id } from "../_generated/dataModel";

export type Scope = { project_ids: Id<"projects">[]; plan_ids: Id<"plans">[] };
export type ScopeIds = { project_ids: string[]; plan_ids: string[] };
export type PlanProjectOf = Map<string, string | null>;

export const EMPTY_SCOPE: Scope = { project_ids: [], plan_ids: [] };

/** The scope names no projects and no plans. */
export function isScopeless(scope: ScopeIds | Scope): boolean {
  return scope.project_ids.length === 0 && scope.plan_ids.length === 0;
}
// The old name, which read as a claim on the workspace. It stays only until
// orgInit.ts and org.ts import the new one.

const uniq = <T>(ids: T[]): T[] => Array.from(new Set(ids.map((x) => String(x)))) as unknown as T[];

// Drop duplicates and plans whose project is already named: a scope that says
// "project P and plan Q of P" is the scope "project P".
export function normalizeScope(scope: Scope, planProjectOf: PlanProjectOf): Scope {
  const projects = new Set(scope.project_ids.map(String));
  const plans = uniq(scope.plan_ids).filter((p) => {
    const project = planProjectOf.get(String(p));
    return !(project && projects.has(project));
  });
  return { project_ids: uniq(scope.project_ids), plan_ids: plans };
}

function planInside(plan: string, scope: ScopeIds, planProjectOf: PlanProjectOf): boolean {
  if (scope.plan_ids.includes(plan)) return true;
  const project = planProjectOf.get(plan);
  return !!project && scope.project_ids.includes(project);
}

// Containment: every project and plan of `child` sits inside `parent`. A
// parent that names no area sets no limit on a child, which is not a claim
// that it owns the child's work. Returns what falls outside so the refusal
// can name it.
export function scopeOutside(parent: ScopeIds, child: ScopeIds, planProjectOf: PlanProjectOf): ScopeIds {
  if (isScopeless(parent)) return { project_ids: [], plan_ids: [] };
  return {
    project_ids: child.project_ids.filter((p) => !parent.project_ids.includes(p)),
    plan_ids: child.plan_ids.filter((p) => !planInside(p, parent, planProjectOf)),
  };
}

// Overlap: what two scopes both watch. Shared projects, shared plans, and a
// plan one side lists whose project the other side names. A scope that names
// no area overlaps with nothing.
export function scopeOverlap(a: ScopeIds, b: ScopeIds, planProjectOf: PlanProjectOf): ScopeIds {
  if (isScopeless(a) || isScopeless(b)) return { project_ids: [], plan_ids: [] };
  const project_ids = a.project_ids.filter((p) => b.project_ids.includes(p));
  const plans = new Set<string>();
  for (const p of a.plan_ids) if (planInside(p, b, planProjectOf)) plans.add(p);
  for (const p of b.plan_ids) if (planInside(p, a, planProjectOf)) plans.add(p);
  return { project_ids, plan_ids: Array.from(plans) };
}

export function scopeIds(scope: Scope): ScopeIds {
  return { project_ids: scope.project_ids.map(String), plan_ids: scope.plan_ids.map(String) };
}

export function sameScope(a: ScopeIds, b: ScopeIds): boolean {
  const key = (s: ScopeIds) => JSON.stringify({ p: [...s.project_ids].sort(), l: [...s.plan_ids].sort() });
  return key(a) === key(b);
}
