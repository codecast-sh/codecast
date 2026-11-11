// Seat billing for teams (ct-70845): what the invite UI reads, the Stripe
// checkout and portal an admin opens, the mapping of a team's subscription
// from Stripe, and the seat sync that keeps the subscription's quantity equal
// to the team's members. The decision rules live in lib/teamSeats.ts.
//
// Stripe events are prompts, as for the wallet (billing.ts): the shared
// webhook reads the subscription as it stands, sees `metadata.kind` is
// team_seats, and hands it to `applyTeamSubscription`, which keeps the newest
// read (`subscription_read_at`) so a late event cannot move the plan back.
//
// Seat sync runs after every membership change on a team with a live
// subscription (join, leave, removal, team delete or restore) and after each
// mapped subscription change. It reads the member count, sets the quantity
// with proration, and reads the count again, so concurrent runs settle on the
// last count. Pending invites are not billed; they only hold free capacity.
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import {
  checkoutParams,
  createStripe,
  isLiveSubscription,
  isStripeRefusal,
  StripeError,
  stripeId,
  subscriptionPeriod,
  subscriptionPriceId,
  type StripeClient,
  type StripeSubscription,
  type StripeSubscriptionItem,
} from "@platform/billing";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { ActionCtx, MutationCtx } from "./_generated/server";
import type { FunctionReturnType } from "convex/server";
import { action, internalAction, internalMutation, internalQuery, query } from "./functions";
import type { BillingRedirect } from "./billing";
import { siteUrl } from "./lib/siteUrl";
import {
  STARTER_FREE_CAPACITY,
  TEAM_SEATS_KIND,
  countSeats,
  grandfathered,
  isLapsed,
  isSeatPrice,
  scheduleSeatSync,
  seatBillingEnv,
  seatBillingOn,
  seatPlan,
  seatPriceId,
  teamSubscriptionRow,
  type SeatPlan,
} from "./lib/teamSeats";

/** What the invite panel shows. `enforced: false` means seat billing is off
 *  here and nothing about it should render. */
export type SeatState =
  | { enforced: false }
  | {
      enforced: true;
      plan: SeatPlan;
      /** Stripe's status for the team's subscription, if it ever had one. */
      status: string | null;
      lapsed: boolean;
      trial_end: number | null;
      current_period_end: number | null;
      cancel_at_period_end: boolean;
      members: number;
      pending: number;
      free_capacity: number;
      grandfathered: boolean;
      /** When grandfathering ends for every team, if it ends. */
      grandfathered_until: number | null;
      /** Starter with no free seat left: the next invite needs Pro. */
      full: boolean;
      /** Starter with more members than it covers and no grandfathering left: the team should be on Pro. */
      needs_pro: boolean;
      team_name: string;
      is_admin: boolean;
      /** A Stripe customer exists, so the portal has something to show. */
      has_billing: boolean;
    };

async function membershipOf(ctx: { db: any }, userId: Id<"users">, teamId: Id<"teams">): Promise<Doc<"team_memberships"> | null> {
  return ctx.db.query("team_memberships").withIndex("by_user_team", (q: any) => q.eq("user_id", userId).eq("team_id", teamId)).first();
}

export const getSeatState = query({
  args: { team_id: v.id("teams") },
  handler: async (ctx, { team_id }): Promise<SeatState | null> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    const membership = await membershipOf(ctx, userId, team_id);
    if (!membership) return null;
    const env = seatBillingEnv();
    if (!seatBillingOn(env)) return { enforced: false };
    const team = await ctx.db.get(team_id);
    if (!team || team.deleted_at) return null;
    const row = await teamSubscriptionRow(ctx, team_id);
    const counts = await countSeats(ctx, team);
    const plan = seatPlan(row);
    const old = plan === "starter" && grandfathered(row, counts, Date.now(), env.grandfatherUntil);
    return {
      enforced: true,
      plan,
      status: row?.subscription_status ?? null,
      lapsed: plan === "starter" && isLapsed(row?.subscription_status),
      trial_end: row?.subscription_status === "trialing" ? row.trial_end ?? null : null,
      current_period_end: row?.current_period_end ?? null,
      cancel_at_period_end: !!row?.cancel_at_period_end,
      members: counts.members,
      pending: counts.pending,
      free_capacity: STARTER_FREE_CAPACITY,
      grandfathered: old,
      grandfathered_until: env.grandfatherUntil ?? null,
      full: plan === "starter" && !old && counts.members + counts.pending >= STARTER_FREE_CAPACITY,
      needs_pro: plan === "starter" && !old && counts.members > STARTER_FREE_CAPACITY,
      team_name: team.name,
      is_admin: membership.role === "admin",
      has_billing: !!row?.stripe_customer_id,
    };
  },
});

/** What the checkout, offer and portal actions need, for an admin of a live team. */
export const seatContext = internalQuery({
  args: { team_id: v.id("teams"), user_id: v.optional(v.id("users")) },
  handler: async (ctx, { team_id, user_id }) => {
    const team = await ctx.db.get(team_id);
    if (!team) return null;
    const row = await teamSubscriptionRow(ctx, team_id);
    const counts = await countSeats(ctx, team);
    const user = user_id ? await ctx.db.get(user_id) : null;
    const membership = user_id ? await membershipOf(ctx, user_id, team_id) : null;
    return {
      team_name: team.name,
      deleted: !!team.deleted_at,
      is_admin: membership?.role === "admin",
      email: user?.email ?? null,
      members: counts.members,
      customer: row?.stripe_customer_id ?? null,
      subscription_id: row?.stripe_subscription_id ?? null,
      ever_subscribed: !!row?.stripe_subscription_id,
    };
  },
});

const UNAVAILABLE: BillingRedirect = { ok: false, code: "unavailable", error: "Team plans are not on sale here yet." };
const SIGNED_OUT: BillingRedirect = { ok: false, code: "signed_out", error: "Sign in to manage the team's plan." };
const NOT_ADMIN: BillingRedirect = { ok: false, code: "bad_request", error: "Only a team admin can change the team's plan." };

const refusalText = (r: BillingRedirect) => (r.ok ? "" : r.error);

function stripeRefusal(error: unknown): BillingRedirect {
  if (!(error instanceof StripeError)) throw error;
  console.error(`[seat-billing] Stripe refused (${error.status} ${error.code ?? error.type ?? ""}): ${error.message}`);
  return { ok: false, code: "stripe_error", error: "Stripe could not start that just now. Try again in a minute." };
}

function teamReturnUrl(outcome?: "done" | "canceled"): string {
  return `${siteUrl()}/settings/team${outcome ? `?seats=${outcome}` : ""}`;
}

/** How long a repeated checkout reuses the first one's session, as billing.ts does for plans. */
const CHECKOUT_REUSE_MS = 60_000;

type SeatContext = NonNullable<FunctionReturnType<typeof internal.teamBilling.seatContext>>;

async function adminContext(ctx: ActionCtx, team_id: Id<"teams">): Promise<{ refusal: BillingRedirect } | { userId: Id<"users">; context: SeatContext }> {
  const userId = await getAuthUserId(ctx);
  if (!userId) return { refusal: SIGNED_OUT };
  const context = await ctx.runQuery(internal.teamBilling.seatContext, { team_id, user_id: userId });
  if (!context || context.deleted || !context.is_admin) return { refusal: NOT_ADMIN };
  return { userId, context };
}

async function liveSeatSubscription(stripe: StripeClient, customer: string | null): Promise<boolean> {
  if (!customer) return false;
  return (await stripe.listSubscriptions(customer)).some((s) => isLiveSubscription(s.status) && s.metadata?.kind === TEAM_SEATS_KIND);
}

async function portal(stripe: StripeClient, customer: string): Promise<BillingRedirect> {
  const env = seatBillingEnv();
  const session = await stripe.createPortalSession({ customer, returnUrl: teamReturnUrl(), configuration: env.portalConfiguration });
  return { ok: true, url: session.url, via: "portal" };
}

/** One seat price as Stripe will charge it. */
export type SeatPrice = { unit_amount: number; currency: string; interval: string; interval_count: number };

/** The prices the upgrade review shows, read from Stripe so the screen says
 *  what Stripe will charge. `annual` is null where no yearly price is set. */
export type SeatOffer =
  | { ok: true; monthly: SeatPrice; annual: SeatPrice | null; trial_days: number; seats: number }
  | { ok: false; error: string };

async function readSeatPrice(stripe: StripeClient, name: string, priceId: string): Promise<SeatPrice | null> {
  const price = await stripe.getPrice(priceId);
  if (price.active === false || typeof price.unit_amount !== "number" || !price.recurring) {
    console.error(`[seat-billing] ${name} ${priceId} is not an active recurring price with a unit amount`);
    return null;
  }
  return { unit_amount: price.unit_amount, currency: price.currency ?? "usd", interval: price.recurring.interval, interval_count: price.recurring.interval_count };
}

export const seatOffer = action({
  args: { team_id: v.id("teams") },
  handler: async (ctx, { team_id }): Promise<SeatOffer> => {
    const env = seatBillingEnv();
    if (!seatBillingOn(env)) return { ok: false, error: refusalText(UNAVAILABLE) };
    const admin = await adminContext(ctx, team_id);
    if ("refusal" in admin) return { ok: false, error: refusalText(admin.refusal) };
    try {
      const stripe = createStripe({ secretKey: env.secretKey! });
      const [monthly, annual] = await Promise.all([
        readSeatPrice(stripe, "STRIPE_PRICE_TEAM_SEAT", env.priceId!),
        env.annualPriceId ? readSeatPrice(stripe, "STRIPE_PRICE_TEAM_SEAT_ANNUAL", env.annualPriceId) : null,
      ]);
      if (!monthly) return { ok: false, error: "The team plan's price is not set up." };
      return {
        ok: true,
        monthly,
        annual,
        trial_days: admin.context.ever_subscribed ? 0 : env.trialDays,
        seats: Math.max(1, admin.context.members),
      };
    } catch (error) {
      return { ok: false, error: refusalText(stripeRefusal(error)) };
    }
  },
});

const seatBillingArg = v.union(v.literal("monthly"), v.literal("annual"));

/** Starts Pro for a team: Stripe checkout for one seat per member, billed
 *  monthly or yearly, with the trial on a team's first subscription. A team
 *  Stripe already holds a live seat subscription for gets the portal instead
 *  of a second subscription. */
export const startSeatCheckout = action({
  args: { team_id: v.id("teams"), billing: v.optional(seatBillingArg) },
  handler: async (ctx, { team_id, billing }): Promise<BillingRedirect> => {
    const env = seatBillingEnv();
    if (!seatBillingOn(env)) return UNAVAILABLE;
    const admin = await adminContext(ctx, team_id);
    if ("refusal" in admin) return admin.refusal;
    const { userId, context } = admin;
    const stripe = createStripe({ secretKey: env.secretKey! });
    try {
      if (context.customer && (await liveSeatSubscription(stripe, context.customer))) return await portal(stripe, context.customer);
      const metadata = { kind: TEAM_SEATS_KIND, team_id };
      const seats = Math.max(1, context.members);
      const params = checkoutParams({
        mode: "subscription",
        price: seatPriceId(env, billing)!,
        quantity: seats,
        successUrl: teamReturnUrl("done"),
        cancelUrl: teamReturnUrl("canceled"),
        customer: context.customer ?? undefined,
        customerEmail: context.email ?? undefined,
        clientReferenceId: team_id,
        metadata,
        allowPromotionCodes: true,
      });
      const trialDays = context.ever_subscribed ? 0 : env.trialDays;
      params.subscription_data = { metadata, ...(trialDays > 0 ? { trial_period_days: trialDays } : {}) };
      const session = await stripe.request<{ id?: string; url?: string }>("POST", "checkout/sessions", params, {
        idempotencyKey: `team-checkout:${team_id}:${userId}:${context.customer ?? "new"}:${billing ?? "monthly"}:${Math.floor(Date.now() / CHECKOUT_REUSE_MS)}`,
      });
      if (!session.url) throw new StripeError("Stripe returned a checkout session without a url", 200);
      await ctx.runMutation(internal.teamBilling.markCheckoutStarted, { team_id, seats });
      return { ok: true, url: session.url, via: "checkout" };
    } catch (error) {
      return stripeRefusal(error);
    }
  },
});

/** Stripe's billing portal for the team: card, invoices, cancel. */
export const openSeatPortal = action({
  args: { team_id: v.id("teams") },
  handler: async (ctx, { team_id }): Promise<BillingRedirect> => {
    const env = seatBillingEnv();
    if (!seatBillingOn(env)) return UNAVAILABLE;
    const admin = await adminContext(ctx, team_id);
    if ("refusal" in admin) return admin.refusal;
    if (!admin.context.customer) return { ok: false, code: "no_customer", error: "The team has no plan to manage yet." };
    try {
      return await portal(createStripe({ secretKey: env.secretKey! }), admin.context.customer);
    } catch (error) {
      return stripeRefusal(error);
    }
  },
});

// ---------------------------------------------------------------------------
// Mapping and sync

async function upsertRow(ctx: MutationCtx, teamId: Id<"teams">, patch: Partial<Doc<"team_subscriptions">>): Promise<void> {
  const row = await teamSubscriptionRow(ctx, teamId);
  if (row) await ctx.db.patch(row._id, patch);
  else await ctx.db.insert("team_subscriptions", { team_id: teamId, ...patch });
}

export const markCheckoutStarted = internalMutation({
  args: { team_id: v.id("teams"), seats: v.optional(v.number()) },
  // The grace window opens once: a checkout reopened (or abandoned and opened
  // again) keeps the first one's start, until a subscription is mapped and
  // clears it (applyTeamSubscription).
  // A team the gate would grandfather now is stamped first, since an open
  // checkout ends grandfathering by counts (lib/teamSeats grandfathered).
  handler: async (ctx, { team_id, seats }) => {
    const row = await teamSubscriptionRow(ctx, team_id);
    if (row?.checkout_started_at) return;
    const team = await ctx.db.get(team_id);
    const now = Date.now();
    const stamp = team && !row?.grandfathered_at && grandfathered(row, await countSeats(ctx, team), now, seatBillingEnv().grandfatherUntil);
    await upsertRow(ctx, team_id, { checkout_started_at: now, checkout_seats: seats ?? 0, ...(stamp ? { grandfathered_at: now } : {}) });
  },
});

export const markRefreshFailed = internalMutation({
  args: { team_id: v.id("teams") },
  handler: async (ctx, { team_id }) => upsertRow(ctx, team_id, { refresh_failed_at: Date.now() }),
});

const ENDED_STATUSES: readonly string[] = ["canceled", "incomplete_expired"];

/** Maps a team's seat subscription, as read from Stripe at `read_at`, onto
 *  its row. `sync: false` from the seat sync itself, which has just set the
 *  quantity; any other mapping of a live subscription runs a sync, which does
 *  nothing when the quantity already matches. */
export const applyTeamSubscription = internalMutation({
  args: { subscription_json: v.string(), read_at: v.number(), sync: v.optional(v.boolean()) },
  handler: async (ctx, args): Promise<string> => {
    const sub: StripeSubscription & { trial_end?: number | null } = JSON.parse(args.subscription_json);
    const customer = stripeId(sub.customer);
    const fromMetadata = sub.metadata?.team_id ? ctx.db.normalizeId("teams", sub.metadata.team_id) : null;
    const byCustomer = !fromMetadata && customer
      ? await ctx.db.query("team_subscriptions").withIndex("by_customer", (q) => q.eq("stripe_customer_id", customer)).first()
      : null;
    const teamId = fromMetadata ?? byCustomer?.team_id ?? null;
    if (!teamId || !(await ctx.db.get(teamId))) return "ignored:no_team";
    const row = await teamSubscriptionRow(ctx, teamId);
    const same = row?.stripe_subscription_id === sub.id;
    if (same) {
      if (row.subscription_read_at !== undefined && args.read_at < row.subscription_read_at) return "ignored:stale_read";
      if (ENDED_STATUSES.includes(row.subscription_status ?? "") && !ENDED_STATUSES.includes(sub.status)) return "ignored:ended";
    } else if (row?.stripe_subscription_id && isLiveSubscription(row.subscription_status) && !isLiveSubscription(sub.status)) {
      // A late event about a subscription the team has moved off.
      return "ignored:other_subscription";
    }
    const period = subscriptionPeriod(sub);
    const item = sub.items?.data?.[0];
    await upsertRow(ctx, teamId, {
      stripe_customer_id: customer ?? row?.stripe_customer_id,
      stripe_subscription_id: sub.id,
      subscription_status: sub.status,
      price_id: subscriptionPriceId(sub) ?? undefined,
      quantity: item?.quantity,
      trial_end: typeof sub.trial_end === "number" ? sub.trial_end * 1000 : undefined,
      current_period_end: period?.end,
      cancel_at_period_end: !!sub.cancel_at_period_end,
      subscription_read_at: args.read_at,
      refresh_failed_at: undefined,
      checkout_started_at: undefined,
      checkout_seats: undefined,
    });
    if (args.sync !== false && isLiveSubscription(sub.status)) await scheduleSeatSync(ctx, teamId, "subscription_changed");
    return `team:${sub.status}`;
  },
});

/** The seat sync: quantity = human members, prorated. A deleted team's
 *  subscription is set to end at the period's end instead. */
export const syncSeats = internalAction({
  args: { team_id: v.id("teams"), reason: v.string() },
  handler: async (ctx, { team_id, reason }): Promise<string> => {
    const env = seatBillingEnv();
    if (!seatBillingOn(env)) return "off";
    let context = await ctx.runQuery(internal.teamBilling.seatContext, { team_id });
    const subscriptionId = context?.subscription_id;
    if (!context || !subscriptionId) return "no_subscription";
    const stripe = createStripe({ secretKey: env.secretKey! });
    const apply = (sub: StripeSubscription) =>
      ctx.runMutation(internal.teamBilling.applyTeamSubscription, { subscription_json: JSON.stringify(sub), read_at: Date.now(), sync: false });
    try {
      let sub = await stripe.getSubscription(subscriptionId);
      if (!isLiveSubscription(sub.status)) {
        await apply(sub);
        return "not_live";
      }
      if (context.deleted) {
        if (!sub.cancel_at_period_end) {
          sub = await stripe.request<StripeSubscription>("POST", `subscriptions/${encodeURIComponent(subscriptionId)}`, { cancel_at_period_end: true });
          console.log(`[seat-billing] team=${team_id} deleted; ${subscriptionId} ends at the period's end`);
        }
        await apply(sub);
        return "cancel_at_period_end";
      }
      const item = sub.items?.data?.find((i) => isSeatPrice(env, i.price?.id)) ?? sub.items?.data?.[0];
      if (!item) return "no_item";
      let quantity = item.quantity ?? null;
      const before = quantity;
      // Set, then count again: a change that landed during the call is picked
      // up here rather than left to a run that may have read earlier.
      for (let attempt = 0; attempt < 3 && context; attempt++) {
        const seats = Math.max(1, context.members);
        if (quantity === seats) break;
        const updated = await stripe.request<StripeSubscriptionItem>("POST", `subscription_items/${encodeURIComponent(item.id)}`, {
          quantity: seats,
          proration_behavior: "create_prorations",
        });
        quantity = updated.quantity ?? seats;
        context = await ctx.runQuery(internal.teamBilling.seatContext, { team_id });
      }
      if (quantity !== before) {
        sub = await stripe.getSubscription(subscriptionId);
        console.log(`[seat-billing] team=${team_id} reason=${reason} quantity ${before} -> ${quantity}`);
      }
      await apply(sub);
      return quantity === before ? "unchanged" : "synced";
    } catch (error) {
      if (isStripeRefusal(error)) {
        console.error(`[seat-billing] team=${team_id} reason=${reason}: Stripe refused the seat sync (${error.status}): ${error.message}`);
        return "refused";
      }
      // Stripe unreachable: the plan is unconfirmed until a later read
      // succeeds, and the gate fails open meanwhile (lib/teamSeats.ts).
      await ctx.runMutation(internal.teamBilling.markRefreshFailed, { team_id });
      console.warn(`[seat-billing] team=${team_id} reason=${reason}: seat sync could not reach Stripe: ${error instanceof Error ? error.message : String(error)}`);
      return "refresh_failed";
    }
  },
});
