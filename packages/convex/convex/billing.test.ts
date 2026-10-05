// Billing under convex-test (plan pl-840, docs/architecture/hosted-assistant.md
// "Verification"): the Stripe webhook refuses a tampered or stale delivery,
// each event lands on the wallet once and in any order Stripe sends it, and
// the checkout and portal actions call Stripe through a fake fetch. With no
// keys nothing throws and billingAvailable says so.
//
// The fake Stripe holds each subscription as it stands now, the way the real
// one answers GET /v1/subscriptions/<id>. A test that delivers an event
// carrying an older copy is a test of delivery out of order.
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { convexTest } from "convex-test";
import { httpRouter } from "convex/server";
import { signWebhook } from "@platform/billing";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { STRIPE_WEBHOOK_PATH, stripeWebhook } from "./billing";
import { addMonths, ensureWallet, periodAt, rolledOver, walletRoom, walletSummary } from "./lib/wallet";

setDefaultTimeout(60_000);

// Only the Stripe route: http.ts imports every module in the tree.
const router = httpRouter();
router.route({ path: STRIPE_WEBHOOK_PATH, method: "POST", handler: stripeWebhook });

const modules = {
  "./_generated/server.ts": () => import("./_generated/server"),
  "./billing.ts": () => import("./billing"),
  "./wallet.ts": () => import("./wallet"),
  "./http.ts": async () => ({ default: router }),
};

const SECRET = "whsec_codecast_test";
const ENV = {
  STRIPE_SECRET_KEY: "sk_test_fake",
  STRIPE_WEBHOOK_SECRET: SECRET,
  STRIPE_PRICE_PLUS: "price_plus",
  STRIPE_PRICE_PRO: "price_pro",
  STRIPE_PRICE_TOPUP: "price_topup",
  STRIPE_PORTAL_CONFIGURATION: "bpc_1",
};
const ENV_NAMES = Object.keys(ENV) as (keyof typeof ENV)[];
const DAY = 86_400_000;

let savedEnv: Record<string, string | undefined> = {};
let savedFetch: typeof fetch;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));
  Object.assign(process.env, ENV);
  savedFetch = globalThis.fetch;
});

afterEach(() => {
  for (const name of ENV_NAMES) {
    if (savedEnv[name] === undefined) delete process.env[name];
    else process.env[name] = savedEnv[name];
  }
  globalThis.fetch = savedFetch;
});

function clearEnv() {
  for (const name of ENV_NAMES) delete process.env[name];
}

type StripeCall = { method: string; path: string; query: Record<string, string>; form: Record<string, string>; headers: Record<string, string> };
type Sub = {
  id: string; customer: string; status: string; metadata: Record<string, string>;
  items: { data: { id: string; price: { id: string }; current_period_start?: number; current_period_end?: number }[] };
  latest_invoice?: string;
};

/** A portal configuration that bills an upgrade at once, holds a downgrade
 *  and a cancel to the period's end, and offers both plans. */
const SAFE_PORTAL = {
  id: "bpc_1", active: true,
  features: {
    subscription_cancel: { enabled: true, mode: "at_period_end", proration_behavior: "none" },
    subscription_update: {
      enabled: true,
      proration_behavior: "always_invoice",
      schedule_at_period_end: { conditions: [{ type: "decreasing_item_amount" }] },
      products: [{ product: "prod_plus", prices: ["price_plus"] }, { product: "prod_pro", prices: ["price_pro"] }],
    },
  },
};
/** STRIPE_PRICE_TOPUP as it must be: one-off, $1.00 a unit. */
const TOPUP_PRICE = { id: "price_topup", active: true, unit_amount: 100, currency: "usd", recurring: null };

/** Stands in for api.stripe.com: records each call and answers from the
 *  objects it holds. `fail` makes every call answer with that refusal;
 *  `intercept` answers (or throws) for the calls it picks. */
function fakeStripe() {
  const state = {
    calls: [] as StripeCall[],
    subscriptions: new Map<string, Sub>(),
    invoices: new Map<string, Record<string, unknown>>(),
    /** payment intent id -> the invoice it paid. */
    invoicePayments: new Map<string, string>(),
    portal: structuredClone(SAFE_PORTAL) as Record<string, any>,
    topupPrice: structuredClone(TOPUP_PRICE) as Record<string, any>,
    fail: null as null | { status: number; body: unknown },
    intercept: null as null | ((call: StripeCall) => Response | Error | undefined),
    put(sub: Sub) {
      state.subscriptions.set(sub.id, structuredClone(sub));
      return sub;
    },
    paths: () => state.calls.map((call) => `${call.method} ${call.path}`),
  };
  globalThis.fetch = (async (url: string, init: { method: string; body?: string; headers?: Record<string, string> }) => {
    const parsed = new URL(String(url));
    const path = parsed.pathname.replace(/^\/v1\//, "");
    const call: StripeCall = {
      method: init.method, path, query: Object.fromEntries(parsed.searchParams),
      form: Object.fromEntries(new URLSearchParams(init.body ?? "")), headers: init.headers ?? {},
    };
    state.calls.push(call);
    const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
    const missing = () => reply(404, { error: { type: "invalid_request_error", code: "resource_missing", message: `No such object: ${path}` } });
    const intercepted = state.intercept?.(call);
    if (intercepted instanceof Error) throw intercepted;
    if (intercepted) return intercepted;
    if (state.fail) return reply(state.fail.status, state.fail.body);
    if (path === "billing_portal/configurations/bpc_1") return reply(200, state.portal);
    if (path === "prices/price_topup") return reply(200, state.topupPrice);
    if (path === "checkout/sessions") return reply(200, { id: "cs_new", url: "https://checkout.stripe.test/c" });
    if (path === "billing_portal/sessions") return reply(200, { id: "bps_1", url: "https://billing.stripe.test/p" });
    if (path === "subscriptions") return reply(200, { data: [...state.subscriptions.values()].filter((s) => s.customer === call.query.customer) });
    if (path === "refunds") return reply(200, { id: "re_1" });
    if (path === "invoice_payments") {
      const invoice = state.invoicePayments.get(call.query["payment[payment_intent]"]);
      return reply(200, { data: invoice ? [{ invoice, payment: { type: "payment_intent", payment_intent: call.query["payment[payment_intent]"] } }] : [] });
    }
    const intentMatch = path.match(/^payment_intents\/(.+)$/);
    if (intentMatch) return reply(200, { id: intentMatch[1], invoice: state.invoicePayments.get(intentMatch[1]) ?? null });
    const subMatch = path.match(/^subscriptions\/(.+)$/);
    if (subMatch) {
      const sub = state.subscriptions.get(subMatch[1]);
      if (!sub) return missing();
      if (call.method === "DELETE") sub.status = "canceled";
      return reply(200, sub);
    }
    const invoiceMatch = path.match(/^invoices\/(.+)$/);
    if (invoiceMatch) return state.invoices.has(invoiceMatch[1]) ? reply(200, state.invoices.get(invoiceMatch[1])) : missing();
    return missing();
  }) as unknown as typeof fetch;
  return state;
}

async function setup() {
  const t = convexTest(schema, modules);
  const user = await t.run((ctx) => ctx.db.insert("users", { email: "dana@example.test" }));
  const wallet = () => t.run(async (ctx) => ctx.db.query("wallets").withIndex("by_user", (q) => q.eq("user_id", user)).first());
  const ledger = () => t.run((ctx) => ctx.db.query("wallet_ledger").withIndex("by_user_at", (q) => q.eq("user_id", user)).collect());
  /** Sets wallet fields directly, for a starting state. */
  const patchWallet = async (patch: Record<string, unknown>) => {
    const w = (await wallet())!;
    await t.run((ctx) => ctx.db.patch(w._id, patch));
  };
  return { t, user, wallet, ledger, patchWallet, authed: t.withIdentity({ subject: user }) };
}

let eventSeq = 0;

/** Posts `object` as a Stripe event with a valid signature (unless `header` overrides it). */
async function deliver(
  t: ReturnType<typeof convexTest>,
  type: string,
  object: Record<string, unknown>,
  options: { header?: (payload: string) => Promise<string>; body?: (payload: string) => string } = {},
) {
  const payload = JSON.stringify({ id: `evt_${++eventSeq}`, type, created: Math.floor(Date.now() / 1000), data: { object } });
  const header = options.header ? await options.header(payload) : await signWebhook(payload, SECRET);
  const response = await t.fetch(STRIPE_WEBHOOK_PATH, {
    method: "POST",
    headers: { "Stripe-Signature": header, "Content-Type": "application/json" },
    body: options.body ? options.body(payload) : payload,
  });
  return { status: response.status, body: (await response.json()) as { outcome?: string; error?: string } };
}

const outcomeOf = async (delivery: ReturnType<typeof deliver>) => (await delivery).body.outcome;

const checkoutSubscription = (user: Id<"users">, extra: Record<string, unknown> = {}) => ({
  id: "cs_sub_1", object: "checkout.session", mode: "subscription", status: "complete", payment_status: "paid",
  client_reference_id: user, customer: "cus_1", subscription: "sub_1",
  metadata: { user_id: user, kind: "plan", plan: "plus" }, ...extra,
});

const subscription = (user: Id<"users">, status: string, price: string, id = "sub_1", extra: Partial<Sub> = {}): Sub => ({
  id, customer: "cus_1", status, metadata: { user_id: user },
  items: { data: [{ id: "si_1", price: { id: price } }] }, ...extra,
});

const topupSession = (user: Id<"users">, extra: Record<string, unknown> = {}) => ({
  id: "cs_top_1", object: "checkout.session", mode: "payment", status: "complete", payment_status: "paid",
  client_reference_id: user, customer: "cus_7", payment_intent: "pi_1",
  amount_subtotal: 1000, amount_total: 1080, total_details: { amount_tax: 80, amount_discount: 0 }, currency: "usd",
  metadata: { user_id: user, kind: "topup" }, ...extra,
});

describe("billingAvailable", () => {
  test("no keys: unavailable, nothing offered, nothing throws", async () => {
    clearEnv();
    const { t } = await setup();
    expect(await t.query(api.billing.billingAvailable, {})).toEqual({ available: false, plans: [], topup: false });
  });

  test("an API key without the webhook secret is still unavailable", async () => {
    delete process.env.STRIPE_WEBHOOK_SECRET;
    const { t } = await setup();
    expect((await t.query(api.billing.billingAvailable, {})).available).toBe(false);
  });

  test("no portal configuration: unavailable, though the webhook still maps events", async () => {
    delete process.env.STRIPE_PORTAL_CONFIGURATION;
    const stripe = fakeStripe();
    const { t, user, wallet } = await setup();
    expect((await t.query(api.billing.billingAvailable, {})).available).toBe(false);
    stripe.put(subscription(user, "active", "price_plus"));
    expect(await outcomeOf(deliver(t, "checkout.session.completed", checkoutSubscription(user)))).toBe("plan:plus");
    expect((await wallet())!.plan).toBe("plus");
  });

  test("both secrets and the portal configuration: the priced plans and the top-up", async () => {
    delete process.env.STRIPE_PRICE_PRO;
    const { t } = await setup();
    expect(await t.query(api.billing.billingAvailable, {})).toEqual({ available: true, plans: ["plus"], topup: true });
  });
});

describe("startCheckout and openPortal", () => {
  test("no keys: unavailable, and Stripe is never called", async () => {
    clearEnv();
    const stripe = fakeStripe();
    const { authed } = await setup();
    expect(await authed.action(api.billing.startCheckout, { plan: "plus" })).toMatchObject({ ok: false, code: "unavailable" });
    expect(await authed.action(api.billing.openPortal, {})).toMatchObject({ ok: false, code: "unavailable" });
    expect(stripe.calls).toHaveLength(0);
  });

  test("signed out, asking for both or neither, or for the free plan is refused", async () => {
    const stripe = fakeStripe();
    const { t, authed } = await setup();
    expect(await t.action(api.billing.startCheckout, { plan: "plus" })).toMatchObject({ ok: false, code: "signed_out" });
    expect(await authed.action(api.billing.startCheckout, { plan: "plus", topup_usd: 10 })).toMatchObject({ ok: false, code: "bad_request" });
    expect(await authed.action(api.billing.startCheckout, { topup_usd: 7 })).toMatchObject({ ok: false, code: "bad_request" });
    expect(await authed.action(api.billing.startCheckout, {})).toMatchObject({ ok: false, code: "bad_request" });
    expect(await authed.action(api.billing.startCheckout, { plan: "free" })).toMatchObject({ ok: false, code: "bad_request" });
    expect(stripe.calls).toHaveLength(0);
  });

  test("a plan checkout sends the plan's price, the person, where to come back and a reuse key", async () => {
    const stripe = fakeStripe();
    const { user, authed } = await setup();
    expect(await authed.action(api.billing.startCheckout, { plan: "pro" })).toEqual({ ok: true, url: "https://checkout.stripe.test/c", via: "checkout" });
    expect(stripe.paths()).toEqual(["POST checkout/sessions"]);
    expect(stripe.calls[0].form).toMatchObject({
      mode: "subscription",
      "line_items[0][price]": "price_pro",
      client_reference_id: user,
      customer_email: "dana@example.test",
      "metadata[plan]": "pro",
      "subscription_data[metadata][user_id]": user,
    });
    expect(stripe.calls[0].form.success_url).toEndWith("/simple/plan?billing=done");
    expect(stripe.calls[0].form.cancel_url).toEndWith("/simple/plan?billing=canceled");
    // A double click asks Stripe for the same session, not a second one.
    await authed.action(api.billing.startCheckout, { plan: "pro" });
    expect(stripe.calls[0].headers["Idempotency-Key"]).toStartWith(`checkout:${user}:pro:`);
    expect(stripe.calls[1].headers["Idempotency-Key"]).toBe(stripe.calls[0].headers["Idempotency-Key"]);
  });

  test("a customer recorded within the minute gets a fresh reuse key, since the request now names the customer", async () => {
    const stripe = fakeStripe();
    const { t, user, authed } = await setup();
    await authed.action(api.billing.startCheckout, { plan: "plus" });
    // A top-up's webhook lands in the same minute and records the customer.
    await t.mutation(internal.wallet.setPlan, { user_id: user, plan: "free", stripe_customer_id: "cus_9" });
    await authed.action(api.billing.startCheckout, { plan: "plus" });
    const checkouts = stripe.calls.filter((call) => call.path === "checkout/sessions");
    expect(checkouts.map((call) => call.form.customer)).toEqual([undefined, "cus_9"]);
    expect(checkouts[0].headers["Idempotency-Key"]).toStartWith(`checkout:${user}:plus:new:`);
    expect(checkouts[1].headers["Idempotency-Key"]).toStartWith(`checkout:${user}:plus:cus_9:`);
  });

  test("a top-up is a one-off payment of that many dollars that reuses the customer on file", async () => {
    const stripe = fakeStripe();
    const { t, user, authed } = await setup();
    await t.mutation(internal.wallet.setPlan, { user_id: user, plan: "free", stripe_customer_id: "cus_9" });
    expect(await authed.action(api.billing.startCheckout, { topup_usd: 25 })).toMatchObject({ ok: true, via: "checkout" });
    expect(stripe.paths()).toEqual(["GET prices/price_topup", "POST checkout/sessions"]);
    expect(stripe.calls[1].form).toMatchObject({ mode: "payment", "line_items[0][price]": "price_topup", "line_items[0][quantity]": "25", customer: "cus_9", "metadata[kind]": "topup" });
    expect(stripe.calls[1].form.customer_email).toBeUndefined();
  });

  test("a top-up price that is not a one-off $1.00 sells nothing: $25 must never charge $250", async () => {
    const { authed } = await setup();
    for (const wrong of [{ unit_amount: 1000 }, { currency: "eur" }, { recurring: { interval: "month", interval_count: 1 } }, { active: false }]) {
      const stripe = fakeStripe();
      Object.assign(stripe.topupPrice, wrong);
      expect(await authed.action(api.billing.startCheckout, { topup_usd: 25 })).toMatchObject({ ok: false, code: "unavailable" });
      expect(stripe.paths()).toEqual(["GET prices/price_topup"]);
    }
  });

  test("someone Stripe holds a live subscription for gets the portal, even before the wallet hears of it", async () => {
    const stripe = fakeStripe();
    const { t, user, authed } = await setup();
    // The wallet knows the customer but not yet the subscription its checkout made.
    await t.mutation(internal.wallet.setPlan, { user_id: user, plan: "free", stripe_customer_id: "cus_1" });
    stripe.put(subscription(user, "active", "price_plus"));
    expect(await authed.action(api.billing.startCheckout, { plan: "pro" })).toEqual({ ok: true, url: "https://billing.stripe.test/p", via: "portal" });
    expect(stripe.paths()).toEqual(["GET subscriptions", "GET billing_portal/configurations/bpc_1", "POST billing_portal/sessions"]);
    expect(stripe.calls[0].query).toMatchObject({ customer: "cus_1", status: "all" });
    expect(stripe.calls[2].form).toMatchObject({ customer: "cus_1", configuration: "bpc_1" });
  });

  test("a customer whose subscriptions all ended gets a new checkout", async () => {
    const stripe = fakeStripe();
    const { t, user, authed } = await setup();
    await t.mutation(internal.wallet.setPlan, { user_id: user, plan: "free", stripe_customer_id: "cus_1" });
    stripe.put(subscription(user, "canceled", "price_plus"));
    expect(await authed.action(api.billing.startCheckout, { plan: "plus" })).toMatchObject({ ok: true, via: "checkout" });
    expect(stripe.calls[1].form).toMatchObject({ customer: "cus_1" });
  });

  test("the portal needs a customer", async () => {
    const stripe = fakeStripe();
    const { t, user, authed } = await setup();
    expect(await authed.action(api.billing.openPortal, {})).toMatchObject({ ok: false, code: "no_customer" });
    await t.mutation(internal.wallet.setPlan, { user_id: user, plan: "free", stripe_customer_id: "cus_1" });
    expect(await authed.action(api.billing.openPortal, {})).toEqual({ ok: true, url: "https://billing.stripe.test/p", via: "portal" });
    expect(stripe.paths()).toEqual(["GET billing_portal/configurations/bpc_1", "POST billing_portal/sessions"]);
  });

  test("a portal that would leave a plan change unpaid until renewal is refused, not opened", async () => {
    const stripe = fakeStripe();
    stripe.portal.features.subscription_update.proration_behavior = "create_prorations";
    const { t, user, authed } = await setup();
    await t.mutation(internal.wallet.setPlan, { user_id: user, plan: "free", stripe_customer_id: "cus_1" });
    expect(await authed.action(api.billing.openPortal, {})).toMatchObject({ ok: false, code: "unavailable" });
    stripe.put(subscription(user, "active", "price_plus"));
    expect(await authed.action(api.billing.startCheckout, { plan: "pro" })).toMatchObject({ ok: false, code: "unavailable" });
    expect(stripe.paths()).not.toContain("POST billing_portal/sessions");
  });

  test("a portal that cancels at once, applies a downgrade at once, or restarts the cycle is refused", async () => {
    const unsafe: ((portal: Record<string, any>) => void)[] = [
      (portal) => Object.assign(portal.features.subscription_cancel, { mode: "immediately", proration_behavior: "create_prorations" }),
      (portal) => Object.assign(portal.features.subscription_cancel, { mode: "immediately", proration_behavior: "none" }),
      (portal) => { portal.features.subscription_update.schedule_at_period_end = null; },
      (portal) => { portal.features.subscription_update.billing_cycle_anchor = "now"; },
    ];
    const { t, user, authed } = await setup();
    await t.mutation(internal.wallet.setPlan, { user_id: user, plan: "free", stripe_customer_id: "cus_1" });
    for (const spoil of unsafe) {
      const stripe = fakeStripe();
      spoil(stripe.portal);
      expect(await authed.action(api.billing.openPortal, {})).toMatchObject({ ok: false, code: "unavailable" });
      expect(stripe.paths()).toEqual(["GET billing_portal/configurations/bpc_1"]);
    }
  });

  test("the portal configuration is read with its products, which Stripe leaves out otherwise", async () => {
    const stripe = fakeStripe();
    const { t, user, authed } = await setup();
    await t.mutation(internal.wallet.setPlan, { user_id: user, plan: "free", stripe_customer_id: "cus_1" });
    await authed.action(api.billing.openPortal, {});
    expect(stripe.calls[0].query).toEqual({ "expand[0]": "features.subscription_update.products" });
  });

  test("a Stripe refusal comes back as a value, not a throw", async () => {
    const stripe = fakeStripe();
    stripe.fail = { status: 400, body: { error: { type: "invalid_request_error", message: "No such price: 'price_plus'" } } };
    const { authed } = await setup();
    expect(await authed.action(api.billing.startCheckout, { plan: "plus" })).toMatchObject({ ok: false, code: "stripe_error" });
  });
});

describe("webhook signature", () => {
  test("a valid signature is applied", async () => {
    const stripe = fakeStripe();
    const { t, user, wallet } = await setup();
    stripe.put(subscription(user, "active", "price_plus"));
    expect(await deliver(t, "checkout.session.completed", checkoutSubscription(user))).toEqual({ status: 200, body: { received: true, outcome: "plan:plus" } } as any);
    expect((await wallet())!.plan).toBe("plus");
  });

  test("a tampered body is refused and changes nothing", async () => {
    const stripe = fakeStripe();
    const { t, user, wallet } = await setup();
    stripe.put(subscription(user, "active", "price_plus"));
    const result = await deliver(t, "checkout.session.completed", checkoutSubscription(user), { body: (payload) => payload.replace('"plus"', '"pro"') });
    expect(result).toEqual({ status: 400, body: { error: "bad_signature" } });
    expect(await wallet()).toBeNull();
    expect(stripe.calls).toHaveLength(0);
  });

  test("a stale delivery is refused even though it is signed", async () => {
    fakeStripe();
    const { t, user, wallet } = await setup();
    const result = await deliver(t, "checkout.session.completed", checkoutSubscription(user), {
      header: (payload) => signWebhook(payload, SECRET, Math.floor(Date.now() / 1000) - 3600),
    });
    expect(result).toEqual({ status: 400, body: { error: "stale" } });
    expect(await wallet()).toBeNull();
  });

  test("a delivery signed with another secret is refused", async () => {
    fakeStripe();
    const { t, user } = await setup();
    const result = await deliver(t, "checkout.session.completed", checkoutSubscription(user), { header: (payload) => signWebhook(payload, "whsec_other") });
    expect(result.status).toBe(400);
  });

  test("no webhook secret or no API key: refused without throwing, so Stripe retries once both are set", async () => {
    fakeStripe();
    const { t, user } = await setup();
    delete process.env.STRIPE_WEBHOOK_SECRET;
    expect((await deliver(t, "checkout.session.completed", checkoutSubscription(user))).status).toBe(503);
    process.env.STRIPE_WEBHOOK_SECRET = SECRET;
    delete process.env.STRIPE_SECRET_KEY;
    expect((await deliver(t, "checkout.session.completed", checkoutSubscription(user))).status).toBe(503);
  });

  test("an event type billing does not map is acknowledged and ignored", async () => {
    fakeStripe();
    const { t } = await setup();
    expect(await deliver(t, "customer.created", { id: "cus_1" })).toEqual({ status: 200, body: { received: true, outcome: "ignored:type" } } as any);
  });

  test("Stripe unreachable: an error so the delivery comes again; a subscription Stripe does not have: acknowledged", async () => {
    const stripe = fakeStripe();
    const { t, user, wallet } = await setup();
    stripe.fail = { status: 500, body: { error: { type: "api_error", message: "down" } } };
    expect((await deliver(t, "customer.subscription.updated", subscription(user, "active", "price_plus"))).status).toBe(502);
    stripe.fail = null;
    expect(await outcomeOf(deliver(t, "customer.subscription.updated", subscription(user, "active", "price_plus", "sub_gone")))).toBe("ignored:missing");
    expect(await wallet()).toBeNull();
  });
});

describe("subscription events, mapped from Stripe's current state", () => {
  test("checkout.session.completed for a plan sets the plan, cap and Stripe ids", async () => {
    const stripe = fakeStripe();
    const { t, user, wallet } = await setup();
    stripe.put(subscription(user, "active", "price_plus"));
    await deliver(t, "checkout.session.completed", checkoutSubscription(user));
    expect(await wallet()).toMatchObject({
      plan: "plus", period_cap_usd: 12, stripe_customer_id: "cus_1", stripe_subscription_id: "sub_1", subscription_status: "active",
    });
  });

  test("updated(active), then a late created(incomplete), then the checkout: live on Plus, and no second subscription can start", async () => {
    const stripe = fakeStripe();
    const { t, user, wallet, authed } = await setup();
    stripe.put(subscription(user, "active", "price_plus"));
    expect(await outcomeOf(deliver(t, "customer.subscription.updated", subscription(user, "active", "price_plus")))).toBe("plan:plus");
    expect(await outcomeOf(deliver(t, "customer.subscription.created", subscription(user, "incomplete", "price_plus")))).toBe("plan:plus");
    expect(await outcomeOf(deliver(t, "checkout.session.completed", checkoutSubscription(user)))).toBe("plan:plus");
    expect(await wallet()).toMatchObject({ plan: "plus", subscription_status: "active", period_cap_usd: 12 });
    expect(await authed.action(api.billing.startCheckout, { plan: "pro" })).toMatchObject({ ok: true, via: "portal" });
  });

  test("an old updated(unpaid) arriving after a recovered card's updated(active) leaves the plan paid", async () => {
    const stripe = fakeStripe();
    const { t, user, wallet } = await setup();
    stripe.put(subscription(user, "active", "price_pro"));
    await deliver(t, "customer.subscription.updated", subscription(user, "active", "price_pro"));
    expect(await outcomeOf(deliver(t, "customer.subscription.updated", subscription(user, "unpaid", "price_pro")))).toBe("plan:pro");
    expect(await wallet()).toMatchObject({ plan: "pro", subscription_status: "active" });
  });

  test("Plus to Pro and back to Plus, delivered reversed, ends on Plus as Stripe bills", async () => {
    const stripe = fakeStripe();
    const { t, user, wallet } = await setup();
    stripe.put(subscription(user, "active", "price_plus"));
    await deliver(t, "checkout.session.completed", checkoutSubscription(user));
    await deliver(t, "customer.subscription.updated", subscription(user, "active", "price_plus"));
    await deliver(t, "customer.subscription.updated", subscription(user, "active", "price_pro"));
    expect((await wallet())!.plan).toBe("plus");
  });

  test("the plan follows the price and the status: past_due keeps the plan, unpaid ends it", async () => {
    const stripe = fakeStripe();
    const { t, user, wallet } = await setup();
    stripe.put(subscription(user, "active", "price_plus"));
    await deliver(t, "checkout.session.completed", checkoutSubscription(user));
    stripe.put(subscription(user, "past_due", "price_plus"));
    expect(await outcomeOf(deliver(t, "customer.subscription.updated", subscription(user, "past_due", "price_plus")))).toBe("plan:plus");
    expect(await wallet()).toMatchObject({ plan: "plus", subscription_status: "past_due" });
    stripe.put(subscription(user, "unpaid", "price_plus"));
    expect(await outcomeOf(deliver(t, "customer.subscription.updated", subscription(user, "unpaid", "price_plus")))).toBe("plan:free");
    expect(await wallet()).toMatchObject({ plan: "free", subscription_status: "unpaid" });
  });

  test("an unknown price leaves the plan alone", async () => {
    const stripe = fakeStripe();
    const { t, user, wallet } = await setup();
    stripe.put(subscription(user, "active", "price_plus"));
    await deliver(t, "checkout.session.completed", checkoutSubscription(user));
    stripe.put(subscription(user, "active", "price_someone_else"));
    expect(await outcomeOf(deliver(t, "customer.subscription.updated", subscription(user, "active", "price_someone_else")))).toBe("ignored:unknown_price");
    expect((await wallet())!.plan).toBe("plus");
  });

  test("customer.subscription.deleted returns the person to free, and a late update cannot undo it", async () => {
    const stripe = fakeStripe();
    const { t, user, wallet } = await setup();
    stripe.put(subscription(user, "active", "price_plus"));
    await deliver(t, "checkout.session.completed", checkoutSubscription(user));
    stripe.put(subscription(user, "canceled", "price_plus"));
    expect(await outcomeOf(deliver(t, "customer.subscription.deleted", subscription(user, "canceled", "price_plus")))).toBe("plan:free");
    expect(await wallet()).toMatchObject({ plan: "free", subscription_status: "canceled" });
    expect(await outcomeOf(deliver(t, "customer.subscription.updated", subscription(user, "active", "price_plus")))).toBe("plan:free");
    expect((await wallet())!.plan).toBe("free");
  });

  test("a late delete of an old subscription does not cancel the new one", async () => {
    const stripe = fakeStripe();
    const { t, user, wallet } = await setup();
    stripe.put(subscription(user, "canceled", "price_plus", "sub_1"));
    stripe.put(subscription(user, "active", "price_pro", "sub_2"));
    await deliver(t, "checkout.session.completed", checkoutSubscription(user, { id: "cs_2", subscription: "sub_2" }));
    expect(await outcomeOf(deliver(t, "customer.subscription.deleted", subscription(user, "canceled", "price_plus", "sub_1")))).toBe("ignored:other_subscription");
    expect(await wallet()).toMatchObject({ plan: "pro", stripe_subscription_id: "sub_2", subscription_status: "active" });
  });

  test("an incomplete checkout grants nothing until its payment confirms", async () => {
    const stripe = fakeStripe();
    const { t, user, wallet } = await setup();
    stripe.put(subscription(user, "incomplete", "price_plus"));
    expect(await outcomeOf(deliver(t, "checkout.session.completed", checkoutSubscription(user, { payment_status: "unpaid" })))).toBe("plan:free");
    expect(await wallet()).toMatchObject({ plan: "free", subscription_status: "incomplete" });
    stripe.put(subscription(user, "active", "price_plus"));
    expect(await outcomeOf(deliver(t, "customer.subscription.updated", subscription(user, "active", "price_plus")))).toBe("plan:plus");
    expect(await wallet()).toMatchObject({ plan: "plus", period_cap_usd: 12 });
  });

  test("a checkout whose first payment never confirms leaves a plan granted by hand alone", async () => {
    const stripe = fakeStripe();
    const { t, user, wallet } = await setup();
    await t.mutation(internal.wallet.setPlan, { user_id: user, plan: "pro" });
    const granted = (await wallet())!;
    stripe.put(subscription(user, "incomplete", "price_plus"));
    expect(await outcomeOf(deliver(t, "customer.subscription.created", subscription(user, "incomplete", "price_plus")))).toBe("plan:pro");
    stripe.put(subscription(user, "incomplete_expired", "price_plus"));
    expect(await outcomeOf(deliver(t, "customer.subscription.updated", subscription(user, "incomplete_expired", "price_plus")))).toBe("plan:pro");
    expect(await wallet()).toMatchObject({ plan: "pro", period_cap_usd: granted.period_cap_usd, subscription_status: "incomplete_expired" });
  });
});

describe("reads that commit out of order", () => {
  /** Applies `sub` the way the webhook's action does, as read at `readAt`. */
  const applyRead = (t: ReturnType<typeof convexTest>, sub: Sub, readAt: number) =>
    t.mutation(internal.billing.applyStripeEvent, {
      id: `evt_read_${readAt}`, type: "customer.subscription.updated",
      object_json: JSON.stringify(sub), subscription_json: JSON.stringify(sub), read_at: readAt,
    });

  test("the webhook stamps each subscription it maps with when it read it", async () => {
    const stripe = fakeStripe();
    const { t, user, wallet } = await setup();
    stripe.put(subscription(user, "active", "price_plus"));
    const before = Date.now();
    await deliver(t, "checkout.session.completed", checkoutSubscription(user));
    expect((await wallet())!.subscription_read_at).toBeGreaterThanOrEqual(before);
  });

  test("an older snapshot committing after a newer one is skipped: incomplete or past_due cannot undo active", async () => {
    const stripe = fakeStripe();
    const { t, user, wallet } = await setup();
    stripe.put(subscription(user, "active", "price_plus"));
    await deliver(t, "checkout.session.completed", checkoutSubscription(user));
    const stamp = (await wallet())!.subscription_read_at!;

    expect(await applyRead(t, subscription(user, "incomplete", "price_plus"), stamp - 1000)).toBe("ignored:stale_read");
    expect(await applyRead(t, subscription(user, "past_due", "price_plus"), stamp - 1)).toBe("ignored:stale_read");
    expect(await wallet()).toMatchObject({ plan: "plus", subscription_status: "active", period_cap_usd: 12, subscription_read_at: stamp });

    // A newer read still applies.
    expect(await applyRead(t, subscription(user, "past_due", "price_plus"), stamp + 1000)).toBe("plan:plus");
    expect(await wallet()).toMatchObject({ subscription_status: "past_due", period_cap_usd: 2, subscription_read_at: stamp + 1000 });
  });

  test("a subscription recorded as canceled never maps back to live, however its read is stamped", async () => {
    const stripe = fakeStripe();
    const { t, user, wallet } = await setup();
    stripe.put(subscription(user, "active", "price_plus"));
    await deliver(t, "checkout.session.completed", checkoutSubscription(user));
    const activeRead = (await wallet())!.subscription_read_at!;
    stripe.put(subscription(user, "canceled", "price_plus"));
    await deliver(t, "customer.subscription.deleted", subscription(user, "canceled", "price_plus"));
    expect(await wallet()).toMatchObject({ plan: "free", subscription_status: "canceled" });

    expect(await applyRead(t, subscription(user, "active", "price_plus"), activeRead)).toBe("ignored:ended");
    expect(await applyRead(t, subscription(user, "active", "price_pro"), Date.now() + 60_000)).toBe("ignored:ended");
    const after = (await wallet())!;
    expect(after).toMatchObject({ plan: "free", subscription_status: "canceled" });
    // The cancel prorates by the milliseconds that passed, so the cap is the
    // free allowance give or take a hair.
    expect(after.period_cap_usd).toBeCloseTo(2, 3);
  });
});

describe("a paid allowance waits for its period to be paid", () => {
  /** Stripe's renewal invoice for `period`, in Stripe's seconds. */
  const renewal = (period: { start: number; end: number }) => ({
    id: `in_${period.start}`, object: "invoice", customer: "cus_1", billing_reason: "subscription_cycle", subscription: "sub_1",
    lines: { data: [{ period: { start: Math.floor(period.start / 1000), end: Math.floor(period.end / 1000) } }] },
  });

  test("a subscribed wallet rolls into its next period on the free allowance, and the renewal's invoice.paid raises it", async () => {
    const stripe = fakeStripe();
    const { t, user, wallet } = await setup();
    stripe.put(subscription(user, "active", "price_plus"));
    await deliver(t, "checkout.session.completed", checkoutSubscription(user));
    const first = (await wallet())!;
    expect(first).toMatchObject({ plan: "plus", period_cap_usd: 12, paid_through: first.period_end });

    // The boundary passes before Stripe has charged the renewal.
    const later = first.period_end + 1000;
    expect(rolledOver(first, later)!.period_cap_usd).toBe(2);
    expect(await t.run((ctx) => walletSummary(ctx, user, later))).toMatchObject({ plan: "plus", cap_usd: 2 });
    await t.run((ctx) => ensureWallet(ctx, user, later));
    const unpaid = (await wallet())!;
    expect(unpaid).toMatchObject({ plan: "plus", subscription_status: "active", period_cap_usd: 2, period_start: first.period_end });

    // The renewal is paid: the period it opened gets the plan's whole allowance, once.
    expect(await outcomeOf(deliver(t, "invoice.paid", renewal({ start: unpaid.period_start, end: unpaid.period_end })))).toBe("period");
    const paid = (await wallet())!;
    expect(paid.period_cap_usd).toBe(12);
    expect(paid.paid_through).toBe(Math.floor(unpaid.period_end / 1000) * 1000);
    expect(await outcomeOf(deliver(t, "invoice.paid", renewal({ start: unpaid.period_start, end: unpaid.period_end })))).toBe("ignored:period_unchanged");

    // Events stop arriving (a lapsed card, a disabled endpoint): the period
    // after that one grants the free allowance, every month.
    expect(rolledOver(paid, paid.period_end + 1000)!.period_cap_usd).toBe(2);
    expect(rolledOver(paid, addMonths(paid.period_end, 3) + 1000)!.period_cap_usd).toBe(2);
  });

  test("a plan granted by hand keeps its whole allowance at every rollover, and a cancel lifts the gate", async () => {
    const stripe = fakeStripe();
    const { t, user, wallet } = await setup();
    await t.mutation(internal.wallet.setPlan, { user_id: user, plan: "pro" });
    const granted = (await wallet())!;
    expect(granted.paid_through).toBeUndefined();
    expect(rolledOver(granted, granted.period_end + 1000)!.period_cap_usd).toBe(40);

    stripe.put(subscription(user, "active", "price_plus"));
    await deliver(t, "checkout.session.completed", checkoutSubscription(user));
    expect((await wallet())!.paid_through).toBeDefined();
    stripe.put(subscription(user, "canceled", "price_plus"));
    await deliver(t, "customer.subscription.deleted", subscription(user, "canceled", "price_plus"));
    expect((await wallet())!.paid_through).toBeUndefined();
  });
});

describe("a plan's own payment refunded or disputed", () => {
  const seconds = (ms: number) => Math.floor(ms / 1000);
  /** The current period: started 29 days ago, renews tomorrow, where a cancel
   *  by time would keep 29/30 of Plus. */
  const current = { start: seconds(Date.now() - 29 * DAY), end: seconds(Date.now() + DAY) };
  const earlier = { start: current.start - seconds(30 * DAY), end: current.start };
  const periodInvoice = (id: string, paymentIntent: string, period: { start: number; end: number }, extra: Record<string, unknown> = {}) => ({
    id, customer: "cus_1", subscription: "sub_1", amount_paid: 1200, payment_intent: paymentIntent,
    billing_reason: "subscription_cycle", lines: { data: [{ period }] }, ...extra,
  });
  const plusSub = (user: Id<"users">, status: string, extra: Partial<Sub> = {}) =>
    subscription(user, status, "price_plus", "sub_1", {
      items: { data: [{ id: "si_1", price: { id: "price_plus" }, current_period_start: current.start, current_period_end: current.end }] },
      latest_invoice: "in_1",
      ...extra,
    });

  /** Dana on Plus through sub_1, whose current period's invoice in_1 was paid by pi_plan. */
  async function onPlus() {
    const stripe = fakeStripe();
    const ctx = await setup();
    stripe.put(plusSub(ctx.user, "active"));
    stripe.invoices.set("in_1", periodInvoice("in_1", "pi_plan", current));
    stripe.invoicePayments.set("pi_plan", "in_1");
    await deliver(ctx.t, "checkout.session.completed", checkoutSubscription(ctx.user));
    expect((await ctx.wallet())!.plan).toBe("plus");
    await ctx.patchWallet({ period_start: Date.now() - 29 * DAY, period_end: Date.now() + DAY });
    return { stripe, ...ctx };
  }
  const planCharge = (refunded: number, extra: Record<string, unknown> = {}) =>
    ({ id: "ch_plan", object: "charge", payment_intent: "pi_plan", amount: 1200, amount_refunded: refunded, refunded: refunded >= 1200, currency: "usd", ...extra });
  const dispute = { id: "dp_1", charge: "ch_plan", payment_intent: "pi_plan", amount: 1200 };
  const deletes = (stripe: ReturnType<typeof fakeStripe>) => stripe.calls.filter((call) => call.method === "DELETE");

  test("a dispute cancels the subscription and returns the person to free at once; a redelivery cancels nothing more", async () => {
    const { t, stripe, wallet } = await onPlus();
    expect(await outcomeOf(deliver(t, "charge.dispute.created", dispute))).toBe("plan_canceled");
    // The money went back, so none of Plus's allowance stays.
    expect(await wallet()).toMatchObject({ plan: "free", subscription_status: "canceled", period_cap_usd: 2 });
    expect(deletes(stripe)).toHaveLength(1);
    expect(deletes(stripe)[0].path).toBe("subscriptions/sub_1");
    expect(deletes(stripe)[0].headers["Idempotency-Key"]).toBe("cancel-disputed:sub_1");
    expect(await outcomeOf(deliver(t, "charge.dispute.created", dispute))).toBe("plan_canceled");
    expect(deletes(stripe)).toHaveLength(1);
    expect((await wallet())!.period_cap_usd).toBe(2);
  });

  test("Stripe's delete for the cancel landing first, prorated, is put right by the dispute's mapping", async () => {
    const { t, user, stripe, wallet } = await onPlus();
    stripe.put(plusSub(user, "canceled"));
    expect(await outcomeOf(deliver(t, "customer.subscription.deleted", plusSub(user, "canceled")))).toBe("plan:free");
    // An ordinary cancel by time keeps the share of Plus already used.
    expect((await wallet())!.period_cap_usd).toBeGreaterThan(11);
    expect(await outcomeOf(deliver(t, "charge.dispute.created", dispute))).toBe("plan_canceled");
    expect(await wallet()).toMatchObject({ plan: "free", subscription_status: "canceled", period_cap_usd: 2 });
    expect(deletes(stripe)).toHaveLength(0);
  });

  test("a redelivery after the cancel went through but its mapping did not still ends the allowance", async () => {
    const { t, user, stripe, wallet } = await onPlus();
    // Stripe canceled sub_1; the wallet never heard (the action died after the DELETE).
    stripe.put(plusSub(user, "canceled"));
    expect(await outcomeOf(deliver(t, "charge.refunded", planCharge(1200)))).toBe("plan_canceled");
    expect(await wallet()).toMatchObject({ plan: "free", subscription_status: "canceled", period_cap_usd: 2 });
    expect(deletes(stripe)).toHaveLength(0);
  });

  test("a subscription that ran to the end of its last period is left as it ended", async () => {
    const { t, user, stripe, wallet, patchWallet } = await onPlus();
    stripe.put(plusSub(user, "canceled", { items: { data: [{ id: "si_1", price: { id: "price_plus" }, current_period_start: earlier.start, current_period_end: earlier.end }] } }));
    await patchWallet({ subscription_status: "canceled", plan: "free", period_cap_usd: 5 });
    expect(await outcomeOf(deliver(t, "charge.dispute.created", dispute))).toBe("ignored:already_ended");
    expect((await wallet())!.period_cap_usd).toBe(5);
  });

  test("a full refund of the current period's payment ends the plan, read from an older API version's charge.invoice", async () => {
    const { t, stripe, wallet } = await onPlus();
    stripe.invoicePayments.clear();
    expect(await outcomeOf(deliver(t, "charge.refunded", planCharge(1200, { invoice: "in_1" })))).toBe("plan_canceled");
    expect(await wallet()).toMatchObject({ plan: "free", subscription_status: "canceled", period_cap_usd: 2 });
    expect(deletes(stripe)[0].headers["Idempotency-Key"]).toBe("cancel-refunded:sub_1");
  });

  test("a partial refund, or a full refund of an earlier period, leaves the plan", async () => {
    const { t, stripe, wallet } = await onPlus();
    expect(await outcomeOf(deliver(t, "charge.refunded", planCharge(600)))).toBe("ignored:partial_refund");
    stripe.invoices.set("in_0", periodInvoice("in_0", "pi_old", earlier, { billing_reason: "subscription_create" }));
    stripe.invoicePayments.set("pi_old", "in_0");
    expect(await outcomeOf(deliver(t, "charge.refunded", planCharge(1200, { id: "ch_old", payment_intent: "pi_old" })))).toBe("ignored:past_period");
    expect(await wallet()).toMatchObject({ plan: "plus", subscription_status: "active" });
    expect(deletes(stripe)).toHaveLength(0);
  });

  test("the period is decided by the invoice's period, not by which invoice came last", async () => {
    const { t, user, stripe, wallet } = await onPlus();
    // A mid-period upgrade billed at once: its proration invoice is now the latest.
    stripe.invoices.set("in_p", periodInvoice("in_p", "pi_prorate", { start: seconds(Date.now() - DAY), end: current.end }, { billing_reason: "subscription_update", amount_paid: 300 }));
    stripe.invoicePayments.set("pi_prorate", "in_p");
    stripe.put(plusSub(user, "active", { latest_invoice: "in_p" }));
    expect(await outcomeOf(deliver(t, "charge.refunded", planCharge(300, { id: "ch_p", payment_intent: "pi_prorate", amount: 300 })))).toBe("ignored:not_a_period");
    expect((await wallet())!.plan).toBe("plus");
    expect(deletes(stripe)).toHaveLength(0);
    expect(await outcomeOf(deliver(t, "charge.refunded", planCharge(1200)))).toBe("plan_canceled");
    expect(await wallet()).toMatchObject({ plan: "free", period_cap_usd: 2 });
  });

  test("an invoice another payment paid ends nothing", async () => {
    const { t, stripe, wallet } = await onPlus();
    stripe.invoices.set("in_x", periodInvoice("in_x", "pi_other", current));
    expect(await outcomeOf(deliver(t, "charge.refunded", planCharge(1200, { invoice: "in_x" })))).toBe("ignored:not_a_plan");
    expect(await outcomeOf(deliver(t, "charge.dispute.created", { ...dispute, payment_intent: "pi_stray" }))).toBe("ignored:not_a_plan");
    expect(await wallet()).toMatchObject({ plan: "plus", subscription_status: "active" });
    expect(deletes(stripe)).toHaveLength(0);
  });

  test("the refund of a second subscription's payment leaves the wallet's own subscription alone", async () => {
    const { t, stripe, wallet } = await onPlus();
    stripe.invoices.set("in_9", periodInvoice("in_9", "pi_dup", current, { subscription: "sub_2" }));
    stripe.invoicePayments.set("pi_dup", "in_9");
    expect(await outcomeOf(deliver(t, "charge.refunded", planCharge(1200, { id: "ch_dup", payment_intent: "pi_dup" })))).toBe("ignored:other_subscription");
    expect(await wallet()).toMatchObject({ plan: "plus", stripe_subscription_id: "sub_1", subscription_status: "active" });
    expect(deletes(stripe)).toHaveLength(0);
  });
});

describe("a second live subscription", () => {
  test("is canceled and its first payment refunded while the first one is live", async () => {
    const stripe = fakeStripe();
    const { t, user, wallet } = await setup();
    stripe.put(subscription(user, "active", "price_plus", "sub_1"));
    stripe.put(subscription(user, "active", "price_plus", "sub_2", { latest_invoice: "in_2" }));
    stripe.invoices.set("in_2", { id: "in_2", amount_paid: 2000, payments: { data: [{ status: "paid", payment: { type: "payment_intent", payment_intent: "pi_2" } }] } });
    await deliver(t, "checkout.session.completed", checkoutSubscription(user));

    stripe.calls.length = 0;
    expect(await outcomeOf(deliver(t, "checkout.session.completed", checkoutSubscription(user, { id: "cs_2", subscription: "sub_2" })))).toBe("duplicate_canceled");
    expect(stripe.paths()).toEqual(["GET subscriptions/sub_2", "GET subscriptions/sub_1", "GET subscriptions/sub_2", "GET invoices/in_2", "POST refunds", "DELETE subscriptions/sub_2"]);
    expect(stripe.calls[4].form).toEqual({ payment_intent: "pi_2" });
    expect(stripe.calls[4].headers["Idempotency-Key"]).toBe("refund-duplicate:sub_2");
    expect(stripe.calls[5].headers["Idempotency-Key"]).toBe("cancel-duplicate:sub_2");
    expect(await wallet()).toMatchObject({ plan: "plus", stripe_subscription_id: "sub_1", subscription_status: "active" });

    // Its own events afterwards (Stripe now says canceled) change nothing.
    expect(await outcomeOf(deliver(t, "customer.subscription.deleted", subscription(user, "canceled", "price_plus", "sub_2")))).toBe("ignored:other_subscription");
    expect((await wallet())!.stripe_subscription_id).toBe("sub_1");
  });

  test("is left alone when Stripe's current copy has ended since the event's first read", async () => {
    const stripe = fakeStripe();
    const { t, user, wallet } = await setup();
    stripe.put(subscription(user, "active", "price_plus", "sub_1"));
    stripe.put(subscription(user, "canceled", "price_plus", "sub_2", { latest_invoice: "in_2" }));
    stripe.invoices.set("in_2", { id: "in_2", amount_paid: 2000, payment_intent: "pi_2" });
    await deliver(t, "checkout.session.completed", checkoutSubscription(user));

    // The event's first read of sub_2 still saw it live; it ended before the
    // duplicate was resolved.
    let firstRead = true;
    stripe.intercept = (call) => {
      if (call.method !== "GET" || call.path !== "subscriptions/sub_2" || !firstRead) return undefined;
      firstRead = false;
      return new Response(JSON.stringify(subscription(user, "active", "price_plus", "sub_2", { latest_invoice: "in_2" })), { status: 200 });
    };
    stripe.calls.length = 0;
    expect(await outcomeOf(deliver(t, "checkout.session.completed", checkoutSubscription(user, { id: "cs_2", subscription: "sub_2" })))).toBe("ignored:other_subscription");
    expect(stripe.paths()).not.toContain("POST refunds");
    expect(stripe.paths()).not.toContain("DELETE subscriptions/sub_2");
    expect(await wallet()).toMatchObject({ plan: "plus", stripe_subscription_id: "sub_1", subscription_status: "active" });
  });

  test("a refund that fails on the way leaves the duplicate live, and the redelivery refunds and cancels it", async () => {
    const stripe = fakeStripe();
    const { t, user, wallet } = await setup();
    stripe.put(subscription(user, "active", "price_plus", "sub_1"));
    stripe.put(subscription(user, "active", "price_plus", "sub_2", { latest_invoice: "in_2" }));
    stripe.invoices.set("in_2", { id: "in_2", amount_paid: 2000, payment_intent: "pi_2" });
    await deliver(t, "checkout.session.completed", checkoutSubscription(user));

    let dropped = false;
    stripe.intercept = (call) => {
      if (call.path !== "refunds" || dropped) return undefined;
      dropped = true;
      return new TypeError("fetch failed");
    };
    stripe.calls.length = 0;
    const duplicate = checkoutSubscription(user, { id: "cs_2", subscription: "sub_2" });
    const first = await deliver(t, "checkout.session.completed", duplicate).catch(() => ({ status: 500 }));
    expect(first.status).toBeGreaterThanOrEqual(500);
    expect(stripe.paths()).not.toContain("DELETE subscriptions/sub_2");
    expect(stripe.subscriptions.get("sub_2")!.status).toBe("active");

    stripe.calls.length = 0;
    expect(await outcomeOf(deliver(t, "checkout.session.completed", duplicate))).toBe("duplicate_canceled");
    expect(stripe.paths().slice(-2)).toEqual(["POST refunds", "DELETE subscriptions/sub_2"]);
    expect(stripe.calls.find((call) => call.path === "refunds")!.headers["Idempotency-Key"]).toBe("refund-duplicate:sub_2");
    expect(stripe.subscriptions.get("sub_2")!.status).toBe("canceled");
    expect((await wallet())!.stripe_subscription_id).toBe("sub_1");
  });

  test("a refund Stripe refuses is left to a person, and the duplicate is still canceled", async () => {
    const stripe = fakeStripe();
    const { t, user } = await setup();
    stripe.put(subscription(user, "active", "price_plus", "sub_1"));
    stripe.put(subscription(user, "active", "price_plus", "sub_2", { latest_invoice: "in_2" }));
    stripe.invoices.set("in_2", { id: "in_2", amount_paid: 2000, payment_intent: "pi_2" });
    await deliver(t, "checkout.session.completed", checkoutSubscription(user));
    stripe.intercept = (call) => call.path === "refunds"
      ? new Response(JSON.stringify({ error: { type: "invalid_request_error", code: "charge_already_refunded", message: "already refunded" } }), { status: 400 })
      : undefined;
    expect(await outcomeOf(deliver(t, "checkout.session.completed", checkoutSubscription(user, { id: "cs_2", subscription: "sub_2" })))).toBe("duplicate_canceled");
    expect(stripe.subscriptions.get("sub_2")!.status).toBe("canceled");
  });

  test("replaces the wallet's record when that one has in fact ended", async () => {
    const stripe = fakeStripe();
    const { t, user, wallet } = await setup();
    stripe.put(subscription(user, "active", "price_plus", "sub_1"));
    await deliver(t, "checkout.session.completed", checkoutSubscription(user));
    // sub_1 was canceled and sub_2 bought; sub_1's delete has not arrived.
    stripe.put(subscription(user, "canceled", "price_plus", "sub_1"));
    stripe.put(subscription(user, "active", "price_pro", "sub_2"));
    expect(await outcomeOf(deliver(t, "checkout.session.completed", checkoutSubscription(user, { id: "cs_2", subscription: "sub_2" })))).toBe("plan:pro");
    expect(stripe.paths()).not.toContain("DELETE subscriptions/sub_2");
    expect(await wallet()).toMatchObject({ plan: "pro", stripe_subscription_id: "sub_2", subscription_status: "active", period_cap_usd: 40 });
  });
});

describe("plan changes are charged by time", () => {
  /** A wallet on Plus with the period's last day to run and $5 used. */
  async function plusNearRenewal() {
    const stripe = fakeStripe();
    const s = await setup();
    stripe.put(subscription(s.user, "active", "price_plus"));
    await deliver(s.t, "checkout.session.completed", checkoutSubscription(s.user));
    const now = Date.now();
    await s.patchWallet({ period_start: now - 29 * DAY, period_end: now + DAY, period_cost_usd: 5 });
    return { ...s, stripe };
  }

  test("an upgrade a day before renewal adds a thirtieth of the difference, and the downgrade back takes it away", async () => {
    const { t, user, wallet, stripe } = await plusNearRenewal();
    stripe.put(subscription(user, "active", "price_pro"));
    await deliver(t, "customer.subscription.updated", subscription(user, "active", "price_pro"));
    const upgraded = (await wallet())!;
    expect(upgraded.plan).toBe("pro");
    expect(upgraded.period_cap_usd).toBeCloseTo(12 + 28 / 30, 2);

    stripe.put(subscription(user, "active", "price_plus"));
    await deliver(t, "customer.subscription.updated", subscription(user, "active", "price_plus"));
    expect((await wallet())!.period_cap_usd).toBeCloseTo(12, 2);
    // Redelivery moves nothing.
    await deliver(t, "customer.subscription.updated", subscription(user, "active", "price_plus"));
    expect((await wallet())!.period_cap_usd).toBeCloseTo(12, 2);
  });

  test("a downgrade may leave the cap below what was already used, which leaves no room", async () => {
    const { t, user, wallet, stripe, patchWallet } = await plusNearRenewal();
    const now = Date.now();
    await patchWallet({ period_start: now - DAY, period_end: now + 29 * DAY, period_cost_usd: 11.5 });
    stripe.put(subscription(user, "canceled", "price_plus"));
    await deliver(t, "customer.subscription.deleted", subscription(user, "canceled", "price_plus"));
    const w = (await wallet())!;
    expect(w.plan).toBe("free");
    expect(w.period_cap_usd).toBeCloseTo(12 - 10 * 29 / 30, 2);
    expect(walletRoom(w)).toBe(0);
  });

  test("going down and back up after spending mints no usage", async () => {
    const { t, user, wallet, stripe, patchWallet } = await plusNearRenewal();
    const now = Date.now();
    const move = async (price: string) => {
      stripe.put(subscription(user, "active", price));
      await deliver(t, "customer.subscription.updated", subscription(user, "active", price));
    };
    await move("price_pro");
    // Halfway through, with the whole Pro allowance spent.
    await patchWallet({ period_start: now - 15 * DAY, period_end: now + 15 * DAY, period_cap_usd: 40, period_cost_usd: 40 });
    for (let round = 0; round < 2; round++) {
      await move("price_plus");
      expect((await wallet())!.period_cap_usd).toBeCloseTo(26, 1);
      await move("price_pro");
      expect((await wallet())!.period_cap_usd).toBeCloseTo(40, 1);
    }
    expect(walletRoom((await wallet())!)).toBe(0);
  });

  test("a new subscription after the old one ended gets the whole allowance", async () => {
    const { t, user, wallet, stripe } = await plusNearRenewal();
    stripe.put(subscription(user, "canceled", "price_plus"));
    await deliver(t, "customer.subscription.deleted", subscription(user, "canceled", "price_plus"));
    stripe.put(subscription(user, "active", "price_pro", "sub_2"));
    await deliver(t, "checkout.session.completed", checkoutSubscription(user, { id: "cs_2", subscription: "sub_2" }));
    expect(await wallet()).toMatchObject({ plan: "pro", period_cap_usd: 40 });
  });
});

describe("a failing renewal (past_due)", () => {
  test("rolls into the next period on the free allowance, and the paid allowance returns when the payment lands", async () => {
    const stripe = fakeStripe();
    const { t, user, wallet, patchWallet } = await setup();
    stripe.put(subscription(user, "active", "price_plus"));
    await deliver(t, "checkout.session.completed", checkoutSubscription(user));
    stripe.put(subscription(user, "past_due", "price_plus"));
    await deliver(t, "customer.subscription.updated", subscription(user, "past_due", "price_plus"));

    // The period ends while the card is still failing.
    const w = (await wallet())!;
    const next = rolledOver(w, w.period_end + 1000)!;
    expect(next.period_cap_usd).toBe(2);
    const summary = await t.run((ctx) => walletSummary(ctx, user, w.period_end + 1000));
    expect(summary).toMatchObject({ plan: "plus", cap_usd: 2 });

    // Rolled over (as the next turn would), then the retry succeeds.
    await patchWallet(next);
    stripe.put(subscription(user, "active", "price_plus"));
    await deliver(t, "customer.subscription.updated", subscription(user, "active", "price_plus"));
    expect(await wallet()).toMatchObject({ plan: "plus", subscription_status: "active", period_cap_usd: 12 });
  });
});

describe("a fresh paid period follows the same allowance rule as a rollover", () => {
  test("invoice.paid opening a period while past_due grants the free allowance until the subscription is active", async () => {
    const stripe = fakeStripe();
    const { t, user, wallet } = await setup();
    stripe.put(subscription(user, "active", "price_plus"));
    await deliver(t, "checkout.session.completed", checkoutSubscription(user));
    stripe.put(subscription(user, "past_due", "price_plus"));
    await deliver(t, "customer.subscription.updated", subscription(user, "past_due", "price_plus"));

    // Stripe's renewal period starts after the wallet's own one did.
    const start = Math.ceil(((await wallet())!.period_start + 1000) / 1000) * 1000;
    const end = addMonths(start, 1);
    expect(await outcomeOf(deliver(t, "invoice.paid", {
      id: "in_2", object: "invoice", customer: "cus_1", billing_reason: "subscription_cycle", subscription: "sub_1",
      lines: { data: [{ period: { start: Math.floor(start / 1000), end: Math.floor(end / 1000) } }] },
    }))).toBe("period");
    expect(await wallet()).toMatchObject({ plan: "plus", period_cost_usd: 0, period_cap_usd: 2 });

    stripe.put(subscription(user, "active", "price_plus"));
    await deliver(t, "customer.subscription.updated", subscription(user, "active", "price_plus"));
    expect((await wallet())!.period_cap_usd).toBe(12);
  });
});

describe("top-ups", () => {
  test("a paid top-up credits its catalog value once, from the amount before tax, and keeps the customer", async () => {
    fakeStripe();
    const { t, user, wallet, ledger } = await setup();
    expect(await outcomeOf(deliver(t, "checkout.session.completed", topupSession(user)))).toBe("topup");
    expect(await outcomeOf(deliver(t, "checkout.session.completed", topupSession(user)))).toBe("ignored:repeat");
    // $10.00 paid before tax buys $6.00 of usage (TOPUP.usage_usd_per_usd).
    expect(await wallet()).toMatchObject({ topup_usd: 6, plan: "free", period_cap_usd: 2, stripe_customer_id: "cus_7" });
    expect((await ledger()).filter((row) => row.kind === "topup")).toMatchObject([{ amount_usd: 6, external_id: "pi_1" }]);
  });

  test("a delayed payment credits when async_payment_succeeded arrives, not before", async () => {
    fakeStripe();
    const { t, user, wallet } = await setup();
    expect(await outcomeOf(deliver(t, "checkout.session.completed", topupSession(user, { payment_status: "unpaid" })))).toBe("ignored:unpaid");
    expect(await wallet()).toBeNull();
    expect(await outcomeOf(deliver(t, "checkout.session.async_payment_succeeded", topupSession(user)))).toBe("topup");
    expect((await wallet())!.topup_usd).toBe(6);
  });

  test("a refund takes back the same share of the credit, once per refunded total", async () => {
    fakeStripe();
    const { t, user, wallet, ledger } = await setup();
    await deliver(t, "checkout.session.completed", topupSession(user));
    const charge = (refunded: number) => ({ id: "ch_1", object: "charge", payment_intent: "pi_1", amount: 1080, amount_refunded: refunded, currency: "usd" });
    expect(await outcomeOf(deliver(t, "charge.refunded", charge(540)))).toBe("refund");
    expect((await wallet())!.topup_usd).toBe(3);
    expect(await outcomeOf(deliver(t, "charge.refunded", charge(540)))).toBe("ignored:repeat");
    expect((await wallet())!.topup_usd).toBe(3);
    expect(await outcomeOf(deliver(t, "charge.refunded", charge(1080)))).toBe("refund");
    expect((await wallet())!.topup_usd).toBe(0);
    expect((await ledger()).filter((row) => row.kind === "refund").map((row) => row.amount_usd)).toEqual([3, 3]);
  });

  test("a chargeback on credit already spent leaves a debt the allowance pays once, then it is gone", async () => {
    fakeStripe();
    const { t, user, wallet, ledger, patchWallet } = await setup();
    await deliver(t, "checkout.session.completed", topupSession(user));
    // $6 of credit, $5 of it spent; none of the free allowance ($2) used yet.
    await patchWallet({ topup_usd: 1 });
    expect(await outcomeOf(deliver(t, "charge.dispute.created", { id: "dp_1", payment_intent: "pi_1", amount: 1080 }))).toBe("refund");
    // The allowance left now pays $2 of the $5 at once.
    let w = (await wallet())!;
    expect([w.period_cost_usd, w.topup_usd, walletRoom(w)]).toEqual([2, -3, 0]);
    expect((await ledger()).filter((row) => row.kind === "refund").map((row) => row.amount_usd)).toEqual([6]);

    // Each new period's allowance pays what is still owed first, then gives room.
    const rollTo = async (at: number) => {
      await t.run((ctx) => ensureWallet(ctx, user, at));
      return (await wallet())!;
    };
    w = await rollTo(w.period_end + 1000);
    expect([w.period_cost_usd, w.topup_usd, walletRoom(w)]).toEqual([2, -1, 0]);
    w = await rollTo(w.period_end + 1000);
    expect([w.period_cost_usd, w.topup_usd, walletRoom(w)]).toEqual([1, 0, 1]);
    // Paid off: the period after is the whole allowance.
    w = await rollTo(w.period_end + 1000);
    expect([w.period_cost_usd, w.topup_usd, walletRoom(w)]).toEqual([0, 0, 2]);
    expect((await ledger()).filter((row) => row.kind === "repay").map((row) => row.amount_usd).sort()).toEqual([1, 2, 2]);
  });

  test("the plan screen's clock rollover pays the debt the way the write does", async () => {
    fakeStripe();
    const { t, user, wallet, patchWallet } = await setup();
    await deliver(t, "checkout.session.completed", topupSession(user));
    await patchWallet({ topup_usd: -3, period_cost_usd: 2 });
    const w = (await wallet())!;
    const later = await t.run((ctx) => walletSummary(ctx, user, w.period_end + 1000));
    expect([later.used_usd, later.topup_usd, later.remaining_usd]).toEqual([2, -1, 0]);
  });

  test("a later top-up pays the debt first", async () => {
    fakeStripe();
    const { t, user, wallet, patchWallet } = await setup();
    await deliver(t, "checkout.session.completed", topupSession(user));
    await patchWallet({ topup_usd: -5, period_cost_usd: 2 });
    await deliver(t, "checkout.session.completed", topupSession(user, { id: "cs_top_2", payment_intent: "pi_2" }));
    expect((await wallet())!.topup_usd).toBe(1);
  });

  test("a dispute takes back what is left of the credit; a charge that bought neither a top-up nor a plan is ignored", async () => {
    fakeStripe();
    const { t, user, wallet } = await setup();
    await deliver(t, "checkout.session.completed", topupSession(user));
    await deliver(t, "charge.refunded", { id: "ch_1", payment_intent: "pi_1", amount: 1080, amount_refunded: 270 });
    expect((await wallet())!.topup_usd).toBe(4.5);
    expect(await outcomeOf(deliver(t, "charge.dispute.created", { id: "dp_1", payment_intent: "pi_1", amount: 810 }))).toBe("refund");
    expect((await wallet())!.topup_usd).toBe(0);
    expect(await outcomeOf(deliver(t, "charge.dispute.created", { id: "dp_1", payment_intent: "pi_1", amount: 810 }))).toBe("ignored:repeat");
    expect(await outcomeOf(deliver(t, "charge.refunded", { id: "ch_9", payment_intent: "pi_plan", amount: 2000, amount_refunded: 2000 }))).toBe("ignored:not_a_plan");
  });
});

describe("billing periods", () => {
  test("invoice.paid puts the wallet on Stripe's period, resets usage once, and later periods follow it", async () => {
    const stripe = fakeStripe();
    const { t, user, wallet, ledger, patchWallet } = await setup();
    stripe.put(subscription(user, "active", "price_plus"));
    await deliver(t, "checkout.session.completed", checkoutSubscription(user));
    // A wallet on the free plan for ten days, with usage, subscribes two days ago.
    await patchWallet({ period_cost_usd: 1.5, period_start: Date.now() - 10 * DAY });

    const startSec = Math.floor((Date.now() - 2 * DAY) / 1000);
    const start = startSec * 1000;
    const end = addMonths(start, 1);
    const invoice = (reason: string) => ({
      id: "in_1", object: "invoice", customer: "cus_1", billing_reason: reason, status: "paid",
      parent: { subscription_details: { subscription: "sub_1", metadata: { user_id: user } } },
      lines: { data: [{ period: { start: startSec, end: end / 1000 } }] },
    });

    expect(await outcomeOf(deliver(t, "invoice.paid", invoice("subscription_update")))).toBe("ignored:not_a_period");
    expect(await outcomeOf(deliver(t, "invoice.paid", invoice("subscription_create")))).toBe("period");
    expect(await wallet()).toMatchObject({ period_start: start, period_end: end, period_anchor: start, period_cost_usd: 0, period_cap_usd: 12 });
    expect((await ledger()).filter((row) => row.kind === "period_reset").map((row) => row.amount_usd)).toEqual([1.5]);

    // Redelivered: nothing moves.
    expect(await outcomeOf(deliver(t, "invoice.paid", invoice("subscription_create")))).toBe("ignored:period_unchanged");
    expect((await ledger()).filter((row) => row.kind === "period_reset")).toHaveLength(1);

    // The wallet's own rollover after the period lands on Stripe's next boundary.
    const later = end + 3_600_000;
    expect(periodAt(start, later)).toEqual({ start: end, end: addMonths(start, 2) });
    const summary = await t.run((ctx) => walletSummary(ctx, user, later));
    expect(summary).toMatchObject({ period_anchor: start, period_start: end, period_end: addMonths(start, 2), used_usd: 0 });
  });

  test("an invoice for a period already over is ignored", async () => {
    const stripe = fakeStripe();
    const { t, user, wallet } = await setup();
    stripe.put(subscription(user, "active", "price_plus"));
    await deliver(t, "checkout.session.completed", checkoutSubscription(user));
    const before = (await wallet())!;
    const old = Math.floor((Date.now() - 60 * DAY) / 1000);
    const outcome = await outcomeOf(deliver(t, "invoice.paid", {
      id: "in_old", object: "invoice", customer: "cus_1", billing_reason: "subscription_cycle", subscription: "sub_1",
      lines: { data: [{ period: { start: old, end: old + 30 * 86_400 } }] },
    }));
    expect(outcome).toBe("ignored:period_unchanged");
    expect((await wallet())!.period_start).toBe(before.period_start);
  });
});
