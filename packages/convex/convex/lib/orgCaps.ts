// A role's caps and today's counters (docs/architecture/org-staffing.md S2),
// and its switch (S23.1). Leaf module: read from every write path and from
// org.health, so it imports nothing that imports them back.

import { DEFAULT_LINE_CARDS_CAP, type RoleDailyCaps } from "@codecast/shared/contracts/orgCapacity";
import { autonomyOn, defaultTrustFor } from "@codecast/shared/contracts/roleAutonomy";

export function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

// `merges` (the-line.md L12) is counted only once a line merges, so a row
// written before it has none and reads as zero.
export type RoleCounters = { day: string; hands: number; wakes: number; tokens: number; merges?: number };

// Today's counters, reset when the stored day is not today. Every reader and
// writer of `counters` goes through this so a stale row never leaks yesterday.
export function countersFor(role: { counters?: RoleCounters | null }, now: number): RoleCounters {
  const day = utcDay(now);
  const c = role.counters;
  if (c && c.day === day) return { ...c };
  return { day, hands: 0, wakes: 0, tokens: 0 };
}

// The role's stored caps. A role starts with none and an absent daily limit
// is no limit (orgCapacity.atCap); only what a person set holds.
export type RoleCaps = RoleDailyCaps & { cards?: number; line_on?: boolean };
export function capsFor(role: { caps?: RoleCaps | null }): RoleCaps {
  return { ...(role.caps ?? {}) };
}

/** caps.cards (LE6), the default when the role has none. */
export function cardsCapOf(role: { caps?: { cards?: number } | null }): number {
  return role.caps?.cards ?? DEFAULT_LINE_CARDS_CAP;
}

export function trustOf(role: { trust?: string | null; handle?: string }): "understand" | "decide" | "direct" {
  return (role.trust as any) ?? defaultTrustFor(role);
}

// The switch (org-staffing.md S23.1): does the role start work on its own? The
// stored stage maps through the shared helper, so this file, the gates and
// every surface read one answer.
export function roleStartsOnItsOwn(role: { trust?: string | null }): boolean {
  return autonomyOn(trustOf(role));
}