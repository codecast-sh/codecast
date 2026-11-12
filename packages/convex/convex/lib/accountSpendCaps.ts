import type { Doc, Id } from "../_generated/dataModel";
import { newestSignificantMessage, isBannerTurn } from "../inboxFilters";
import { spendCapUntil } from "@codecast/shared/contracts";

// A spend cap is not on any meter: the provider names it only in the banner
// that parks a session. Each parked session's spend-limit banner says when the
// capped account's week resets, and the account whose week resets then is the
// one refused (spendCapUntil).
const SPEND_CAP_MATCH_MS = 90 * 60_000;
export async function spendCapsOf(ctx: { db: any }, userId: Id<"users">, now: number): Promise<number[]> {
  const parked: Doc<"conversations">[] = await ctx.db
    .query("conversations")
    .withIndex("by_user_pending_api_error", (q: any) => q.eq("user_id", userId).eq("pending_api_error", true))
    .order("desc")
    .take(50);
  const caps: number[] = [];
  for (const conv of parked) {
    if (conv.pending_api_error_kind !== "limit") continue;
    const tail: Doc<"messages">[] = await ctx.db
      .query("messages")
      .withIndex("by_conversation_timestamp", (q: any) => q.eq("conversation_id", conv._id))
      .order("desc")
      .take(8);
    const newest = newestSignificantMessage(tail);
    if (!newest || !isBannerTurn(newest)) continue;
    const until = spendCapUntil(newest.content, newest.timestamp);
    if (until !== undefined && until > now) caps.push(until);
  }
  return caps;
}

export function withSpendCap<P extends { usage?: any }>(profiles: P[], caps: number[]): P[] {
  if (!caps.length) return profiles;
  return profiles.map((p) => {
    const reset = p.usage?.weekly?.resets_at;
    const until = reset != null ? caps.find((c) => Math.abs(c - reset) <= SPEND_CAP_MATCH_MS) : undefined;
    return until === undefined ? p : { ...p, usage: { ...p.usage, blocked_until: until } };
  });
}
