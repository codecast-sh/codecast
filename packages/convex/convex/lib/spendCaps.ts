// A monthly spend cap is not on any usage meter, and a weekly limit can park
// sessions while the stored meter still reads under 100. The provider names
// both in the banner. The readers of a profile's meter mark that account
// blocked until the reset the banner prints.
import type { Id, Doc } from "../_generated/dataModel";
import { isBannerTurn } from "../inboxFilters";

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function zonedWallToUtc(y: number, mo: number, d: number, h: number, mi: number, timeZone: string): number | undefined {
  const guess = Date.UTC(y, mo, d, h, mi);
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", hourCycle: "h23" }).formatToParts(new Date(guess));
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? "0");
    return guess - (Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute")) - guess);
  } catch {
    return undefined;
  }
}

/** A spend-limit banner ("You've hit your org's monthly spend limit · … ·
 *  your weekly limit resets Nov 19, 5am (UTC)") names the week whose reset
 *  puts the account back on its plan, which is what lifts the block. That
 *  instant also identifies the account: only one account's week resets then,
 *  and the account a host claims to run can differ from the token the process
 *  holds (an inherited CLAUDE_CODE_OAUTH_TOKEN, 2026-11-12). Undefined for any
 *  other banner. */
export function spendCapUntil(content: string | null | undefined, bannerTs: number): number | undefined {
  if (!content || !/spend limit/i.test(content)) return undefined;
  const m = content.match(/resets\s+([a-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(([^)]+)\)/i);
  if (!m) return undefined;
  const month = MONTHS.indexOf(m[1].toLowerCase());
  if (month < 0) return undefined;
  return resetInstant(month, Number(m[2]), Number(m[3]), Number(m[4] ?? "0"), m[5], m[6], bannerTs);
}

function resetInstant(month: number, day: number, hour12: number, minute: number, ampm: string, zone: string, bannerTs: number): number | undefined {
  const hour = (hour12 % 12) + (ampm.toLowerCase() === "pm" ? 12 : 0);
  const at = (y: number) => zonedWallToUtc(y, month, day, hour, minute, zone);
  const year = new Date(bannerTs).getUTCFullYear();
  const t = at(year);
  return t !== undefined && t < bannerTs - 24 * 3600_000 ? at(year + 1) : t;
}

/** A weekly-limit banner ("You've hit your weekly limit · resets Nov 19, 7pm
 *  (UTC)") names the week that is already spent. The same reset identifies
 *  the account, the way a spend banner does. A Fable banner, a 5-hour banner
 *  and a weekly line with no date do not: those resets do not name one
 *  account's week. Undefined for anything else, including a spend banner. */
export function weeklyLimitUntil(content: string | null | undefined, bannerTs: number): number | undefined {
  if (!content || !/you['’]ve hit your weekly limit\b/i.test(content)) return undefined;
  const m = content.match(/resets\s+([a-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(([^)]+)\)/i);
  if (!m) return undefined;
  const month = MONTHS.indexOf(m[1].toLowerCase());
  if (month < 0) return undefined;
  return resetInstant(month, Number(m[2]), Number(m[3]), Number(m[4] ?? "0"), m[5], m[6], bannerTs);
}

// The account whose week resets within this of a banner's printed reset is the capped one.
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
    // The newest banner is often the account the fleet just left for. The
    // weekly block that caused the hop is a few turns earlier and still names
    // a reset in the future. Keep every such reset in this tail.
    const tail: Doc<"messages">[] = await ctx.db
      .query("messages")
      .withIndex("by_conversation_timestamp", (q: any) => q.eq("conversation_id", conv._id))
      .order("desc")
      .take(20);
    for (const turn of tail) {
      if (!isBannerTurn(turn) || typeof turn.timestamp !== "number") continue;
      const until = spendCapUntil(turn.content, turn.timestamp) ?? weeklyLimitUntil(turn.content, turn.timestamp);
      if (until !== undefined && until > now && !caps.includes(until)) caps.push(until);
    }
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
