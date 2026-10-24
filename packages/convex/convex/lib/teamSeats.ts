// Seat billing for teams (ct-70845, plan pl-946; modelled on HumanLayer's
// free-capacity.ts and billing-access-decision.ts). A team is on Starter, free
// while its members plus pending invites fit in STARTER_FREE_CAPACITY, or on
// Pro, a Stripe subscription billed per member seat.
//
// The gate (`checkSeat`) runs wherever a seat is added: an emailed invite, a
// join by link, an approved join request, a GitHub org import. It answers
// from the team's own row (team_subscriptions), which the Stripe webhook and
// the seat sync keep as a copy of the subscription.
//
// The failure policy is HumanLayer's, deliberately asymmetric:
//  - fail open when the plan cannot be confirmed for a reason that may pass
//    (a checkout still landing, a subscription whose first payment is still
//    processing, a Stripe read that failed since the last good one);
//  - block on a confirmed lapse (Stripe says canceled, unpaid, paused or
//    expired), but only for seats past the free capacity: a lapsed team
//    within it is simply on Starter;
//  - log both, with the operation and the team.
//
// Billable seats are human members (bots and Slack shadows are memberships
// too, but no seat). Pending invites hold free capacity and are not billed.
//
// Everything is off unless STRIPE_PRICE_TEAM_SEAT and both Stripe secrets are
// set: with no price nobody is limited and nothing syncs, and with no secrets
// there would be no way to upgrade, so nothing is limited either.
//
// Teams already over the free capacity when the gate first judges them are
// grandfathered: stamped once, they keep adding seats with no plan. That
// never breaks a working team; an operator clears `grandfathered_at` to end it.
import { isLiveSubscription } from "@platform/billing";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { internal } from "../_generated/api";

export const STARTER_FREE_CAPACITY = 3;

/** `metadata.kind` on a team's seat subscription (and its checkout): how the
 *  shared Stripe webhook tells it from a hosted-assistant plan. */
export const TEAM_SEATS_KIND = "team_seats";

export function isTeamSeatSubscription(subscription: { metadata?: Record<string, string> | null } | null | undefined): boolean {
  return subscription?.metadata?.kind === TEAM_SEATS_KIND;
}

/** How long after an admin opens checkout the gate trusts that a subscription is on its way. */
export const CHECKOUT_GRACE_MS = 60 * 60 * 1000;

/** Statuses Stripe reports for a subscription that no longer pays for anything. */
const LAPSED_STATUSES: readonly string[] = ["canceled", "unpaid", "incomplete_expired", "paused"];

export interface SeatBillingEnv {
  priceId?: string;
  trialDays: number;
  secretKey?: string;
  webhookSecret?: string;
  /** The billing portal configuration team portals use; Stripe's default when absent. */
  portalConfiguration?: string;
}

export function seatBillingEnv(env: Record<string, string | undefined> = process.env): SeatBillingEnv {
  const read = (name: string) => env[name]?.trim() || undefined;
  const trial = Number(read("TEAM_SEAT_TRIAL_DAYS") ?? 0);
  return {
    priceId: read("STRIPE_PRICE_TEAM_SEAT"),
    trialDays: Number.isFinite(trial) && trial > 0 ? Math.floor(trial) : 0,
    secretKey: read("STRIPE_SECRET_KEY"),
    webhookSecret: read("STRIPE_WEBHOOK_SECRET"),
    portalConfiguration: read("STRIPE_TEAM_PORTAL_CONFIGURATION"),
  };
}

/** Whether seat billing is on: a seat price, and the secrets to sell it and hear back. */
export function seatBillingOn(env: SeatBillingEnv = seatBillingEnv()): boolean {
  return !!env.priceId && !!env.secretKey && !!env.webhookSecret;
}

export interface SeatCounts {
  /** Human members. */
  members: number;
  /** Emailed invites and join requests still waiting. */
  pending: number;
}

/** Why a seat was refused, with what the invite UI needs to offer the upgrade. */
export interface SeatLimit {
  code: "upgrade_required" | "subscription_lapsed";
  message: string;
  current_seats: number;
  pending_invites: number;
  free_capacity: number;
  action_label: string;
}

export type SeatPlan = "starter" | "pro";

export type SeatDecision =
  | { kind: "allowed"; plan: SeatPlan; why: "billing_off" | "subscribed" | "within_free" | "grandfathered" }
  | { kind: "fail_open"; why: "checkout_pending" | "payment_processing" | "plan_unconfirmed" }
  | { kind: "blocked"; limit: SeatLimit };

export interface SeatInput {
  on: boolean;
  row: Pick<Doc<"team_subscriptions">, "subscription_status" | "subscription_read_at" | "refresh_failed_at" | "checkout_started_at" | "grandfathered_at" | "stripe_customer_id"> | null;
  counts: SeatCounts;
  /** Seats the operation adds: 1 for an invite or a join. */
  adding: number;
  now: number;
}

export function seatLimit(code: SeatLimit["code"], counts: SeatCounts): SeatLimit {
  return {
    code,
    message: code === "subscription_lapsed"
      ? `The team's Pro plan has lapsed. Starter is free for up to ${STARTER_FREE_CAPACITY} members and pending invites; renew Pro to add more.`
      : `Starter is free for up to ${STARTER_FREE_CAPACITY} members and pending invites. Upgrade to Pro to add more.`,
    current_seats: counts.members,
    pending_invites: counts.pending,
    free_capacity: STARTER_FREE_CAPACITY,
    action_label: code === "subscription_lapsed" ? "Renew Pro" : "Upgrade to Pro",
  };
}

/** The plan a row puts a team on: Pro while its subscription is live. */
export function seatPlan(row: SeatInput["row"]): SeatPlan {
  return row && isLiveSubscription(row.subscription_status) ? "pro" : "starter";
}

export function isLapsed(status: string | null | undefined): boolean {
  return !!status && LAPSED_STATUSES.includes(status);
}

/** Whether the team was over the free capacity before seat billing judged it:
 *  stamped already, or never subscribed and over capacity now. Only a team
 *  that existed before the gate can be over it without a plan. */
export function grandfathered(row: SeatInput["row"], counts: SeatCounts): boolean {
  if (row?.grandfathered_at) return true;
  return !row?.stripe_customer_id && counts.members + counts.pending > STARTER_FREE_CAPACITY;
}

/** The pure decision; `checkSeat` adds the reads, the stamp and the log. */
export function decideSeat({ on, row, counts, adding, now }: SeatInput): SeatDecision {
  if (!on) return { kind: "allowed", plan: "starter", why: "billing_off" };
  if (seatPlan(row) === "pro") return { kind: "allowed", plan: "pro", why: "subscribed" };
  if (counts.members + counts.pending + adding <= STARTER_FREE_CAPACITY) return { kind: "allowed", plan: "starter", why: "within_free" };
  if (grandfathered(row, counts)) return { kind: "allowed", plan: "starter", why: "grandfathered" };
  const status = row?.subscription_status;
  if (row?.refresh_failed_at && row.refresh_failed_at > (row.subscription_read_at ?? 0)) return { kind: "fail_open", why: "plan_unconfirmed" };
  if (status === "incomplete") return { kind: "fail_open", why: "payment_processing" };
  if (!isLapsed(status) && row?.checkout_started_at && now - row.checkout_started_at < CHECKOUT_GRACE_MS) return { kind: "fail_open", why: "checkout_pending" };
  return { kind: "blocked", limit: seatLimit(isLapsed(status) ? "subscription_lapsed" : "upgrade_required", counts) };
}

type Ctx = QueryCtx | MutationCtx;

export async function teamSubscriptionRow(ctx: Ctx, teamId: Id<"teams">): Promise<Doc<"team_subscriptions"> | null> {
  return ctx.db.query("team_subscriptions").withIndex("by_team", (q) => q.eq("team_id", teamId)).first();
}

/** Whom a count leaves out: the person joining, whose own invite or request
 *  becomes their membership rather than a second seat. */
export interface SeatExclusion {
  userId?: Id<"users">;
  email?: string | null;
}

export async function countSeats(ctx: Ctx, team: Doc<"teams">, exclude: SeatExclusion = {}): Promise<SeatCounts> {
  const memberships = await ctx.db.query("team_memberships").withIndex("by_team_id", (q) => q.eq("team_id", team._id)).collect();
  const memberEmails = new Set<string>();
  let members = 0;
  for (const m of memberships) {
    const user = await ctx.db.get(m.user_id);
    if (!user || user.is_bot) continue;
    members++;
    if (user.email) memberEmails.add(user.email.toLowerCase());
  }
  const excludedEmail = exclude.email?.trim().toLowerCase();
  const now = Date.now();
  const linkLive = !team.invite_code_expires_at || now <= team.invite_code_expires_at;
  const invites = linkLive
    ? (await ctx.db.query("team_invites").withIndex("by_team_email", (q) => q.eq("team_id", team._id)).collect())
        .filter((i) => !i.accepted_at && i.invite_code === team.invite_code && !memberEmails.has(i.email) && i.email !== excludedEmail)
    : [];
  const requests = (await ctx.db.query("team_join_requests").withIndex("by_team_status", (q) => q.eq("team_id", team._id).eq("status", "pending")).collect())
    .filter((r) => r.user_id !== exclude.userId);
  return { members, pending: invites.length + requests.length };
}

/** Judges adding `adding` seats to `team` for `operation`, logs a fail-open or
 *  a block, and stamps a grandfathered team the first time it is judged over. */
export async function checkSeat(
  ctx: MutationCtx,
  team: Doc<"teams">,
  operation: string,
  opts: { adding?: number; exclude?: SeatExclusion } = {},
): Promise<SeatDecision> {
  const on = seatBillingOn();
  if (!on) return { kind: "allowed", plan: "starter", why: "billing_off" };
  const row = await teamSubscriptionRow(ctx, team._id);
  const counts = await countSeats(ctx, team, opts.exclude);
  const decision = decideSeat({ on, row, counts, adding: opts.adding ?? 1, now: Date.now() });
  const where = `team=${team._id} op=${operation} members=${counts.members} pending=${counts.pending} status=${row?.subscription_status ?? "none"}`;
  if (decision.kind === "allowed" && decision.why === "grandfathered" && !row?.grandfathered_at) {
    if (row) await ctx.db.patch(row._id, { grandfathered_at: Date.now() });
    else await ctx.db.insert("team_subscriptions", { team_id: team._id, grandfathered_at: Date.now() });
    console.log(`[seat-billing] grandfathered ${where}`);
  }
  if (decision.kind === "fail_open") console.warn(`[seat-billing] fail_open reason=${decision.why} ${where}`);
  if (decision.kind === "blocked") console.warn(`[seat-billing] blocked reason=${decision.limit.code} ${where}`);
  return decision;
}

export type SeatSyncReason = "member_joined" | "member_left" | "team_deleted" | "team_restored" | "subscription_changed";

/** Brings the Stripe seat quantity in line with the members, after a change
 *  that may have moved it. A team without a live subscription has nothing to
 *  sync; the action re-reads everything, so a spare run costs one Stripe read. */
export async function scheduleSeatSync(ctx: MutationCtx, teamId: Id<"teams">, reason: SeatSyncReason): Promise<void> {
  if (!seatBillingOn()) return;
  const row = await teamSubscriptionRow(ctx, teamId);
  if (!row?.stripe_subscription_id || !isLiveSubscription(row.subscription_status)) return;
  await ctx.scheduler.runAfter(0, internal.teamBilling.syncSeats, { team_id: teamId, reason });
}
