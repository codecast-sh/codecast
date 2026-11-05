// The weekly card (shared contracts/weeklyCard): a person's Monday-to-Sunday
// week with coding agents, built from their own sessions, machines and token
// counters, previewed in the app at /week and published through publicShare's
// "card" kind. Staff only until it is reviewed (weeklyCardAllowed), and built
// on its own each Monday only for people who turned it on.
//
// A week of an active account is thousands of conversation rows, each a large
// document, so the build is an action that pages through them in small
// internal queries and keeps only the fields the card needs; the stored row
// holds the finished numbers, never a title, prompt or path.
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { action, internalAction, internalMutation, internalQuery, query } from "./functions";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { workspaceKey } from "./lib/accessKeys";
import { dayStartUtc } from "./lib/userSend";
import { isKnownTimeZone } from "@codecast/shared/time";
import { emitNotification } from "./notificationRouter";
import {
  buildWeekCard,
  deviceKindOf,
  SESSION_CREDIT_CAP_MS,
  weekBounds,
  weeklyCardAllowed,
  type WeekCardSession,
  type WeekCardStats,
  type WeekWhich,
} from "@codecast/shared/contracts/weeklyCard";

const HOUR = 3_600_000;
const PAGE = 150;
/** How many past weeks the app keeps in the store. */
const LIST_WEEKS = 8;

function basename(path?: string | null): string | null {
  if (!path) return null;
  const parts = path.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || null;
}

/** The person's cards, newest week first, for the store (feed: weeklyCards.listMine). */
export const listMine = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    const user = await ctx.db.get(userId);
    if (!weeklyCardAllowed(user)) return [];
    return await ctx.db
      .query("weekly_cards")
      .withIndex("by_user_week", (q) => q.eq("user_id", userId))
      .order("desc")
      .take(LIST_WEEKS);
  },
});

/** One page of a person's sessions credited near [from, to), reduced to what the card reads. */
export const sessionPage = internalQuery({
  args: { user_id: v.id("users"), from: v.number(), to: v.number(), cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, { user_id, from, to, cursor }) => {
    const page = await ctx.db
      .query("conversations")
      .withIndex("by_user_updated", (q) => q.eq("user_id", user_id).gte("updated_at", from).lt("updated_at", to))
      .paginate({ numItems: PAGE, cursor });
    const sessions: WeekCardSession[] = [];
    for (const c of page.page) {
      // A Claude Code subagent is a helper inside a session, not a session the person ran.
      if (c.is_subagent) continue;
      sessions.push({
        started_at: c.started_at,
        updated_at: c.updated_at,
        agent_type: c.agent_type,
        device_id: c.owner_device_id ?? null,
        project: basename(c.git_root || c.project_path),
        private: c.is_private || c.team_visibility === "private",
      });
    }
    return { sessions, cursor: page.continueCursor, done: page.isDone };
  },
});

/** The person's machines by kind, and their hourly token counters over [from, to). */
export const weekContext = internalQuery({
  args: { user_id: v.id("users"), from: v.number(), to: v.number() },
  handler: async (ctx, { user_id, from, to }) => {
    const user = await ctx.db.get(user_id);
    const devices = (await ctx.db.query("devices").withIndex("by_user_id", (q) => q.eq("user_id", user_id)).collect())
      .map((d) => ({ device_id: d.device_id, kind: deviceKindOf(d as any) }));
    const rows = await ctx.db
      .query("user_usage_daily")
      .withIndex("by_user_day", (q) => q.eq("user_id", user_id).gte("day_start", dayStartUtc(from)).lt("day_start", to))
      .collect();
    const tokenHours: Array<[number, number]> = [];
    for (const r of rows) r.token_hours.forEach((n, h) => { if (n) tokenHours.push([r.day_start + h * HOUR, n]); });
    return { allowed: weeklyCardAllowed(user), timezone: user?.timezone ?? null, devices, tokenHours };
  },
});

export const store = internalMutation({
  args: { user_id: v.id("users"), tz: v.string(), stats: v.any() },
  handler: async (ctx, { user_id, tz, stats }): Promise<Id<"weekly_cards">> => {
    const s = stats as WeekCardStats;
    const existing = await ctx.db
      .query("weekly_cards")
      .withIndex("by_user_week", (q) => q.eq("user_id", user_id).eq("week_key", s.week_key))
      .first();
    const row = { tz, stats: s, week_start: s.week_start, generated_at: Date.now() };
    if (existing) {
      await ctx.db.patch(existing._id, row);
      return existing._id;
    }
    return await ctx.db.insert("weekly_cards", {
      user_id,
      workspace: workspaceKey({ type: "user", userId: String(user_id) } as any),
      week_key: s.week_key,
      ...row,
    });
  },
});

async function buildFor(ctx: any, userId: Id<"users">, which: WeekWhich, tzHint: string | undefined, trigger: "manual" | "monday"): Promise<Id<"weekly_cards"> | null> {
  const now = Date.now();
  const probe = await ctx.runQuery(internal.weeklyCards.weekContext, { user_id: userId, from: now, to: now });
  if (!probe.allowed) return null;
  const tz = [tzHint, probe.timezone, "UTC"].find((z): z is string => !!z && isKnownTimeZone(z))!;
  const bounds = weekBounds(now, tz, which);
  const { devices, tokenHours } = await ctx.runQuery(internal.weeklyCards.weekContext, { user_id: userId, from: bounds.start, to: bounds.end });
  const sessions: WeekCardSession[] = [];
  let cursor: string | null = null;
  for (;;) {
    const page: { sessions: WeekCardSession[]; cursor: string; done: boolean } = await ctx.runQuery(internal.weeklyCards.sessionPage, {
      user_id: userId,
      from: bounds.start,
      to: bounds.end + SESSION_CREDIT_CAP_MS,
      cursor,
    });
    sessions.push(...page.sessions);
    if (page.done) break;
    cursor = page.cursor;
  }
  const stats = buildWeekCard({ bounds, tz, now, sessions, devices, tokenHours });
  const id = await ctx.runMutation(internal.weeklyCards.store, { user_id: userId, tz, stats });
  await ctx.scheduler.runAfter(0, internal.analytics.capture, { event: "weekly_card_generated", distinctId: userId, properties: { which, trigger } });
  return id;
}

/** Build (or rebuild) the signed-in person's card for last week or the week so far. */
export const generate = action({
  args: { which: v.union(v.literal("last"), v.literal("current")), tz: v.optional(v.string()) },
  handler: async (ctx, { which, tz }): Promise<Id<"weekly_cards"> | null> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not signed in");
    return await buildFor(ctx, userId, which, tz, "manual");
  },
});

/** Who gets a card built on Monday: allowed, opted in, and without last week's card yet. */
export const mondayAudience = internalQuery({
  args: {},
  handler: async (ctx) => {
    const optedIn = await ctx.db.query("users").withIndex("by_weekly_card", (q) => q.eq("weekly_card_enabled", true)).collect();
    return optedIn.filter((u: Doc<"users">) => weeklyCardAllowed(u)).map((u) => ({ user_id: u._id, tz: u.timezone ?? "UTC" }));
  },
});

export const notifyReady = internalMutation({
  args: { user_id: v.id("users"), card_id: v.id("weekly_cards") },
  handler: async (ctx, { user_id, card_id }) => {
    const card = await ctx.db.get(card_id);
    if (!card || card.notified_at) return;
    await ctx.db.patch(card_id, { notified_at: Date.now() });
    const s = card.stats as WeekCardStats;
    await emitNotification(ctx, {
      event_type: "weekly_card",
      actor_name: "Codecast",
      entity_type: "weekly_card",
      entity_id: card.week_key,
      message: `Your week: ${s.sessions} sessions, ${s.agent_hours}h with an agent working`,
      recipient_ids: [user_id],
      quiet: true,
    });
  },
});

/**
 * Hourly: for each opted-in person whose local Monday has begun, build last
 * week's card once and tell them it is ready. A person whose week has not
 * turned yet is skipped until it has.
 */
export const mondaySweep = internalAction({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const people: Array<{ user_id: Id<"users">; tz: string }> = await ctx.runQuery(internal.weeklyCards.mondayAudience, {});
    for (const p of people) {
      const tz = isKnownTimeZone(p.tz) ? p.tz : "UTC";
      const key = weekBounds(now, tz, "last").key;
      const has = await ctx.runQuery(internal.weeklyCards.cardFor, { user_id: p.user_id, week_key: key });
      if (has?.notified_at) continue;
      const id = has?._id ?? (await buildFor(ctx, p.user_id, "last", tz, "monday"));
      if (id) await ctx.runMutation(internal.weeklyCards.notifyReady, { user_id: p.user_id, card_id: id });
    }
  },
});

export const cardFor = internalQuery({
  args: { user_id: v.id("users"), week_key: v.string() },
  handler: async (ctx, { user_id, week_key }) =>
    await ctx.db.query("weekly_cards").withIndex("by_user_week", (q) => q.eq("user_id", user_id).eq("week_key", week_key)).first(),
});

/** The owner's optional parts. Locked while the card is public, so the page only ever shows what was confirmed. */
export async function setWeeklyCardOptionsFor(
  ctx: { db: any },
  userId: Id<"users">,
  cardId: string,
  opts: { show_projects?: boolean; show_tokens?: boolean },
): Promise<void> {
  const id = ctx.db.normalizeId("weekly_cards", cardId);
  const card: Doc<"weekly_cards"> | null = id ? await ctx.db.get(id) : null;
  if (!card || String(card.user_id) !== String(userId)) throw new Error("Not found");
  if (card.share_token) throw new Error("Unpublish the card to change what it shows");
  const patch: Record<string, boolean> = {};
  if (opts.show_projects !== undefined) patch.show_projects = opts.show_projects;
  if (opts.show_tokens !== undefined) patch.show_tokens = opts.show_tokens;
  await ctx.db.patch(card._id, patch);
}

export async function setWeeklyCardEnabledFor(ctx: { db: any }, userId: Id<"users">, enabled: boolean): Promise<void> {
  const user = await ctx.db.get(userId);
  if (!weeklyCardAllowed(user)) throw new Error("Not available");
  await ctx.db.patch(userId, { weekly_card_enabled: enabled || undefined });
}
