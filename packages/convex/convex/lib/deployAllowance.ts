// The line's deploy allowance (docs/architecture/deploys.md DP4), read from
// the role row alone: the role's `deploy` authority grant (org-hire.md H4:
// kind publish, a per_day limit) and today's count against it. A leaf, so
// the deploy trigger and every reader of the stage share one reading, the
// way the merge step reads lib/lineMerge.

import { authorityGrantOf, type Grant } from "./lineMerge";
import { countersFor, roleStartsOnItsOwn } from "./orgCaps";

export const DEPLOY_AUTHORITY_ID = "deploy";
export const DEPLOY_AUTHORITY_KIND = "publish";
export const DEPLOY_AUTHORITY_LABEL = "Deploy the line's shipped fixes through the project's [line.deploy] path; the daily limit counts deploys only";

export type DeployAllowance = {
  allowed: boolean;
  /** Why not, in the words the Deploys view and the stage print. */
  reason: string | null;
  used: number;
  limit: number | null;
  grant: Grant | null;
};

/** The role's deploy grant when it holds one that has not expired. */
export function deployGrantOf(role: { authority?: Grant[] | null }, now: number): Grant | null {
  return authorityGrantOf(role, DEPLOY_AUTHORITY_ID, DEPLOY_AUTHORITY_KIND, now);
}

/** Whether this role may ask for a deploy right now. */
export function deployAllowance(role: { authority?: Grant[] | null; counters?: any; status?: string; trust?: string | null }, now: number): DeployAllowance {
  const grant = deployGrantOf(role, now);
  const used = countersFor(role, now).deploys ?? 0;
  const limit = grant?.limit?.per_day ?? null;
  const base = { used, limit, grant };
  if (role.status && role.status !== "active") return { ...base, allowed: false, reason: `the role is ${role.status}` };
  if (!roleStartsOnItsOwn(role)) return { ...base, allowed: false, reason: "the role does not start work on its own" };
  if (!grant) {
    const expired = (role.authority ?? []).some((a) => a.id === DEPLOY_AUTHORITY_ID);
    return { ...base, allowed: false, reason: expired ? "its deploy authority has expired" : "it holds no deploy authority" };
  }
  // A deploy grant always carries a daily limit: one without is read as none left.
  if (limit === null) return { ...base, allowed: false, reason: "its deploy authority has no daily limit" };
  if (used >= limit) return { ...base, allowed: false, reason: `it has used today's deploys (${used} of ${limit})` };
  return { ...base, allowed: true, reason: null };
}
