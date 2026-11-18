// The open plans under a project, as a goal lists them (ct-95899): the unit
// people and agents think in is the plan, so a goal names the plans that carry
// it under each of its projects. One rule for the server (cast goal show, the
// coverage block) and the web goal page: a plan is open until it is done,
// dropped or abandoned; newest activity first; capped.

export const CLOSED_PLAN_STATUSES: ReadonlySet<string> = new Set(["done", "dropped", "abandoned"]);
export const isOpenPlan = (status: string | null | undefined): boolean => !CLOSED_PLAN_STATUSES.has(status ?? "");

/** How many open plans a goal lists under one project. */
export const OPEN_PLANS_PER_PROJECT = 5;

/** A project's open plans, newest activity first, at most `cap`; `more` counts the rest. */
export function openPlansOf<P extends { status: string; project_id?: unknown; updated_at?: number; _creationTime?: number }>(
  plans: readonly P[],
  projectId: string,
  cap: number = OPEN_PLANS_PER_PROJECT,
): { plans: P[]; more: number } {
  const open = plans
    .filter((p) => String(p.project_id ?? "") === projectId && isOpenPlan(p.status))
    .sort((a, b) => (b.updated_at ?? b._creationTime ?? 0) - (a.updated_at ?? a._creationTime ?? 0));
  return { plans: open.slice(0, cap), more: Math.max(0, open.length - cap) };
}
