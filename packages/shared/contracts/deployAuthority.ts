// The role's deploy allowance (docs/architecture/deploys.md DP4): the grant a
// role holds to ask for deploys, and whether it may ask for one right now.
// Kept out of lineDeploy.ts, the profile leaf the CLI and daemon read.

import { autonomyOn, defaultTrustFor } from "./roleAutonomy";

export const DEPLOY_AUTHORITY_ID = "deploy";
export const DEPLOY_AUTHORITY_KIND = "publish";
export const DEPLOY_AUTHORITY_LABEL = "Deploy the line's shipped fixes through the project's [line.deploy] path; the daily limit counts deploys only";

type AuthorityGrant = { id: string; kind: string; label?: string; limit?: { per_day?: number }; expires_at?: number };
type DeployRole = {
  authority?: AuthorityGrant[] | null;
  counters?: { day: string; deploys?: number } | null;
  status?: string;
  trust?: string | null;
  handle?: string;
};

export type DeployAllowance = {
  allowed: boolean;
  /** Why not, in the words the Deploys view and the stage print. */
  reason: string | null;
  used: number;
  limit: number | null;
  grant: AuthorityGrant | null;
};

/** The role's deploy grant when it holds one that has not expired. */
export function deployGrantOf(role: DeployRole, now: number): AuthorityGrant | null {
  const g = (role.authority ?? []).find((a) => a.id === DEPLOY_AUTHORITY_ID && a.kind === DEPLOY_AUTHORITY_KIND);
  if (!g) return null;
  return g.expires_at !== undefined && g.expires_at <= now ? null : g;
}

/**
 * Whether this role may ask for a deploy right now, read from the role row
 * alone: active, starting work on its own, holding a deploy grant with a
 * daily limit, and room in that limit today. The trigger and every surface
 * that shows the stage read this one answer.
 */
export function deployAllowance(role: DeployRole, now: number): DeployAllowance {
  const grant = deployGrantOf(role, now);
  const today = new Date(now).toISOString().slice(0, 10);
  const used = role.counters?.day === today ? role.counters.deploys ?? 0 : 0;
  const limit = grant?.limit?.per_day ?? null;
  const base = { used, limit, grant };
  if (role.status && role.status !== "active") return { ...base, allowed: false, reason: `the role is ${role.status}` };
  if (!autonomyOn(role.trust ?? defaultTrustFor(role))) return { ...base, allowed: false, reason: "the role does not start work on its own" };
  if (!grant) {
    const expired = (role.authority ?? []).some((a) => a.id === DEPLOY_AUTHORITY_ID);
    return { ...base, allowed: false, reason: expired ? "its deploy authority has expired" : "it holds no deploy authority" };
  }
  // A deploy grant always carries a daily limit: one without is read as none left.
  if (limit === null) return { ...base, allowed: false, reason: "its deploy authority has no daily limit" };
  if (used >= limit) return { ...base, allowed: false, reason: `it has used today's deploys (${used} of ${limit})` };
  return { ...base, allowed: true, reason: null };
}
