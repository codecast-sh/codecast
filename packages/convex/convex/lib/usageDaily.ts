import type { Doc, Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import { overrideFor, usageCost } from "@platform/agent/meter";
import { dayStartUtc, resolveCounterTeam } from "./userSend";

// Per-day token and spend counters behind the "Tokens" and "Spend" chart
// metrics. conversations.usage_totals is a lifetime total per session, so it
// cannot say which day a token was spent; these rows can. Each turn lands on
// its own timestamp's day, so a session synced days late still fills the
// right days.
//
// Every live session of a person bills the same day, so the per-person row is
// never written inside a transcript insert: dozens of parallel inserts would
// contend on it (the send counters left the insert for the same reason).
// The insert adds to a row only its own session writes (usage_pending), and
// one fold per session, at most every FOLD_DELAY_MS, moves that into the
// person's day rows (user_usage_daily). Charts lag by at most that delay.
export const FOLD_DELAY_MS = 5 * 60_000;

const HOUR = 3600000;
const zeros24 = () => new Array(24).fill(0);

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
type DayHours = { day_start: number; token_hours: number[]; spend_hours: number[] };

const addHours = (into: number[], from: number[]) => into.map((v, h) => v + (from[h] || 0));

// Add a batch's counted turns to the session's pending rows, and schedule the
// fold when none was pending. A fork starts with a copy of its parent's
// history, which the parent already counted: the fork owns only the turns
// after it was created.
export async function recordUsageDays(
  ctx: { db: any; scheduler: any },
  conversation: Doc<"conversations">,
  turns: UsageTurn[],
): Promise<void> {
  const own = conversation.forked_from ? turns.filter((t) => t.timestamp >= conversation._creationTime) : turns;
  const byDay = new Map<number, DayHours>();
  for (const t of own) {
    const tokens = turnTokens(t.usage);
    if (tokens === 0) continue;
    const day = dayStartUtc(t.timestamp);
    const hour = Math.min(23, Math.max(0, Math.floor((t.timestamp - day) / HOUR)));
    const acc = byDay.get(day) ?? { day_start: day, token_hours: zeros24(), spend_hours: zeros24() };
    byDay.set(day, acc);
    acc.token_hours[hour] += tokens;
    acc.spend_hours[hour] += turnCost(t.model ?? conversation.model, t.usage);
  }
  if (byDay.size === 0) return;
  const pending = await ctx.db
    .query("usage_pending")
    .withIndex("by_conversation_day", (q: any) => q.eq("conversation_id", conversation._id))
    .collect();
  if (pending.length === 0) {
    await ctx.scheduler.runAfter(FOLD_DELAY_MS, internal.usageDays.fold, { conversation_id: conversation._id });
  }
  for (const add of byDay.values()) {
    const row = pending.find((p: any) => p.day_start === add.day_start);
    if (row) {
      await ctx.db.patch(row._id, { token_hours: addHours(row.token_hours, add.token_hours), spend_hours: addHours(row.spend_hours, add.spend_hours) });
    } else {
      await ctx.db.insert("usage_pending", { conversation_id: conversation._id, ...add });
    }
  }
}

// Move a session's pending usage into its owner's day rows.
export async function foldUsage(ctx: { db: any }, conversationId: Id<"conversations">): Promise<void> {
  const pending = await ctx.db
    .query("usage_pending")
    .withIndex("by_conversation_day", (q: any) => q.eq("conversation_id", conversationId))
    .collect();
  if (pending.length === 0) return;
  const conversation: Doc<"conversations"> | null = await ctx.db.get(conversationId);
  if (conversation) {
    const teamId = await resolveCounterTeam(ctx, conversation);
    for (const p of pending) {
      const existing = await ctx.db
        .query("user_usage_daily")
        .withIndex("by_user_team_day", (q: any) =>
          q.eq("user_id", conversation.user_id).eq("team_id", teamId).eq("day_start", p.day_start),
        )
        .first();
      const token_hours = addHours(existing?.token_hours ?? zeros24(), p.token_hours);
      const spend_hours = addHours(existing?.spend_hours ?? zeros24(), p.spend_hours);
      const row = { token_hours, spend_hours, updated_at: Date.now() };
      if (existing) await ctx.db.patch(existing._id, row);
      else await ctx.db.insert("user_usage_daily", { user_id: conversation.user_id, team_id: teamId, day_start: p.day_start, ...row });
    }
  }
  for (const p of pending) await ctx.db.delete(p._id);
}

export type UsageDayRow = DayHours;

// A user's usage counters over a trailing window, optionally scoped to one
// team. Unscoped reads sum every team's row for a day.
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
    const acc = byDay.get(r.day_start) ?? { day_start: r.day_start, token_hours: zeros24(), spend_hours: zeros24() };
    byDay.set(r.day_start, { day_start: r.day_start, token_hours: addHours(acc.token_hours, r.token_hours), spend_hours: addHours(acc.spend_hours, r.spend_hours) });
  }
  return [...byDay.values()];
}
