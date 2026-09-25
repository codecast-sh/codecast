// A role's caps and today's counters (docs/architecture/org-staffing.md S2),
// and its switch (S23.1). Leaf module: read from every write path and from
// org.health, so it imports nothing that imports them back.

import { DEFAULT_ROLE_CAPS } from "@codecast/shared/contracts/orgCapacity";
import { autonomyOn } from "@codecast/shared/contracts/roleAutonomy";

// The numbers live in the shared capacity model, which the analyzer prompt
// and org.health read too.
export const DEFAULT_CAPS = DEFAULT_ROLE_CAPS;
export const DEFAULT_TRUST = "understand" as const;

export function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

export type RoleCounters = { day: string; hands: number; wakes: number; tokens: number };

// Today's counters, reset when the stored day is not today. Every reader and
// writer of `counters` goes through this so a stale row never leaks yesterday.
export function countersFor(role: { counters?: RoleCounters | null }, now: number): RoleCounters {
  const day = utcDay(now);
  const c = role.counters;
  if (c && c.day === day) return { ...c };
  return { day, hands: 0, wakes: 0, tokens: 0 };
}

export function capsFor(role: { caps?: { hands_per_day: number; wakes_per_day: number; tokens_per_day: number } | null }) {
  return { ...DEFAULT_CAPS, ...(role.caps ?? {}) };
}

export function trustOf(role: { trust?: string | null }): "understand" | "decide" | "direct" {
  return (role.trust as any) ?? DEFAULT_TRUST;
}

// The switch (org-staffing.md S23.1): does the role start work on its own? The
// stored stage maps through the shared helper, so this file, the gates and
// every surface read one answer.
export function roleStartsOnItsOwn(role: { trust?: string | null }): boolean {
  return autonomyOn(trustOf(role));
}
