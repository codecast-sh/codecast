// Plans and top-ups through Stripe (plan pl-840, docs/architecture/hosted-assistant.md
// "Billing" and "Plans"). @platform/billing carries the Stripe mechanics; this
// module says which price is which plan and maps Stripe's events onto the
// wallet (lib/wallet.ts): a subscription moves the plan, a paid top-up credits
// the top-up balance, and a paid renewal puts the wallet on Stripe's period.
//
// Everything is gated on env. With no keys `billingAvailable` says so, the
// actions answer `unavailable` instead of throwing, and plans are granted by
// hand (internal.wallet.setPlan). Checkout needs the webhook secret as well as
// the API key: a checkout whose events never arrive takes money and grants
// nothing.
//
// Every mapping is idempotent and tolerates Stripe's delivery order: a plan
// is set from the event's own facts, a top-up lands once per payment
// (wallet_ledger.external_id), and a period the wallet already holds changes
// nothing.
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import {
  BILLING_EVENT_TYPES,
  createStripe,
  invoiceOpensPeriod,
  invoicePeriod,
  invoiceSubscriptionId,
  invoiceSubscriptionMetadata,
  isLiveSubscription,
  StripeError,
  stripeId,
  subscriptionPriceId,
  verifyWebhook,
  type StripeCheckoutSession,
  type StripeInvoice,
  type StripeSubscription,
} from "@platform/billing";
import { PLAN_IDS, planOf, type PlanId } from "@codecast/shared/contracts/assistant";
import { httpAction } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { action, internalMutation, internalQuery, query } from "./functions";
import { siteUrl } from "./lib/siteUrl";
import { alignPeriod, credit, setPlan, walletRow } from "./lib/wallet";

/** Where Stripe posts events: `<convex site>/api/webhooks/stripe`. */
export const STRIPE_WEBHOOK_PATH = "/api/webhooks/stripe";

/** The web page checkout and the portal return to, with `?billing=` set to
 *  `done`, `topup` or `canceled` after a checkout. */
export const BILLING_RETURN_PATH = "/simple/plan";

/** The plans that cost money, each sold through the price in
 *  `STRIPE_PRICE_<PLAN>` (STRIPE_PRICE_PLUS, STRIPE_PRICE_PRO). */
export const PAID_PLANS = PLAN_IDS.filter((id) => planOf(id).price_usd > 0);
export type PaidPlan = Exclude<PlanId, "free">;
const paidPlanValidator = v.union(v.literal("plus"), v.literal("pro"));

export function priceEnvName(plan: PlanId): string {
  return `STRIPE_PRICE_${plan.toUpperCase()}`;
}

export interface BillingEnv {
  secretKey?: string;
  webhookSecret?: string;
  prices: Partial<Record<PlanId, string>>;
  topupPrice?: string;
}

/** The billing config from env; absent values stay undefined. */
export function billingEnv(env: Record<string, string | undefined> = process.env): BillingEnv {
  const read = (name: string) => env[name]?.trim() || undefined;
  const prices: Partial<Record<PlanId, string>> = {};
  for (const plan of PAID_PLANS) {
    const price = read(priceEnvName(plan));
    if (price) prices[plan] = price;
  }
  return {
    secretKey: read("STRIPE_SECRET_KEY"),
    webhookSecret: read("STRIPE_WEBHOOK_SECRET"),
    prices,
    topupPrice: read("STRIPE_PRICE_TOPUP"),
  };
}

/** What the plan screen may offer. `available` is false until both Stripe
 *  secrets are set; `plans` lists the paid plans that have a price; `topup`
 *  says whether a top-up can be bought. */
export interface BillingStatus {
  available: boolean;
  plans: PlanId[];
  topup: boolean;
}

export function billingStatus(env: BillingEnv = billingEnv()): BillingStatus {
  const available = !!env.secretKey && !!env.webhookSecret;
  return {
    available,
    plans: available ? PAID_PLANS.filter((plan) => !!env.prices[plan]) : [],
    topup: available && !!env.topupPrice,
  };
}

/** The plan a Stripe price sells, or null for a price this deployment does not know. */
export function planForPrice(env: BillingEnv, priceId: string | null | undefined): PlanId | null {
  if (!priceId) return null;
  return PAID_PLANS.find((plan) => env.prices[plan] === priceId) ?? null;
}

function paidPlan(raw: string | null | undefined): PaidPlan | null {
  return raw && (PAID_PLANS as readonly string[]).includes(raw) ? (raw as PaidPlan) : null;
}

/** Whether the upgrade and top-up buttons can work here. Public, and safe
 *  signed out: it reads only which settings exist, never their values. */
export const billingAvailable = query({
  args: {},
  handler: async (): Promise<BillingStatus> => billingStatus(),
});

export type BillingRefusal = "unavailable" | "signed_out" | "bad_request" | "no_customer" | "stripe_error";

/** A page to send the person to, or why there is none. `via: "portal"` is a
 *  plan change for someone already subscribed: Stripe's portal changes the
 *  subscription in place instead of starting a second one. */
export type BillingRedirect =
  | { ok: true; url: string; via: "checkout" | "portal" }
  | { ok: false; code: BillingRefusal; error: string };

const UNAVAILABLE: BillingRedirect = {
  ok: false,
  code: "unavailable",
  error: "Payments are not set up here yet. Plans are granted by hand for now.",
};
const SIGNED_OUT: BillingRedirect = { ok: false, code: "signed_out", error: "Sign in to manage your plan." };

/** The wallet facts and email a checkout needs. */
export const checkoutContext = internalQuery({
  args: { user_id: v.id("users") },
  handler: async (ctx, { user_id }) => {
    const user = await ctx.db.get(user_id);
    const wallet = await walletRow(ctx, user_id);
    return {
      email: user?.email ?? null,
      customer: wallet?.stripe_customer_id ?? null,
      subscription_id: wallet?.stripe_subscription_id ?? null,
      subscription_status: wallet?.subscription_status ?? null,
    };
  },
});

function returnUrl(billing?: string): string {
  return `${siteUrl()}${BILLING_RETURN_PATH}${billing ? `?billing=${billing}` : ""}`;
}

function stripeRefusal(error: unknown): BillingRedirect {
  if (!(error instanceof StripeError)) throw error;
  console.error(`[billing] Stripe refused (${error.status} ${error.code ?? error.type ?? ""}): ${error.message}`);
  return { ok: false, code: "stripe_error", error: "Stripe could not start that just now. Try again in a minute." };
}

/** Starts a purchase for the signed-in person: `{ plan }` subscribes to a
 *  paid plan, `{ topup: true }` buys one top-up. Returns the Stripe page to
 *  open. Someone already on a live subscription who asks for a plan gets the
 *  portal, where the change applies to the subscription they have. */
export const startCheckout = action({
  args: { plan: v.optional(paidPlanValidator), topup: v.optional(v.boolean()) },
  handler: async (ctx, args): Promise<BillingRedirect> => {
    const env = billingEnv();
    if (!billingStatus(env).available) return UNAVAILABLE;
    const userId = await getAuthUserId(ctx);
    if (!userId) return SIGNED_OUT;
    const topup = args.topup === true;
    if (!!args.plan === topup) return { ok: false, code: "bad_request", error: "Ask for a plan or a top-up, not both." };
    const price = args.plan ? env.prices[args.plan] : env.topupPrice;
    if (!price) return UNAVAILABLE;

    const who = await ctx.runQuery(internal.billing.checkoutContext, { user_id: userId });
    const stripe = createStripe({ secretKey: env.secretKey! });
    try {
      if (args.plan && who.customer && who.subscription_id && isLiveSubscription(who.subscription_status)) {
        const portal = await stripe.createPortalSession({ customer: who.customer, returnUrl: returnUrl() });
        return { ok: true, url: portal.url, via: "portal" };
      }
      const session = await stripe.createCheckoutSession({
        mode: args.plan ? "subscription" : "payment",
        price,
        successUrl: returnUrl(args.plan ? "done" : "topup"),
        cancelUrl: returnUrl("canceled"),
        customer: who.customer ?? undefined,
        customerEmail: who.email ?? undefined,
        clientReferenceId: userId,
        metadata: { user_id: userId, kind: args.plan ? "plan" : "topup", ...(args.plan ? { plan: args.plan } : {}) },
      });
      return { ok: true, url: session.url, via: "checkout" };
    } catch (error) {
      return stripeRefusal(error);
    }
  },
});

/** Stripe's billing portal for the signed-in person: card, invoices, plan
 *  change and cancel. Needs a Stripe customer, which the first purchase makes. */
export const openPortal = action({
  args: {},
  handler: async (ctx): Promise<BillingRedirect> => {
    const env = billingEnv();
    if (!billingStatus(env).available) return UNAVAILABLE;
    const userId = await getAuthUserId(ctx);
    if (!userId) return SIGNED_OUT;
    const who = await ctx.runQuery(internal.billing.checkoutContext, { user_id: userId });
    if (!who.customer) return { ok: false, code: "no_customer", error: "There is nothing to manage yet: no plan or top-up has been bought." };
    try {
      const portal = await createStripe({ secretKey: env.secretKey! }).createPortalSession({ customer: who.customer, returnUrl: returnUrl() });
      return { ok: true, url: portal.url, via: "portal" };
    } catch (error) {
      return stripeRefusal(error);
    }
  },
});

// ---------------------------------------------------------------------------
// Events

/** What an event did, for the webhook's answer and the logs. */
export type BillingOutcome = `plan:${PlanId}` | "topup" | "period" | `ignored:${string}`;

/** The person an event is about: the wallet already holding the Stripe
 *  customer, else the user id our checkout wrote into metadata. The event is
 *  signed by Stripe, and only this deployment's key writes that metadata. */
async function userFor(ctx: MutationCtx, customer: string | null, metadataUserId: string | null | undefined): Promise<Id<"users"> | null> {
  if (customer) {
    const wallet = await ctx.db.query("wallets").withIndex("by_stripe_customer", (q) => q.eq("stripe_customer_id", customer)).first();
    if (wallet) return wallet.user_id;
  }
  const id = metadataUserId ? ctx.db.normalizeId("users", metadataUserId) : null;
  return id && (await ctx.db.get(id)) ? id : null;
}

/** Whether the wallet is on a live subscription other than `subscriptionId`,
 *  so an event about an older one (a late `deleted` after a resubscribe) must
 *  not move the plan. */
async function onAnotherSubscription(ctx: MutationCtx, userId: Id<"users">, subscriptionId: string | null): Promise<boolean> {
  const wallet = await walletRow(ctx, userId);
  return !!wallet?.stripe_subscription_id && wallet.stripe_subscription_id !== subscriptionId && isLiveSubscription(wallet.subscription_status);
}

async function checkoutCompleted(ctx: MutationCtx, session: StripeCheckoutSession): Promise<BillingOutcome> {
  const customer = stripeId(session.customer);
  const userId = await userFor(ctx, null, session.client_reference_id ?? session.metadata?.user_id);
  if (!userId) return "ignored:no_user";
  // Delayed methods (a bank debit) complete unpaid; the subscription's own
  // events, or a later paid session, carry the outcome.
  if (session.payment_status === "unpaid") return "ignored:unpaid";

  if (session.mode === "subscription") {
    const plan = paidPlan(session.metadata?.plan);
    if (!plan) return "ignored:no_plan";
    const subscriptionId = stripeId(session.subscription);
    if (await onAnotherSubscription(ctx, userId, subscriptionId)) return "ignored:other_subscription";
    const wallet = await walletRow(ctx, userId);
    // A subscription event for this id may have landed first with the real
    // status; it wins over the "active" a completed checkout implies.
    const known = wallet?.stripe_subscription_id === subscriptionId ? wallet?.subscription_status : undefined;
    if (known && !isLiveSubscription(known)) return "ignored:subscription_ended";
    await setPlan(ctx, userId, plan, {
      stripe_customer_id: customer ?? undefined,
      stripe_subscription_id: subscriptionId ?? undefined,
      subscription_status: known ?? "active",
    });
    return `plan:${plan}`;
  }

  if (session.mode === "payment" && session.metadata?.kind === "topup") {
    if ((session.currency ?? "usd").toLowerCase() !== "usd") return "ignored:currency";
    const cents = session.amount_subtotal ?? session.amount_total ?? 0;
    if (!(cents > 0)) return "ignored:no_amount";
    const credited = await credit(ctx, userId, "topup", cents / 100, stripeId(session.payment_intent) ?? session.id);
    // Keep the customer the purchase made, so the portal and the next
    // purchase find it. setPlan with the current plan changes nothing else.
    const wallet = await walletRow(ctx, userId);
    if (customer && wallet && !wallet.stripe_customer_id) await setPlan(ctx, userId, wallet.plan, { stripe_customer_id: customer });
    return credited ? "topup" : "ignored:repeat";
  }
  return "ignored:mode";
}

async function subscriptionChanged(ctx: MutationCtx, env: BillingEnv, subscription: StripeSubscription, deleted: boolean): Promise<BillingOutcome> {
  const customer = stripeId(subscription.customer);
  const userId = await userFor(ctx, customer, subscription.metadata?.user_id);
  if (!userId) return "ignored:no_user";
  if (await onAnotherSubscription(ctx, userId, subscription.id)) return "ignored:other_subscription";
  const wallet = await walletRow(ctx, userId);
  // `canceled` is final in Stripe: an update delivered after the delete is older news.
  if (!deleted && wallet?.stripe_subscription_id === subscription.id && wallet.subscription_status === "canceled") return "ignored:canceled";

  const status = deleted ? "canceled" : subscription.status;
  let plan: PlanId;
  if (isLiveSubscription(status)) {
    const priced = planForPrice(env, subscriptionPriceId(subscription));
    if (!priced) {
      console.error(`[billing] subscription ${subscription.id} is on price ${subscriptionPriceId(subscription)}, which no STRIPE_PRICE_* names`);
      return "ignored:unknown_price";
    }
    plan = priced;
  } else if (status === "incomplete") {
    // The first payment is still being confirmed: nothing to grant or take yet.
    plan = wallet?.plan ?? "free";
  } else {
    plan = "free";
  }
  await setPlan(ctx, userId, plan, {
    stripe_customer_id: customer ?? undefined,
    stripe_subscription_id: subscription.id,
    subscription_status: status,
  });
  return `plan:${plan}`;
}

async function invoicePaid(ctx: MutationCtx, invoice: StripeInvoice): Promise<BillingOutcome> {
  const subscriptionId = invoiceSubscriptionId(invoice);
  if (!subscriptionId) return "ignored:no_subscription";
  if (!invoiceOpensPeriod(invoice)) return "ignored:not_a_period";
  const userId = await userFor(ctx, stripeId(invoice.customer), invoiceSubscriptionMetadata(invoice).user_id);
  if (!userId) return "ignored:no_user";
  if (await onAnotherSubscription(ctx, userId, subscriptionId)) return "ignored:other_subscription";
  const period = invoicePeriod(invoice);
  if (!period) return "ignored:no_period";
  return (await alignPeriod(ctx, userId, period)) ? "period" : "ignored:period_unchanged";
}

/** Applies one verified Stripe event to the wallet. `object_json` is the
 *  event's `data.object` as JSON: Stripe objects can carry keys a Convex
 *  value cannot, so they cross as a string. */
export const applyStripeEvent = internalMutation({
  args: { id: v.string(), type: v.string(), object_json: v.string() },
  handler: async (ctx, args): Promise<BillingOutcome> => {
    const object = JSON.parse(args.object_json);
    switch (args.type) {
      case "checkout.session.completed":
        return checkoutCompleted(ctx, object as StripeCheckoutSession);
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted":
        return subscriptionChanged(ctx, billingEnv(), object as StripeSubscription, args.type === "customer.subscription.deleted");
      case "invoice.paid":
        return invoicePaid(ctx, object as StripeInvoice);
      default:
        return "ignored:type";
    }
  },
});

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** The Stripe webhook (route STRIPE_WEBHOOK_PATH in http.ts). Verifies the
 *  signature on the raw body, then maps the event in one mutation. A 2xx
 *  tells Stripe to stop retrying, so it answers 200 for events it ignores and
 *  an error only when the delivery should come again. */
export const stripeWebhook = httpAction(async (ctx, request) => {
  const env = billingEnv();
  if (!env.webhookSecret) {
    console.error("[billing] STRIPE_WEBHOOK_SECRET not configured; refusing the Stripe webhook");
    return json(503, { error: "Billing is not configured" });
  }
  const raw = await request.text();
  const verified = await verifyWebhook(raw, request.headers.get("stripe-signature"), env.webhookSecret);
  if (!verified.ok) return json(400, { error: verified.reason });
  const { event } = verified;
  if (!(BILLING_EVENT_TYPES as readonly string[]).includes(event.type)) return json(200, { received: true, outcome: "ignored:type" });
  const outcome = await ctx.runMutation(internal.billing.applyStripeEvent, {
    id: event.id,
    type: event.type,
    object_json: JSON.stringify(event.data.object),
  });
  if (outcome.startsWith("ignored:")) console.log(`[billing] ${event.type} ${event.id}: ${outcome}`);
  return json(200, { received: true, outcome });
});
