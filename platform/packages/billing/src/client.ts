// A Stripe client over fetch: no SDK, no Node built-ins, so it runs the same in
// Convex, a Worker, bun and the browser's test runner. It knows the mechanics
// only (auth, form encoding, errors, the two sessions a product needs); which
// price is which plan stays with the caller.
import { invoicePaymentIntentId, type StripeInvoice, type StripePortalConfiguration, type StripePrice, type StripeSubscription } from "./events";
import { encodeForm, type FormParams } from "./form";

/** The slice of fetch the client uses, so a test can hand in a fake. */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export interface StripeOptions {
  /** The secret key (sk_live_... or sk_test_...). Never shipped to a client. */
  secretKey: string;
  /** Defaults to the global fetch, read at call time. */
  fetch?: FetchLike;
  /** Defaults to https://api.stripe.com. */
  apiBase?: string;
  /** Pins `Stripe-Version`; the account's default when absent. */
  apiVersion?: string;
}

/** A refusal from Stripe, with its error object's fields when it sent one. */
export class StripeError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly type?: string,
    readonly code?: string,
    readonly param?: string,
  ) {
    super(message);
    this.name = "StripeError";
  }
}

export interface RequestOptions {
  /** Stripe replays the first response for a repeated key instead of acting twice. */
  idempotencyKey?: string;
}

export interface CheckoutInput {
  /** `subscription` for a plan, `payment` for a one-off purchase such as a top-up. */
  mode: "subscription" | "payment";
  price: string;
  quantity?: number;
  successUrl: string;
  cancelUrl: string;
  /** An existing customer. Without one Stripe makes a customer from what the
   *  buyer types, prefilled with `customerEmail`. */
  customer?: string;
  customerEmail?: string;
  /** The app's own id for the buyer; comes back on checkout.session.completed. */
  clientReferenceId?: string;
  /** Set on the session and copied onto the subscription (subscription mode)
   *  or the payment intent (payment mode), so later events carry it too. */
  metadata?: Record<string, string>;
  allowPromotionCodes?: boolean;
}

export interface PortalInput {
  customer: string;
  returnUrl: string;
  /** A portal configuration id; the account's default when absent. */
  configuration?: string;
}

/** A hosted page to send the person to. */
export interface StripeRedirect {
  id: string;
  url: string;
}

export interface StripeClient {
  request<T = unknown>(method: "GET" | "POST" | "DELETE", path: string, params?: FormParams, options?: RequestOptions): Promise<T>;
  createCheckoutSession(input: CheckoutInput, options?: RequestOptions): Promise<StripeRedirect>;
  createPortalSession(input: PortalInput, options?: RequestOptions): Promise<StripeRedirect>;
  /** A portal configuration with its products expanded, to check with
   *  `portalConfigurationProblem` before sending anyone to a portal that
   *  uses it. */
  getPortalConfiguration(id: string): Promise<StripePortalConfiguration>;
  /** A price, to check with `unitPriceProblem` before selling by quantity. */
  getPrice(id: string): Promise<StripePrice>;
  /** The subscription as it stands now. Stripe does not deliver events in
   *  order, so a handler that maps this rather than the event's copy cannot
   *  be moved back by an older event. Canceled subscriptions stay readable. */
  getSubscription(id: string): Promise<StripeSubscription>;
  /** A customer's subscriptions in every status, newest first (up to 100). */
  listSubscriptions(customer: string): Promise<StripeSubscription[]>;
  /** Ends a subscription now, without a proration credit. */
  cancelSubscription(id: string, options?: RequestOptions): Promise<StripeSubscription>;
  /** Refunds the whole payment of an invoice and returns the refund's id, or
   *  null when the invoice was not paid by a payment Stripe can refund. */
  refundInvoice(invoiceId: string, options?: RequestOptions): Promise<string | null>;
}

/** The form params a checkout session is created with. Exported for tests and
 *  for callers that need a field this shape does not cover. */
export function checkoutParams(input: CheckoutInput): FormParams {
  const metadata = input.metadata && Object.keys(input.metadata).length ? input.metadata : undefined;
  const payment = input.mode === "payment";
  return {
    mode: input.mode,
    line_items: [{ price: input.price, quantity: input.quantity ?? 1 }],
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
    customer: input.customer,
    // Stripe refuses customer_email next to customer.
    customer_email: input.customer ? undefined : input.customerEmail,
    // Payment mode makes no customer unless asked; a buyer without one has no
    // portal and their next purchase starts over.
    customer_creation: payment && !input.customer ? "always" : undefined,
    client_reference_id: input.clientReferenceId,
    metadata,
    subscription_data: !payment && metadata ? { metadata } : undefined,
    payment_intent_data: payment && metadata ? { metadata } : undefined,
    allow_promotion_codes: input.allowPromotionCodes,
  };
}

function redirectOf(body: unknown, what: string): StripeRedirect {
  const { id, url } = (body ?? {}) as { id?: unknown; url?: unknown };
  if (typeof id !== "string" || typeof url !== "string") throw new StripeError(`Stripe returned a ${what} without a url`, 200);
  return { id, url };
}

export function createStripe(options: StripeOptions): StripeClient {
  const base = (options.apiBase ?? "https://api.stripe.com").replace(/\/+$/, "");

  async function request<T>(method: "GET" | "POST" | "DELETE", path: string, params: FormParams = {}, opts: RequestOptions = {}): Promise<T> {
    const doFetch = options.fetch ?? (globalThis.fetch as unknown as FetchLike);
    const encoded = encodeForm(params);
    const withBody = method === "POST";
    const url = `${base}/v1/${path.replace(/^\/+/, "")}${!withBody && encoded ? `?${encoded}` : ""}`;
    const headers: Record<string, string> = { Authorization: `Bearer ${options.secretKey}` };
    if (withBody) headers["Content-Type"] = "application/x-www-form-urlencoded";
    if (options.apiVersion) headers["Stripe-Version"] = options.apiVersion;
    if (opts.idempotencyKey) headers["Idempotency-Key"] = opts.idempotencyKey;

    const response = await doFetch(url, { method, headers, body: withBody ? encoded : undefined });
    const text = await response.text();
    let body: any = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    if (!response.ok) {
      const error = body?.error ?? {};
      throw new StripeError(error.message ?? `Stripe answered ${response.status}`, response.status, error.type, error.code, error.param);
    }
    if (body === null) throw new StripeError("Stripe returned a body that is not JSON", response.status);
    return body as T;
  }

  return {
    request,
    async createCheckoutSession(input, opts) {
      return redirectOf(await request("POST", "checkout/sessions", checkoutParams(input), opts), "checkout session");
    },
    async createPortalSession(input, opts) {
      const params: FormParams = { customer: input.customer, return_url: input.returnUrl, configuration: input.configuration };
      return redirectOf(await request("POST", "billing_portal/sessions", params, opts), "portal session");
    },
    getPortalConfiguration(id) {
      // Stripe leaves the products out unless asked for them.
      return request<StripePortalConfiguration>("GET", `billing_portal/configurations/${encodeURIComponent(id)}`, {
        expand: ["features.subscription_update.products"],
      });
    },
    getPrice(id) {
      return request<StripePrice>("GET", `prices/${encodeURIComponent(id)}`);
    },
    getSubscription(id) {
      return request<StripeSubscription>("GET", `subscriptions/${encodeURIComponent(id)}`);
    },
    async listSubscriptions(customer) {
      const page = await request<{ data?: StripeSubscription[] }>("GET", "subscriptions", { customer, status: "all", limit: 100 });
      return page.data ?? [];
    },
    cancelSubscription(id, opts) {
      return request<StripeSubscription>("DELETE", `subscriptions/${encodeURIComponent(id)}`, {}, opts);
    },
    async refundInvoice(invoiceId, opts) {
      const invoice = await request<StripeInvoice>("GET", `invoices/${encodeURIComponent(invoiceId)}`, { expand: ["payments"] });
      const paymentIntent = invoicePaymentIntentId(invoice);
      if (!paymentIntent || !(invoice.amount_paid && invoice.amount_paid > 0)) return null;
      const refund = await request<{ id?: string }>("POST", "refunds", { payment_intent: paymentIntent }, opts);
      return refund.id ?? null;
    },
  };
}
