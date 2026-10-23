// A role's caps and today's counters (docs/architecture/org-staffing.md S2),
// and its switch (S23.1). Leaf module: read from every write path and from
// org.health, so it imports nothing that imports them back.

import { DEFAULT_LINE_CARDS_CAP, type RoleDailyCaps } from "@codecast/shared/contracts/orgCapacity";
import { autonomyOn, defaultTrustFor } from "@codecast/shared/contracts/roleAutonomy";

export function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

// `merges` (the-line.md L12) and `deploys` (deploys.md DP4) are counted only
// once a line merges or deploys, so a row written before has none and reads as zero.
export type RoleCounters = { day: string; hands: number; wakes: number; tokens: number; merges?: number; deploys?: number };

// Today's counters, reset when the stored day is not today. Every reader and
// writer of `counters` goes through this so a stale row never leaks yesterday.
export function countersFor(role: { counters?: RoleCounters | null }, now: number): RoleCounters {
  const day = utcDay(now);
  const c = role.counters;
  if (c && c.day === day) return { ...c };
  return { day, hands: 0, wakes: 0, tokens: 0 };
}

// Today's tokens live beside the role, one org_role_tokens row per session
// that works for it: every station's transcript sync adds to its own row, so
// none of them writes the role, and a spawn or a sweep reading the role never
// loses a write race to them. `counters.tokens` on the role is not written.
type Db = { db: any };

/** Adds `tokens` to what `conversationId` spent for its role today. */
export async function addRoleTokens(ctx: Db, roleId: any, conversationId: any, tokens: number, now: number): Promise<void> {
  if (!tokens) return;
  const day = utcDay(now);
  const row = await ctx.db.query("org_role_tokens").withIndex("by_conversation_day", (q: any) => q.eq("conversation_id", conversationId).eq("day", day)).first();
  if (row) await ctx.db.patch(row._id, { tokens: row.tokens + tokens });
  else await ctx.db.insert("org_role_tokens", { role_id: roleId, conversation_id: conversationId, day, tokens });
}

/** The tokens every session of the role spent today. */
export async function roleTokensToday(ctx: Db, roleId: any, now: number): Promise<number> {
  const rows: any[] = await ctx.db.query("org_role_tokens").withIndex("by_role_day", (q: any) => q.eq("role_id", roleId).eq("day", utcDay(now))).collect();
  return rows.reduce((n, r) => n + (r.tokens ?? 0), 0);
}

/** Today's counters with the tokens read from their own rows: for a surface that shows them. */
export async function countersNow(ctx: Db, role: { _id: any; counters?: RoleCounters | null }, now: number): Promise<RoleCounters> {
  return { ...countersFor(role, now), tokens: await roleTokensToday(ctx, role._id, now) };
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