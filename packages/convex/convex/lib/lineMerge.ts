// The line's merge allowance (docs/architecture/the-line.md L12), read from
// the role row alone: the line's switch, the role's `merge` authority grant
// (org-hire.md H4) and today's count against its daily limit. A leaf, so the
// role reader (orgRoles.lineOfRole) and the merge step share one reading.

import { countersFor } from "./orgCaps";

export const MERGE_AUTHORITY_ID = "merge";
export const MERGE_AUTHORITY_LABEL = "Merge the flow's approved branches into the project's default branch when their checks pass; the daily limit counts merges only";

type Grant = { id: string; kind: string; label: string; limit?: { per_day?: number }; expires_at?: number };

/** The role's line changes as regret.md R3 counts them (contracts/regretRates roleLineRate). */
export type MeasuredRate = { settled: number; regretted: number; partial: number; rate: number | null; window_days?: number };
export type RateBar = { bar: number; min: number };

export type MergeAllowance = {
  on: boolean;
  allowed: boolean;
  /** Why not, in the words a task comment and the runner print. */
  reason: string | null;
  used: number;
  limit: number | null;
  grant: Grant | null;
  /** "rate" while the role merges on its measured rate (R7), else "count". */
  mode: "count" | "rate";
  bar: RateBar | null;
  /** The role's measured rate, when the reader had it. */
  measured: MeasuredRate | null;
};

/** The role's merge grant when it holds one that has not expired. */
export function mergeGrantOf(role: { authority?: Grant[] | null }, now: number): Grant | null {
  const g = (role.authority ?? []).find((a) => a.id === MERGE_AUTHORITY_ID && a.kind === "write");
  if (!g) return null;
  return g.expires_at !== undefined && g.expires_at <= now ? null : g;
}

/** Whether this line may merge right now, read from the role row alone. */
export function mergeAllowance(role: { line_merge?: boolean | null; line_merge_rate?: RateBar | null; authority?: Grant[] | null; counters?: any; status?: string }, now: number, measured: MeasuredRate | null = null): MergeAllowance {
  const on = !!role.line_merge;
  const grant = mergeGrantOf(role, now);
  const used = countersFor(role, now).merges ?? 0;
  const limit = grant?.limit?.per_day ?? null;
  const bar = role.line_merge_rate ? { bar: role.line_merge_rate.bar, min: role.line_merge_rate.min } : null;
  const base = { on, used, limit, grant, mode: bar ? "rate" as const : "count" as const, bar, measured };
  if (!on) return { ...base, allowed: false, reason: "merge is off for this flow; a person turns it on with cast role line --merge on" };
  if (role.status && role.status !== "active") return { ...base, allowed: false, reason: `the role is ${role.status}` };
  if (!grant) {
    const expired = (role.authority ?? []).some((a) => a.id === MERGE_AUTHORITY_ID);
    return { ...base, allowed: false, reason: expired ? "the role's merge authority has expired" : "the role holds no merge authority" };
  }
  if (bar) {
    const pct = (x: number) => `${Math.round(x * 100)}%`;
    if (!measured) return { ...base, allowed: false, reason: "the role's regret-free rate could not be read" };
    if (measured.settled < bar.min) return { ...base, allowed: false, reason: `only ${measured.settled} of the ${bar.min} finished changes the rate needs` };
    if (measured.rate === null || measured.rate < bar.bar) return { ...base, allowed: false, reason: `the role's regret-free rate is ${measured.rate === null ? "unknown" : pct(measured.rate)}, under its bar of ${pct(bar.bar)}` };
  }
  if (limit !== null && used >= limit) return { ...base, allowed: false, reason: `the role has reached its daily merge limit (${used} of ${limit})` };
  return { ...base, allowed: true, reason: null };
}

