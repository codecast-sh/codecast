import type { Doc, Id } from "../_generated/dataModel";
import { overrideFor, usageCost } from "@platform/agent/meter";
import { dayStartUtc, resolveCounterTeam } from "./userSend";

// Per-day token and spend counters behind the "Tokens" and "Spend" chart
// metrics. conversations.usage_totals is a lifetime total per session, so it
// cannot say which day a token was spent; these rows can. Written at ingest by
// messages.rollUpUsage for the turns it counts, keyed by the turn's own
// timestamp, so a session synced days late still lands on the right days.
//
// A row is (user, team, UTC day, shard). Every live session of a person bills
// the same day, and one row per day would make all of them write one document:
// each session sticks to one shard, so a row only sees a few writers.
export const USAGE_SHARDS = 8;

const HOUR = 3600000;

export function usageShard(conversationId: string): number {
  let h = 0;
  for (let i = 0; i < conversationId.length; i++) h = (h * 31 + conversationId.charCodeAt(i)) | 0;
  return Math.abs(h) % USAGE_SHARDS;
}

export type TurnUsage = {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
};

export function turnTokens(u: TurnUsage): number {
  return (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
}

// Dollars a turn costs at API list price, or 0 for a model the price table
// does not name (a non-Claude backend): its tokens still count, its spend is
// unknown rather than guessed at the dearest rate. Claude Code writes its
// prompt cache with the one hour TTL (98.5% of cache-write tokens, measured
// 2026-10-06), which bills at twice the input rate.
export function turnCost(model: string | undefined, u: TurnUsage): number {
  const price = model ? overrideFor(model) : undefined;
  if (!price) return 0;
  return usageCost(
    {
      input: u.input_tokens || 0,
      output: u.output_tokens || 0,
      cacheRead: u.cache_read_input_tokens || 0,
      cacheWrite: u.cache_creation_input_tokens || 0,
    },
    { ...price, cacheWrite: price.input * 2 },
  );
}

export type UsageTurn = { usage: TurnUsage; model?: string; timestamp: number };

// Add a batch's counted turns to the counters, one write per UTC day touched.
// A fork starts with a copy of its parent's history, which the parent already
// counted: the fork owns only the turns after it was created.
export async function recordUsageDays(ctx: { db: any }, conversation: Doc<"conversations">, turns: UsageTurn[]): Promise<void> {
  const own = conversation.forked_from ? turns.filter((t) => t.timestamp >= conversation._creationTime) : turns;
  if (own.length === 0) return;
  const byDay = new Map<number, { tokens: number[]; spend: number[] }>();
  for (const t of own) {
    const day = dayStartUtc(t.timestamp);
    const hour = Math.min(23, Math.max(0, Math.floor((t.timestamp - day) / HOUR)));
    const acc = byDay.get(day) ?? { tokens: new Array(24).fill(0), spend: new Array(24).fill(0) };
    byDay.set(day, acc);
    acc.tokens[hour] += turnTokens(t.usage);
    acc.spend[hour] += turnCost(t.model ?? conversation.model, t.usage);
  }
  const teamId = await resolveCounterTeam(ctx, conversation);
  const shard = usageShard(String(conversation._id));
  for (const [day, add] of byDay) {
    const existing = await ctx.db
      .query("user_usage_daily")
      .withIndex("by_user_team_day", (q: any) =>
        q.eq("user_id", conversation.user_id).eq("team_id", teamId).eq("day_start", day).eq("shard", shard),
      )
      .first();
    const tokenHours = add.tokens.map((v, h) => v + (existing?.token_hours[h] ?? 0));
    const spendHours = add.spend.map((v, h) => v + (existing?.spend_hours[h] ?? 0));
    const row = {
      tokens: tokenHours.reduce((a, b) => a + b, 0),
      spend: spendHours.reduce((a, b) => a + b, 0),
      token_hours: tokenHours,
      spend_hours: spendHours,
      updated_at: Date.now(),
    };
    if (existing) await ctx.db.patch(existing._id, row);
    else await ctx.db.insert("user_usage_daily", { user_id: conversation.user_id, team_id: teamId, day_start: day, shard, ...row });
  }
}

export type UsageDayRow = { day_start: number; token_hours: number[]; spend_hours: number[] };

// A user's usage counters over a trailing window, optionally scoped to one
// team. Shards and teams that share a day are summed into one row.
export async function fetchUserUsageDays(
  ctx: { db: any },
  userId: Id<"users">,
  teamId: Id<"teams"> | undefined,
  days: number,
): Promise<UsageDayRow[]> {
  const cutoff = dayStartUtc(Date.now() - days * 24 * HOUR);
  const rows: UsageDayRow[] = teamId
    ? await ctx.db
        .query("user_usage_daily")
        .withIndex("by_user_team_day", (q: any) => q.eq("user_id", userId).eq("team_id", teamId).gte("day_start", cutoff))
        .collect()
    : await ctx.db
        .query("user_usage_daily")
        .withIndex("by_user_day", (q: any) => q.eq("user_id", userId).gte("day_start", cutoff))
        .collect();
  const byDay = new Map<number, UsageDayRow>();
  for (const r of rows) {
    const acc = byDay.get(r.day_start) ?? { day_start: r.day_start, token_hours: new Array(24).fill(0), spend_hours: new Array(24).fill(0) };
    byDay.set(r.day_start, acc);
    for (let h = 0; h < 24; h++) {
      acc.token_hours[h] += r.token_hours[h] || 0;
      acc.spend_hours[h] += r.spend_hours[h] || 0;
    }
  }
  return [...byDay.values()];
}
