// Plans and top-ups through Stripe (plan pl-840, docs/architecture/hosted-assistant.md
// "Billing" and "Plans"). @platform/billing carries the Stripe mechanics; this
// module says which price is which plan and maps Stripe's events onto the
// wallet (lib/wallet.ts): a subscription moves the plan, a paid top-up credits
// the top-up balance, a refund or dispute takes that credit back (or, for a
// plan's own payment, ends the plan), and a paid renewal puts the wallet on
// Stripe's period.
//
// Everything is gated on env. With no keys `billingAvailable` says so, the
// actions answer `unavailable` instead of throwing, and plans are granted by
// hand (internal.wallet.setPlan). Checkout needs the webhook secret as well as
// the API key: a checkout whose events never arrive takes money and grants
// nothing. The webhook needs the key too, because it reads each subscription
// from Stripe. Selling also needs a portal configuration that bills a plan
// change at once (STRIPE_PORTAL_CONFIGURATION, checked against Stripe each
// time the portal opens): the wallet grants a new plan's allowance when the
// subscription changes, so the change must be paid for then, not at renewal,
// and a downgrade or cancel must wait for the period's end
// (`portalConfigurationProblem`). A top-up of N dollars is N of the
// STRIPE_PRICE_TOPUP price, which is checked to be a one-off $1.00 before
// each top-up checkout, so the amount the button names is what Stripe charges.
//
// Stripe does not deliver events in order. A subscription event, or a
// checkout that made one, is treated as a prompt only: the webhook reads the
// subscription as it stands now and maps that, so an older event arriving
// late cannot move the plan back. A top-up lands once per payment
// (wallet_ledger.external_id), a refund once per refunded total, and a period
// the wallet already holds changes nothing.
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import {
  BILLING_EVENT_TYPES,
  createStripe,
  invoiceOpensPeriod,
  invoicePaymentIntentId,
  invoicePeriod,
  invoiceSubscriptionId,
  invoiceSubscriptionMetadata,
  isLiveSubscription,
  isStripeRefusal,
  portalConfigurationProblem,
  sessionAmountBeforeTax,
  StripeError,
  stripeId,
  subscriptionPeriod,
  subscriptionPriceId,
  unitPriceProblem,
  verifyWebhook,
  type StripeCharge,
  type StripeCheckoutSession,
  type StripeClient,
  type StripeDispute,
  type StripeEvent,
  type StripeInvoice,
  type StripeSubscription,
} from "@platform/billing";
import { PLAN_IDS, planOf, TOPUP, topupCredit, type PlanId } from "@codecast/shared/contracts/assistant";
import { httpAction } from "./_generated/server";
import type { ActionCtx, MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { action, internalMutation, internalQuery, query } from "./functions";
import { planIdValidator } from "./assistantSchema";
import { siteUrl } from "./lib/siteUrl";
import { alignPeriod, credit, moveSubscription, refundTopup, setPlan, walletByCustomer, walletRow } from "./lib/wallet";

/** Where Stripe posts events: `<convex site>/api/webhooks/stripe`. */
export const STRIPE_WEBHOOK_PATH = "/api/webhooks/stripe";

/** The web page checkout and the portal return to, with `?billing=` set to
 *  `done`, `topup` or `canceled` after a checkout. */
export const BILLING_RETURN_PATH = "/simple/plan";

/** The plans that cost money, each sold through the price in
 *  `STRIPE_PRICE_<PLAN>` (STRIPE_PRICE_PLUS, STRIPE_PRICE_PRO). The catalog
 *  decides which plans these are; nothing else lists them. */
export const PAID_PLANS: readonly PlanId[] = PLAN_IDS.filter((id) => planOf(id).price_usd > 0);

export function priceEnvName(plan: PlanId): string {
  return `STRIPE_PRICE_${plan.toUpperCase()}`;
}

/** `raw` when it names a paid plan, else null. The one guard for a plan id
 *  from a request or from Stripe metadata. */
function paidPlan(raw: string | null | undefined): PlanId | null {
  return raw && PAID_PLANS.includes(raw as PlanId) ? (raw as PlanId) : null;
}

export interface BillingEnv {
  secretKey?: string;
  webhookSecret?: string;
  prices: Partial<Record<PlanId, string>>;
  /** The price of one dollar of top-up (a $1.00 unit amount): a top-up of
   *  N dollars is N of it. */
  topupPrice?: string;
  /** The billing portal configuration every portal session uses. */
  portalConfiguration?: string;
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
    portalConfiguration: read("STRIPE_PORTAL_CONFIGURATION"),
  };
}

/** What the plan screen may offer. `available` is false until both Stripe
 *  secrets and the portal configuration are set; `plans` lists the paid
 *  plans that have a price; `topup` says whether a top-up can be bought (in
 *  the amounts `TOPUP.amounts_usd` lists). */
export interface BillingStatus {
  available: boolean;
  plans: PlanId[];
  topup: boolean;
}

/** Whether Stripe's events can be verified and mapped: both secrets set.
 *  The webhook needs no more, so a subscription sold before a configuration
 *  went missing still lands. */
function webhookReady(env: BillingEnv): boolean {
  return !!env.secretKey && !!env.webhookSecret;
}

export function billingStatus(env: BillingEnv = billingEnv()): BillingStatus {
  const available = webhookReady(env) && !!env.portalConfiguration;
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

/** How long a repeated plan checkout reuses the first one's session: a double
 *  click or a second tab opens the same Stripe page instead of a second
 *  subscription. */
const CHECKOUT_REUSE_MS = 60_000;

/** The email and Stripe customer a checkout needs. */
export const checkoutContext = internalQuery({
  args: { user_id: v.id("users") },
  handler: async (ctx, { user_id }) => {
    const user = await ctx.db.get(user_id);
    const wallet = await walletRow(ctx, user_id);
    return { email: user?.email ?? null, customer: wallet?.stripe_customer_id ?? null };
  },
});

function returnUrl(billing?: string): string {
  return `${siteUrl()}${BILLING_RETURN_PATH}${billing ? `?billing=${billing}` : ""}`;
}

/** The person's billing portal, after checking that its configuration bills
 *  an upgrade at once, holds a downgrade or cancel to the period's end, and
 *  offers every plan (`portalConfigurationProblem`). A configuration that
 *  does not is refused rather than used: it would grant or credit allowance
 *  that nobody paid for. */
async function portalRedirect(stripe: StripeClient, env: BillingEnv, customer: string): Promise<BillingRedirect> {
  const configuration = env.portalConfiguration!;
  const prices = PAID_PLANS.flatMap((plan) => env.prices[plan] ?? []);
  const problem = portalConfigurationProblem(await stripe.getPortalConfiguration(configuration), prices);
  if (problem) {
    console.error(`[billing] portal configuration ${configuration} ${problem}; not sending anyone to it`);
    return UNAVAILABLE;
  }
  const portal = await stripe.createPortalSession({ customer, returnUrl: returnUrl(), configuration });
  return { ok: true, url: portal.url, via: "portal" };
}

/** What one unit of STRIPE_PRICE_TOPUP must cost: a dollar, in cents. */
const TOPUP_UNIT_CENTS = 100;

/** Whether the top-up price charges what the button says: a one-off $1.00
 *  USD price, sold N at a time. Logs the reason when it does not. */
async function topupPriceSound(stripe: StripeClient, price: string): Promise<boolean> {
  const problem = unitPriceProblem(await stripe.getPrice(price), TOPUP_UNIT_CENTS);
  if (problem) console.error(`[billing] STRIPE_PRICE_TOPUP ${price} ${problem}; not selling top-ups`);
  return !problem;
}

function stripeRefusal(error: unknown): BillingRedirect {
  if (!(error instanceof StripeError)) throw error;
  console.error(`[billing] Stripe refused (${error.status} ${error.code ?? error.type ?? ""}): ${error.message}`);
  return { ok: false, code: "stripe_error", error: "Stripe could not start that just now. Try again in a minute." };
}

/** Starts a purchase for the signed-in person: `{ plan }` subscribes to a
 *  paid plan, `{ topup_usd }` buys that many dollars of top-up (one of
 *  `TOPUP.amounts_usd`). Returns the Stripe page to open. Someone Stripe
 *  already holds a live subscription for gets the portal when they ask for a
 *  plan, where the change applies to the subscription they have. */
export const startCheckout = action({
  args: { plan: v.optional(planIdValidator), topup_usd: v.optional(v.number()) },
  handler: async (ctx, args): Promise<BillingRedirect> => {
    const env = billingEnv();
    if (!billingStatus(env).available) return UNAVAILABLE;
    const userId = await getAuthUserId(ctx);
    if (!userId) return SIGNED_OUT;
    const topup = args.topup_usd;
    if ((args.plan === undefined) === (topup === undefined)) return { ok: false, code: "bad_request", error: "Ask for a plan or a top-up, not both." };
    const plan = args.plan ? paidPlan(args.plan) : null;
    if (args.plan && !plan) return { ok: false, code: "bad_request", error: "That plan is not one you can buy." };
    if (topup !== undefined && !(TOPUP.amounts_usd as readonly number[]).includes(topup)) return { ok: false, code: "bad_request", error: "That top-up amount is not one on offer." };
    const price = plan ? env.prices[plan] : env.topupPrice;
    if (!price) return UNAVAILABLE;

    const who = await ctx.runQuery(internal.billing.checkoutContext, { user_id: userId });
    const stripe = createStripe({ secretKey: env.secretKey! });
    try {
      // Stripe, not the wallet, says whether a subscription is live: the
      // wallet hears of a new one only when its events arrive.
      if (plan && who.customer && (await stripe.listSubscriptions(who.customer)).some((s) => isLiveSubscription(s.status))) {
        return await portalRedirect(stripe, env, who.customer);
      }
      if (!plan && !(await topupPriceSound(stripe, price))) return UNAVAILABLE;
      const session = await stripe.createCheckoutSession(
        {
          mode: plan ? "subscription" : "payment",
          price,
          quantity: plan ? 1 : topup,
          successUrl: returnUrl(plan ? "done" : "topup"),
          cancelUrl: returnUrl("canceled"),
          customer: who.customer ?? undefined,
          customerEmail: who.email ?? undefined,
          clientReferenceId: userId,
          metadata: { user_id: userId, kind: plan ? "plan" : "topup", ...(plan ? { plan } : {}) },
        },
        plan ? { idempotencyKey: `checkout:${userId}:${plan}:${Math.floor(Date.now() / CHECKOUT_REUSE_MS)}` } : {},
      );
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
      return await portalRedirect(createStripe({ secretKey: env.secretKey! }), env, who.customer);
    } catch (error) {
      return stripeRefusal(error);
    }
  },
});

// ---------------------------------------------------------------------------
// Events

/** What an event did, for the webhook's answer and the logs.
 *  `duplicate:<kept id>` is the mutation's report of a second live
 *  subscription for someone already on `<kept id>`; the webhook resolves it
 *  and answers `duplicate_canceled`. */
export type BillingOutcome =
  | `plan:${PlanId}`
  | "topup"
  | "refund"
  | "period"
  | `duplicate:${string}`
  | "duplicate_canceled"
  | "plan_canceled"
  | `ignored:${string}`;

/** The person an event is about: the wallet already holding the Stripe
 *  customer, else the user id our checkout wrote into metadata. The event is
 *  signed by Stripe, and only this deployment's key writes that metadata. */
async function userFor(ctx: MutationCtx, customer: string | null, metadataUserId: string | null | undefined): Promise<Id<"users"> | null> {
  if (customer) {
    const wallet = await walletByCustomer(ctx, customer);
    if (wallet) return wallet.user_id;
  }
  const id = metadataUserId ? ctx.db.normalizeId("users", metadataUserId) : null;
  return id && (await ctx.db.get(id)) ? id : null;
}

/** The live subscription the wallet is on when it is not `subscriptionId`. */
function otherLiveSubscription(wallet: Doc<"wallets"> | null, subscriptionId: string | null): string | null {
  const held = wallet?.stripe_subscription_id;
  return held && held !== subscriptionId && isLiveSubscription(wallet.subscription_status) ? held : null;
}

/** Maps a subscription as it stands now onto the wallet. `userId` is known
 *  when a checkout names the buyer before the wallet holds their customer.
 *  `refunded` marks a subscription canceled because its payment was refunded
 *  or disputed (`endRefundedPlan`). */
async function subscriptionChanged(ctx: MutationCtx, env: BillingEnv, subscription: StripeSubscription, userId?: Id<"users"> | null, refunded = false): Promise<BillingOutcome> {
  const customer = stripeId(subscription.customer);
  const owner = userId ?? (await userFor(ctx, customer, subscription.metadata?.user_id));
  if (!owner) return "ignored:no_user";
  const wallet = await walletRow(ctx, owner);
  const other = otherLiveSubscription(wallet, subscription.id);
  if (other) {
    // A late event about an older subscription changes nothing; a second live
    // one is still being paid for, so the webhook acts on it.
    return isLiveSubscription(subscription.status) ? `duplicate:${other}` : "ignored:other_subscription";
  }

  const status = subscription.status;
  let plan: PlanId;
  if (isLiveSubscription(status)) {
    const priced = planForPrice(env, subscriptionPriceId(subscription));
    if (!priced) {
      console.error(`[billing] subscription ${subscription.id} is on price ${subscriptionPriceId(subscription)}, which no STRIPE_PRICE_* names`);
      return "ignored:unknown_price";
    }
    plan = priced;
  } else if (status === "incomplete" || status === "incomplete_expired") {
    // The first payment is still being confirmed, or never was: this
    // subscription granted nothing, so it takes nothing either (a plan
    // granted by hand stays).
    plan = wallet?.plan ?? "free";
  } else {
    plan = "free";
  }
  // A change to a subscription that was paid up counts for the rest of the
  // period; a new one, or a failing renewal finally paid, bought the period
  // whole. One whose payment went back (`refunded`) keeps nothing of it, even
  // when Stripe's own delete for the cancel landed first and prorated it, so
  // it takes the plan's whole allowance through `setPlan`.
  const prorate = wallet?.stripe_subscription_id === subscription.id && isLiveSubscription(wallet.subscription_status) && wallet.subscription_status !== "past_due";
  const facts = { stripe_customer_id: customer ?? undefined, stripe_subscription_id: subscription.id, subscription_status: status };
  if (refunded) await setPlan(ctx, owner, plan, facts);
  else await moveSubscription(ctx, owner, plan, facts, { prorate });
  return `plan:${plan}`;
}

async function checkoutCompleted(ctx: MutationCtx, env: BillingEnv, session: StripeCheckoutSession, subscription: StripeSubscription | null): Promise<BillingOutcome> {
  const customer = stripeId(session.customer);
  const userId = await userFor(ctx, null, session.client_reference_id ?? session.metadata?.user_id);
  if (!userId) return "ignored:no_user";

  if (session.mode === "subscription") {
    // The subscription's own state decides, read from Stripe by the webhook.
    if (!subscription) return "ignored:no_subscription";
    return subscriptionChanged(ctx, env, subscription, userId);
  }

  if (session.mode === "payment" && session.metadata?.kind === "topup") {
    // A delayed method (a bank debit) completes unpaid and is paid by
    // checkout.session.async_payment_succeeded, which lands here paid.
    if (session.payment_status !== "paid") return "ignored:unpaid";
    if ((session.currency ?? "usd").toLowerCase() !== "usd") return "ignored:currency";
    const cents = sessionAmountBeforeTax(session);
    if (!(cents > 0)) return "ignored:no_amount";
    const credited = await credit(ctx, userId, "topup", topupCredit(cents / 100), stripeId(session.payment_intent) ?? session.id);
    // Keep the customer the purchase made, so the portal and the next
    // purchase find it. The plan and its allowance stay as they are.
    const wallet = await walletRow(ctx, userId);
    if (customer && wallet && !wallet.stripe_customer_id) await moveSubscription(ctx, userId, wallet.plan, { stripe_customer_id: customer }, { prorate: false });
    return credited ? "topup" : "ignored:repeat";
  }
  return "ignored:mode";
}

/** A refund of a top-up's charge takes back the same share of its credit.
 *  `amount_refunded` is the charge's running total, so each total lands once. */
async function chargeRefunded(ctx: MutationCtx, charge: StripeCharge): Promise<BillingOutcome> {
  const paymentIntent = stripeId(charge.payment_intent);
  if (!paymentIntent || !(charge.amount > 0)) return "ignored:no_payment";
  const taken = await refundTopup(ctx, paymentIntent, charge.amount_refunded / charge.amount, `${paymentIntent}:refunded:${charge.amount_refunded}`);
  return taken === null ? "ignored:not_a_topup" : taken > 0 ? "refund" : "ignored:repeat";
}

/** A dispute holds the money until it is decided, so the credit goes now. A
 *  dispute won later does not give it back on its own. */
async function disputeCreated(ctx: MutationCtx, dispute: StripeDispute): Promise<BillingOutcome> {
  const paymentIntent = stripeId(dispute.payment_intent);
  if (!paymentIntent) return "ignored:no_payment";
  const taken = await refundTopup(ctx, paymentIntent, 1, `${paymentIntent}:dispute:${dispute.id}`);
  return taken === null ? "ignored:not_a_topup" : taken > 0 ? "refund" : "ignored:repeat";
}

async function invoicePaid(ctx: MutationCtx, invoice: StripeInvoice): Promise<BillingOutcome> {
  const subscriptionId = invoiceSubscriptionId(invoice);
  if (!subscriptionId) return "ignored:no_subscription";
  if (!invoiceOpensPeriod(invoice)) return "ignored:not_a_period";
  const userId = await userFor(ctx, stripeId(invoice.customer), invoiceSubscriptionMetadata(invoice).user_id);
  if (!userId) return "ignored:no_user";
  if (otherLiveSubscription(await walletRow(ctx, userId), subscriptionId)) return "ignored:other_subscription";
  const period = invoicePeriod(invoice);
  if (!period) return "ignored:no_period";
  return (await alignPeriod(ctx, userId, period)) ? "period" : "ignored:period_unchanged";
}

/** Applies one verified Stripe event to the wallet. `object_json` is the
 *  event's `data.object` and `subscription_json` the subscription it concerns
 *  as Stripe holds it now, both as JSON: Stripe objects can carry keys a
 *  Convex value cannot, so they cross as strings. A subscription event maps
 *  `subscription_json` when it is given, its own copy otherwise. `refunded`
 *  ends that subscription's allowance whole rather than by time. */
export const applyStripeEvent = internalMutation({
  args: { id: v.string(), type: v.string(), object_json: v.string(), subscription_json: v.optional(v.string()), refunded: v.optional(v.boolean()) },
  handler: async (ctx, args): Promise<BillingOutcome> => {
    const object = JSON.parse(args.object_json);
    const subscription: StripeSubscription | null = args.subscription_json ? JSON.parse(args.subscription_json) : null;
    const env = billingEnv();
    switch (args.type) {
      case "checkout.session.completed":
      case "checkout.session.async_payment_succeeded":
        return checkoutCompleted(ctx, env, object as StripeCheckoutSession, subscription);
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted":
        return subscriptionChanged(ctx, env, subscription ?? (object as StripeSubscription), null, args.refunded);
      case "invoice.paid":
        return invoicePaid(ctx, object as StripeInvoice);
      case "charge.refunded":
        return chargeRefunded(ctx, object as StripeCharge);
      case "charge.dispute.created":
        return disputeCreated(ctx, object as StripeDispute);
      default:
        return "ignored:type";
    }
  },
});

/** The subscription an event concerns, to be read fresh from Stripe. */
function eventSubscriptionId(event: StripeEvent): string | null {
  const object = event.data.object;
  if (event.type.startsWith("customer.subscription.")) return typeof object.id === "string" ? object.id : null;
  if (event.type.startsWith("checkout.session.") && object.mode === "subscription") return stripeId(object.subscription);
  return null;
}

/** Refunds the payment that started a second live subscription the wallet
 *  does not use, then ends it. Refund first: while the duplicate is live a
 *  redelivery resolves to it again, so a refund that failed on the way (the
 *  network, Stripe down) is retried, and the keyed refund replays rather than
 *  paying out twice. Only a refund Stripe refuses outright (a 4xx, which will
 *  not change on a retry) is left to a person, and the cancel goes ahead. */
async function cancelDuplicate(stripe: StripeClient, duplicate: StripeSubscription, keptId: string): Promise<BillingOutcome> {
  const what = `second live subscription ${duplicate.id} for a customer already on ${keptId}`;
  const invoice = stripeId(duplicate.latest_invoice);
  let refund: string | null = null;
  try {
    refund = invoice ? await stripe.refundInvoice(invoice, { idempotencyKey: `refund-duplicate:${duplicate.id}` }) : null;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (!isStripeRefusal(error)) {
      console.error(`[billing] ${what}: refunding invoice ${invoice} failed (${reason}); left live for the redelivery. If Stripe stops retrying, refund ${invoice} and cancel ${duplicate.id} by hand`);
      throw error;
    }
    console.error(`[billing] ${what}: Stripe refused to refund invoice ${invoice} (${reason}); refund it by hand`);
  }
  await stripe.cancelSubscription(duplicate.id, { idempotencyKey: `cancel-duplicate:${duplicate.id}` });
  console.error(`[billing] ${what}: canceled${refund ? `, refunded ${refund}` : invoice ? "" : ", no invoice to refund"}`);
  return "duplicate_canceled";
}

/** The subscription the wallet holding `customer` is on, if any. */
export const walletSubscription = internalQuery({
  args: { customer: v.string() },
  handler: async (ctx, { customer }) => (await walletByCustomer(ctx, customer))?.stripe_subscription_id ?? null,
});

/** A plan's own payment refunded in full or disputed: the money went back,
 *  so the plan and its allowance end too. Stripe keeps a subscription live
 *  through both, so this cancels it and maps the canceled subscription onto
 *  the wallet with nothing of the period kept. A dispute ends the plan
 *  whichever of its invoices it names. A refund ends it only when it returns
 *  the payment that opened the current period; a refund of an older period,
 *  of a mid-period proration, or a partial one is a goodwill gesture and
 *  leaves the plan. Only the wallet's own subscription is touched: the refund
 *  of a duplicate (cancelDuplicate) names another one. Runs when the mutation
 *  found no top-up behind the payment, since every other payment a customer
 *  makes here is a plan's.
 *
 *  The mapping does not depend on order: Stripe's own delete for the cancel
 *  may land first and prorate, and the refunded mapping then sets the cap to
 *  the free allowance whole (`setPlan`).
 *  A redelivery after the cancel went through (the mapping failed, or the
 *  action died) finds the subscription ended mid-period and maps it again. */
async function endRefundedPlan(ctx: ActionCtx, stripe: StripeClient, event: StripeEvent): Promise<BillingOutcome> {
  const disputed = event.type === "charge.dispute.created";
  const object = event.data.object as StripeCharge | StripeDispute;
  if (!disputed) {
    const charge = object as StripeCharge;
    if (!charge.refunded && charge.amount_refunded < charge.amount) return "ignored:partial_refund";
  }
  const paymentIntent = stripeId(object.payment_intent);
  const invoiceId = (!disputed ? stripeId((object as StripeCharge).invoice) : null)
    ?? (paymentIntent ? await stripe.invoiceForPayment(paymentIntent) : null);
  if (!invoiceId) return "ignored:not_a_plan";
  const invoice = await stripe.getInvoice(invoiceId);
  // Only the invoice this payment paid: a lookup that named another would end
  // whichever plan that invoice bills.
  if (paymentIntent && invoicePaymentIntentId(invoice) !== paymentIntent) return "ignored:not_a_plan";
  const subscriptionId = invoiceSubscriptionId(invoice);
  const customer = stripeId(invoice.customer);
  if (!subscriptionId || !customer) return "ignored:not_a_plan";
  if ((await ctx.runQuery(internal.billing.walletSubscription, { customer })) !== subscriptionId) return "ignored:other_subscription";
  const subscription = await stripe.getSubscription(subscriptionId);
  const period = subscriptionPeriod(subscription);
  if (!disputed) {
    if (!invoiceOpensPeriod(invoice)) return "ignored:not_a_period";
    if (!period || invoicePeriod(invoice)?.end !== period.end) return "ignored:past_period";
  }
  let ended = subscription;
  if (isLiveSubscription(subscription.status)) {
    ended = await stripe.cancelSubscription(subscriptionId, { idempotencyKey: `cancel-${disputed ? "disputed" : "refunded"}:${subscriptionId}` });
  } else if (!period || period.end <= Date.now()) {
    // It ran to the end of its last period: no allowance of it is left to take.
    return "ignored:already_ended";
  }
  await ctx.runMutation(internal.billing.applyStripeEvent, { id: event.id, type: "customer.subscription.updated", object_json: JSON.stringify(ended), refunded: true });
  console.error(`[billing] ${event.type} ${event.id}: invoice ${invoiceId} of ${subscriptionId} was ${disputed ? "disputed" : "refunded in full"}; ${ended === subscription ? "already canceled, allowance ended" : `canceled ${subscriptionId}`}`);
  return "plan_canceled";
}

/** Maps one event, reading the subscription it concerns from Stripe first.
 *  A second live subscription is resolved here, outside the mutation, since
 *  only an action can call Stripe: when the wallet's own subscription is
 *  still live the new one is canceled and refunded; when the wallet's record
 *  of it is out of date, that record is brought up to date and the event
 *  applied again. */
async function applyEvent(ctx: ActionCtx, stripe: StripeClient, event: StripeEvent): Promise<BillingOutcome> {
  const subscriptionId = eventSubscriptionId(event);
  const subscription = subscriptionId ? await stripe.getSubscription(subscriptionId) : null;
  const apply = () =>
    ctx.runMutation(internal.billing.applyStripeEvent, {
      id: event.id,
      type: event.type,
      object_json: JSON.stringify(event.data.object),
      subscription_json: subscription ? JSON.stringify(subscription) : undefined,
    });
  let outcome = await apply();
  if (outcome === "ignored:not_a_topup") return endRefundedPlan(ctx, stripe, event);
  if (!outcome.startsWith("duplicate:") || !subscription) return outcome;

  const keptId = outcome.slice("duplicate:".length);
  const kept = await stripe.getSubscription(keptId);
  if (!isLiveSubscription(kept.status)) {
    await ctx.runMutation(internal.billing.applyStripeEvent, {
      id: event.id,
      type: "customer.subscription.updated",
      object_json: JSON.stringify(kept),
    });
    outcome = await apply();
    if (!outcome.startsWith("duplicate:")) return outcome;
  }
  return cancelDuplicate(stripe, subscription, keptId);
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** The Stripe webhook (route STRIPE_WEBHOOK_PATH in http.ts). Verifies the
 *  signature on the raw body, then maps the event. A 2xx tells Stripe to stop
 *  retrying, so it answers 200 for events it ignores and an error only when
 *  the delivery should come again (Stripe itself could not be read). */
export const stripeWebhook = httpAction(async (ctx, request) => {
  const env = billingEnv();
  if (!webhookReady(env)) {
    console.error("[billing] STRIPE_SECRET_KEY or STRIPE_WEBHOOK_SECRET not configured; refusing the Stripe webhook");
    return json(503, { error: "Billing is not configured" });
  }
  const raw = await request.text();
  const verified = await verifyWebhook(raw, request.headers.get("stripe-signature"), env.webhookSecret);
  if (!verified.ok) return json(400, { error: verified.reason });
  const { event } = verified;
  if (!(BILLING_EVENT_TYPES as readonly string[]).includes(event.type)) return json(200, { received: true, outcome: "ignored:type" });
  try {
    const outcome = await applyEvent(ctx, createStripe({ secretKey: env.secretKey! }), event);
    if (outcome.startsWith("ignored:")) console.log(`[billing] ${event.type} ${event.id}: ${outcome}`);
    return json(200, { received: true, outcome });
  } catch (error) {
    // Anything but a Stripe answer (a network failure) throws on, which Stripe
    // also treats as "deliver again".
    if (!(error instanceof StripeError)) throw error;
    console.error(`[billing] ${event.type} ${event.id}: Stripe refused a call (${error.status}): ${error.message}`);
    // An object Stripe does not have under this key will not appear on a
    // retry; anything else might.
    if (error.status === 404) return json(200, { received: true, outcome: "ignored:missing" });
    return json(502, { error: "Stripe could not be reached; deliver again" });
  }
});
