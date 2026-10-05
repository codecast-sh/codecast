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

/** The event types a plan and top-up product maps. */
export const BILLING_EVENT_TYPES = [
  "checkout.session.completed",
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
  currency?: string | null;
  metadata?: Record<string, string> | null;
}

export interface StripePrice {
  id: string;
  unit_amount?: number | null;
  currency?: string;
  recurring?: { interval: "day" | "week" | "month" | "year"; interval_count: number } | null;
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

/** The invoice reasons that open a new service period. */
export const PERIOD_OPENING_REASONS = ["subscription_create", "subscription_cycle"] as const;

export function invoiceOpensPeriod(invoice: StripeInvoice): boolean {
  return !!invoice.billing_reason && (PERIOD_OPENING_REASONS as readonly string[]).includes(invoice.billing_reason);
}
