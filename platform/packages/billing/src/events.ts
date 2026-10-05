// The Stripe objects a subscription product reads from its webhook, typed
// loosely (only the fields a mapping needs, every one optional where Stripe
// may leave it out), and accessors that read a field from wherever the API
// version in use puts it. Since 2025-03-31 ("basil") the period moved from
// the subscription onto its items and an invoice's subscription moved under
// `parent.subscription_details`; the accessors read both shapes, so an
// account's pinned version does not decide whether billing works.

/** An id Stripe sends either bare or expanded into its object. */
export type Expandable<T extends { id: string }> = string | T | null | undefined;

export interface StripeEvent<T = Record<string, any>> {
  id: string;
  type: string;
  /** Unix seconds. */
  created: number;
  livemode?: boolean;
  data: { object: T; previous_attributes?: Partial<T> };
}

/** The event types a plan and top-up product maps. A checkout paid by a
 *  delayed method (a bank debit) completes unpaid and is paid later by
 *  `checkout.session.async_payment_succeeded`. Refunds and disputes take a
 *  purchase back. */
export const BILLING_EVENT_TYPES = [
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "charge.refunded",
  "charge.dispute.created",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.paid",
] as const;
export type BillingEventType = (typeof BILLING_EVENT_TYPES)[number];

export interface StripeCheckoutSession {
  id: string;
  object?: "checkout.session";
  mode: "subscription" | "payment" | "setup";
  status?: "open" | "complete" | "expired" | null;
  payment_status?: "paid" | "unpaid" | "no_payment_required";
  client_reference_id?: string | null;
  customer?: Expandable<{ id: string }>;
  customer_email?: string | null;
  customer_details?: { email?: string | null } | null;
  subscription?: Expandable<{ id: string }>;
  payment_intent?: Expandable<{ id: string }>;
  /** Minor units (cents), tax and discounts included. */
  amount_total?: number | null;
  /** Minor units, before tax and discounts. */
  amount_subtotal?: number | null;
  /** Minor units: what of `amount_total` was tax and what discounts took off. */
  total_details?: { amount_tax?: number | null; amount_discount?: number | null } | null;
  currency?: string | null;
  metadata?: Record<string, string> | null;
}

export interface StripePrice {
  id: string;
  active?: boolean;
  unit_amount?: number | null;
  currency?: string;
  recurring?: { interval: "day" | "week" | "month" | "year"; interval_count: number } | null;
}

/** Why `price` is not the one-off price an app sells by the unit, or null
 *  when it is: active, in `currency`, not recurring, and exactly
 *  `unitAmount` minor units each. An app that sells N units as quantity N
 *  of one price (a top-up of N dollars) must check this before checkout,
 *  because the buyer was shown N units' price and Stripe charges whatever
 *  the price says. */
export function unitPriceProblem(price: StripePrice, unitAmount: number, currency = "usd"): string | null {
  if (price.active === false) return "is not active";
  if (price.recurring) return "is recurring, not one-off";
  if ((price.currency ?? "").toLowerCase() !== currency.toLowerCase()) return `is in ${price.currency ?? "(none)"}, not ${currency}`;
  if (price.unit_amount !== unitAmount) return `costs ${price.unit_amount ?? "(none)"} a unit, not ${unitAmount}`;
  return null;
}

export interface StripeSubscriptionItem {
  id: string;
  price?: StripePrice;
  quantity?: number;
  /** Unix seconds; here since 2025-03-31. */
  current_period_start?: number;
  current_period_end?: number;
}

export type SubscriptionStatus =
  | "incomplete"
  | "incomplete_expired"
  | "trialing"
  | "active"
  | "past_due"
  | "canceled"
  | "unpaid"
  | "paused";

/** Statuses that keep the paid plan. `past_due` stays while Stripe retries the
 *  card; Stripe then moves the subscription to `canceled` or `unpaid`, which
 *  ends it. */
export const LIVE_SUBSCRIPTION_STATUSES: readonly SubscriptionStatus[] = ["trialing", "active", "past_due"];

export interface StripeSubscription {
  id: string;
  object?: "subscription";
  customer?: Expandable<{ id: string }>;
  status: SubscriptionStatus | string;
  metadata?: Record<string, string> | null;
  items?: { data: StripeSubscriptionItem[] };
  cancel_at_period_end?: boolean;
  /** The newest invoice: for a new subscription, the one its first payment paid. */
  latest_invoice?: Expandable<{ id: string }>;
  /** Unix seconds; on the subscription before 2025-03-31. */
  current_period_start?: number;
  current_period_end?: number;
}

export interface StripeInvoiceLine {
  id?: string;
  amount?: number;
  /** Unix seconds: the service period this line pays for. */
  period?: { start: number; end: number };
  price?: StripePrice | null;
  pricing?: { price_details?: { price?: string | null } | null } | null;
}

export interface StripeInvoice {
  id: string;
  object?: "invoice";
  customer?: Expandable<{ id: string }>;
  status?: string | null;
  /** Why the invoice exists: `subscription_create`, `subscription_cycle`,
   *  `subscription_update` (a proration), `manual`, ... */
  billing_reason?: string | null;
  amount_paid?: number;
  currency?: string;
  /** Before 2025-03-31. */
  subscription?: Expandable<{ id: string }>;
  subscription_details?: { metadata?: Record<string, string> | null } | null;
  /** Since 2025-03-31. */
  parent?: {
    subscription_details?: { subscription?: Expandable<{ id: string }>; metadata?: Record<string, string> | null } | null;
  } | null;
  lines?: { data: StripeInvoiceLine[] };
  /** Before 2025-03-31: the payment that paid it. */
  payment_intent?: Expandable<{ id: string }>;
  /** Since 2025-03-31, and only when expanded (`expand[]=payments`). */
  payments?: { data: { status?: string; payment?: { type?: string; payment_intent?: Expandable<{ id: string }> } | null }[] } | null;
}

export interface StripeCharge {
  id: string;
  object?: "charge";
  customer?: Expandable<{ id: string }>;
  payment_intent?: Expandable<{ id: string }>;
  /** Before 2025-03-31: the invoice this charge paid. Later versions name it
   *  only through the payment (`invoiceForPayment`). */
  invoice?: Expandable<{ id: string }> | null;
  /** Minor units charged. */
  amount: number;
  /** Minor units refunded so far, every refund of this charge together. */
  amount_refunded: number;
  refunded?: boolean;
  currency?: string;
}

export interface StripeDispute {
  id: string;
  object?: "dispute";
  charge?: Expandable<{ id: string }>;
  payment_intent?: Expandable<{ id: string }>;
  /** Minor units disputed. */
  amount: number;
  currency?: string;
  status?: string;
}

/** A billing portal configuration (billing_portal/configurations): what a
 *  customer may change in the portal and how Stripe bills the change. */
export interface StripePortalConfiguration {
  id: string;
  object?: "billing_portal.configuration";
  active?: boolean;
  features?: {
    subscription_cancel?: {
      enabled?: boolean;
      mode?: "at_period_end" | "immediately";
      proration_behavior?: "none" | "create_prorations" | "always_invoice";
    };
    subscription_update?: {
      enabled?: boolean;
      proration_behavior?: "none" | "create_prorations" | "always_invoice";
      /** `now` restarts the billing cycle on every change. */
      billing_cycle_anchor?: "now" | "unchanged" | null;
      /** Changes that wait for the period's end instead of applying now. */
      schedule_at_period_end?: { conditions?: { type: "decreasing_item_amount" | "shortening_interval" }[] } | null;
      /** Sent only when the configuration is read with
       *  `expand[]=features.subscription_update.products`. */
      products?: { product: string; prices?: string[] }[] | null;
    };
  };
}

/** Why a portal configuration cannot carry an app's plan changes, or null
 *  when it can. It is written for an app that grants a plan's whole
 *  allowance when a period opens and spends it as the customer goes, so
 *  money must never come back for time whose allowance was already used:
 *  - An upgrade is paid at once (`always_invoice`). With Stripe's default
 *    the prorated charge waits for the renewal, and a customer who upgrades,
 *    uses the larger plan and cancels before then never pays for it.
 *  - A downgrade waits for the period's end (`schedule_at_period_end` with
 *    `decreasing_item_amount`). Applied at once it credits the unused time of
 *    the dearer plan while the allowance it bought may already be spent.
 *  - A cancel waits for the period's end. An immediate cancel with
 *    prorations credits the unused time to the customer's balance, and a new
 *    subscription paid from that balance opens a fresh full allowance for a
 *    sliver of the price; one without prorations ends a paid period early.
 *  - The billing cycle stays put on a change (`billing_cycle_anchor` not
 *    `now`), so the app's periods keep matching Stripe's.
 *  Every price in `prices` must also be on offer, or a plan cannot be
 *  reached; read the configuration with its products expanded
 *  (`StripeClient.getPortalConfiguration` does). */
export function portalConfigurationProblem(config: StripePortalConfiguration, prices: readonly string[]): string | null {
  if (config.active === false) return "is not active";
  const cancel = config.features?.subscription_cancel;
  if (cancel?.enabled && cancel.mode !== "at_period_end") return `cancels with mode=${cancel.mode ?? "(default)"}, not at_period_end`;
  const update = config.features?.subscription_update;
  if (!update?.enabled) return prices.length ? "does not allow plan changes" : null;
  if (update.proration_behavior !== "always_invoice") return `bills plan changes with proration_behavior=${update.proration_behavior ?? "(default)"}, not always_invoice`;
  if (update.billing_cycle_anchor === "now") return "restarts the billing cycle on a plan change (billing_cycle_anchor=now)";
  if (!update.schedule_at_period_end?.conditions?.some((condition) => condition.type === "decreasing_item_amount")) {
    return "applies a downgrade at once instead of at the period's end (schedule_at_period_end decreasing_item_amount)";
  }
  const offered = new Set((update.products ?? []).flatMap((product) => product.prices ?? []));
  const missing = prices.filter((price) => !offered.has(price));
  return missing.length ? `does not offer ${missing.join(", ")}` : null;
}

/** What a paid checkout session took before tax, in minor units: the total
 *  after discounts, less tax. Tax is passed on, so it buys nothing. */
export function sessionAmountBeforeTax(session: StripeCheckoutSession): number {
  const total = session.amount_total ?? session.amount_subtotal ?? 0;
  return Math.max(0, total - (session.total_details?.amount_tax ?? 0));
}

/** The id of a field Stripe sends bare or expanded. */
export function stripeId(value: Expandable<{ id: string }>): string | null {
  if (!value) return null;
  return typeof value === "string" ? value : value.id ?? null;
}

export function isLiveSubscription(status: string | null | undefined): boolean {
  return !!status && (LIVE_SUBSCRIPTION_STATUSES as readonly string[]).includes(status);
}

/** The price of a subscription's first item: one plan, one item. */
export function subscriptionPriceId(subscription: StripeSubscription): string | null {
  return subscription.items?.data?.[0]?.price?.id ?? null;
}

/** A period in milliseconds, the unit the rest of an app counts in. */
export interface PeriodMs {
  start: number;
  end: number;
}

function periodMs(start: number | undefined, end: number | undefined): PeriodMs | null {
  return typeof start === "number" && typeof end === "number" && end > start ? { start: start * 1000, end: end * 1000 } : null;
}

/** The subscription's current period, from its first item or (older API
 *  versions) the subscription itself. */
export function subscriptionPeriod(subscription: StripeSubscription): PeriodMs | null {
  const item = subscription.items?.data?.[0];
  return periodMs(item?.current_period_start, item?.current_period_end)
    ?? periodMs(subscription.current_period_start, subscription.current_period_end);
}

/** The subscription an invoice bills, or null for a one-off invoice. */
export function invoiceSubscriptionId(invoice: StripeInvoice): string | null {
  return stripeId(invoice.parent?.subscription_details?.subscription) ?? stripeId(invoice.subscription);
}

/** The metadata of the subscription an invoice bills, as Stripe copies it
 *  onto the invoice. */
export function invoiceSubscriptionMetadata(invoice: StripeInvoice): Record<string, string> {
  return invoice.parent?.subscription_details?.metadata ?? invoice.subscription_details?.metadata ?? {};
}

/** The service period a subscription invoice pays for: the line reaching
 *  furthest, and of those the one starting earliest. An invoice's own
 *  `period_start`/`period_end` name the period before it, so they are not
 *  read. Proration lines start mid-period, so read this only for invoices
 *  whose billing_reason is `subscription_create` or `subscription_cycle`. */
export function invoicePeriod(invoice: StripeInvoice): PeriodMs | null {
  let best: PeriodMs | null = null;
  for (const line of invoice.lines?.data ?? []) {
    const period = periodMs(line.period?.start, line.period?.end);
    if (!period) continue;
    if (!best || period.end > best.end || (period.end === best.end && period.start < best.start)) best = period;
  }
  return best;
}

/** The payment that paid an invoice, under either API shape. Since
 *  2025-03-31 it is read from `payments`, which Stripe sends only when the
 *  invoice is fetched with `expand[]=payments`. */
export function invoicePaymentIntentId(invoice: StripeInvoice): string | null {
  const paid = invoice.payments?.data?.find((entry) => entry.status === "paid" && entry.payment?.type === "payment_intent")
    ?? invoice.payments?.data?.find((entry) => entry.payment?.type === "payment_intent");
  return stripeId(paid?.payment?.payment_intent) ?? stripeId(invoice.payment_intent);
}

/** The invoice reasons that open a new service period. */
export const PERIOD_OPENING_REASONS = ["subscription_create", "subscription_cycle"] as const;

export function invoiceOpensPeriod(invoice: StripeInvoice): boolean {
  return !!invoice.billing_reason && (PERIOD_OPENING_REASONS as readonly string[]).includes(invoice.billing_reason);
}
