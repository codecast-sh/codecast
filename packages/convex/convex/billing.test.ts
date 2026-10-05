// Billing under convex-test (plan pl-840, docs/architecture/hosted-assistant.md
// "Verification"): the Stripe webhook refuses a tampered or stale delivery,
// each event lands on the wallet once and in any order Stripe sends it, and
// the checkout and portal actions call Stripe through a fake fetch. With no
// keys nothing throws and billingAvailable says so.
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { convexTest } from "convex-test";
import { httpRouter } from "convex/server";
import { signWebhook } from "@platform/billing";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { STRIPE_WEBHOOK_PATH, stripeWebhook } from "./billing";
import { addMonths } from "./lib/wallet";

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
};
const ENV_NAMES = Object.keys(ENV) as (keyof typeof ENV)[];

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

type StripeCall = { url: string; method: string; form: Record<string, string> };

/** Stands in for api.stripe.com: records each call and answers from `respond`. */
function fakeStripe(respond: (call: StripeCall) => { status?: number; body: unknown } = (call) => ({
  body: { id: call.url.includes("billing_portal") ? "bps_1" : "cs_1", url: call.url.includes("billing_portal") ? "https://billing.stripe.test/p" : "https://checkout.stripe.test/c" },
})): StripeCall[] {
  const calls: StripeCall[] = [];
  globalThis.fetch = (async (url: string, init: { method: string; body?: string }) => {
    const call = { url: String(url), method: init.method, form: Object.fromEntries(new URLSearchParams(init.body ?? "")) };
    calls.push(call);
    const { status = 200, body } = respond(call);
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return calls;
}

async function setup() {
  const t = convexTest(schema, modules);
  const user = await t.run((ctx) => ctx.db.insert("users", { email: "dana@example.test" }));
  const wallet = () => t.run(async (ctx) => ctx.db.query("wallets").withIndex("by_user", (q) => q.eq("user_id", user)).first());
  const ledger = () => t.run((ctx) => ctx.db.query("wallet_ledger").withIndex("by_user_at", (q) => q.eq("user_id", user)).collect());
  return { t, user, wallet, ledger, authed: t.withIdentity({ subject: user }) };
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

const checkoutSubscription = (user: Id<"users">, plan = "plus", extra: Record<string, unknown> = {}) => ({
  id: "cs_sub_1", object: "checkout.session", mode: "subscription", status: "complete", payment_status: "paid",
  client_reference_id: user, customer: "cus_1", subscription: "sub_1",
  metadata: { user_id: user, kind: "plan", plan }, ...extra,
});

const subscription = (user: Id<"users">, status: string, price: string, id = "sub_1") => ({
  id, object: "subscription", customer: "cus_1", status, metadata: { user_id: user },
  items: { data: [{ id: "si_1", price: { id: price } }] },
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

  test("both secrets: the priced plans and the top-up", async () => {
    delete process.env.STRIPE_PRICE_PRO;
    const { t } = await setup();
    expect(await t.query(api.billing.billingAvailable, {})).toEqual({ available: true, plans: ["plus"], topup: true });
  });
});

describe("startCheckout and openPortal", () => {
  test("no keys: unavailable, and Stripe is never called", async () => {
    clearEnv();
    const calls = fakeStripe();
    const { authed } = await setup();
    expect(await authed.action(api.billing.startCheckout, { plan: "plus" })).toMatchObject({ ok: false, code: "unavailable" });
    expect(await authed.action(api.billing.openPortal, {})).toMatchObject({ ok: false, code: "unavailable" });
    expect(calls).toHaveLength(0);
  });

  test("signed out, or asking for both or neither, is refused", async () => {
    const calls = fakeStripe();
    const { t, authed } = await setup();
    expect(await t.action(api.billing.startCheckout, { plan: "plus" })).toMatchObject({ ok: false, code: "signed_out" });
    expect(await authed.action(api.billing.startCheckout, { plan: "plus", topup: true })).toMatchObject({ ok: false, code: "bad_request" });
    expect(await authed.action(api.billing.startCheckout, {})).toMatchObject({ ok: false, code: "bad_request" });
    expect(calls).toHaveLength(0);
  });

  test("a plan checkout sends the plan's price, the person and where to come back", async () => {
    const calls = fakeStripe();
    const { user, authed } = await setup();
    expect(await authed.action(api.billing.startCheckout, { plan: "pro" })).toEqual({ ok: true, url: "https://checkout.stripe.test/c", via: "checkout" });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.stripe.com/v1/checkout/sessions");
    expect(calls[0].form).toMatchObject({
      mode: "subscription",
      "line_items[0][price]": "price_pro",
      client_reference_id: user,
      customer_email: "dana@example.test",
      "metadata[plan]": "pro",
      "subscription_data[metadata][user_id]": user,
    });
    expect(calls[0].form.success_url).toEndWith("/simple/plan?billing=done");
    expect(calls[0].form.cancel_url).toEndWith("/simple/plan?billing=canceled");
  });

  test("a top-up is a one-off payment that reuses the customer on file", async () => {
    const calls = fakeStripe();
    const { t, user, authed } = await setup();
    await t.mutation(internal.wallet.setPlan, { user_id: user, plan: "free", stripe_customer_id: "cus_9" });
    expect(await authed.action(api.billing.startCheckout, { topup: true })).toMatchObject({ ok: true, via: "checkout" });
    expect(calls[0].form).toMatchObject({ mode: "payment", "line_items[0][price]": "price_topup", customer: "cus_9", "metadata[kind]": "topup" });
    expect(calls[0].form.customer_email).toBeUndefined();
  });

  test("someone already subscribed who asks for a plan gets the portal, not a second subscription", async () => {
    const calls = fakeStripe();
    const { t, user, authed } = await setup();
    await t.mutation(internal.wallet.setPlan, { user_id: user, plan: "plus", stripe_customer_id: "cus_1", stripe_subscription_id: "sub_1", subscription_status: "active" });
    expect(await authed.action(api.billing.startCheckout, { plan: "pro" })).toEqual({ ok: true, url: "https://billing.stripe.test/p", via: "portal" });
    expect(calls.map((call) => call.url)).toEqual(["https://api.stripe.com/v1/billing_portal/sessions"]);
    expect(calls[0].form).toMatchObject({ customer: "cus_1" });
  });

  test("the portal needs a customer", async () => {
    const calls = fakeStripe();
    const { t, user, authed } = await setup();
    expect(await authed.action(api.billing.openPortal, {})).toMatchObject({ ok: false, code: "no_customer" });
    await t.mutation(internal.wallet.setPlan, { user_id: user, plan: "free", stripe_customer_id: "cus_1" });
    expect(await authed.action(api.billing.openPortal, {})).toEqual({ ok: true, url: "https://billing.stripe.test/p", via: "portal" });
    expect(calls).toHaveLength(1);
  });

  test("a Stripe refusal comes back as a value, not a throw", async () => {
    fakeStripe(() => ({ status: 400, body: { error: { type: "invalid_request_error", message: "No such price: 'price_plus'" } } }));
    const { authed } = await setup();
    expect(await authed.action(api.billing.startCheckout, { plan: "plus" })).toMatchObject({ ok: false, code: "stripe_error" });
  });
});

describe("webhook signature", () => {
  test("a valid signature is applied", async () => {
    const { t, user, wallet } = await setup();
    expect(await deliver(t, "checkout.session.completed", checkoutSubscription(user))).toEqual({ status: 200, body: { received: true, outcome: "plan:plus" } } as any);
    expect((await wallet())!.plan).toBe("plus");
  });

  test("a tampered body is refused and changes nothing", async () => {
    const { t, user, wallet } = await setup();
    const result = await deliver(t, "checkout.session.completed", checkoutSubscription(user), { body: (payload) => payload.replace('"plus"', '"pro"') });
    expect(result).toEqual({ status: 400, body: { error: "bad_signature" } });
    expect(await wallet()).toBeNull();
  });

  test("a stale delivery is refused even though it is signed", async () => {
    const { t, user, wallet } = await setup();
    const result = await deliver(t, "checkout.session.completed", checkoutSubscription(user), {
      header: (payload) => signWebhook(payload, SECRET, Math.floor(Date.now() / 1000) - 3600),
    });
    expect(result).toEqual({ status: 400, body: { error: "stale" } });
    expect(await wallet()).toBeNull();
  });

  test("a delivery signed with another secret is refused", async () => {
    const { t, user } = await setup();
    const result = await deliver(t, "checkout.session.completed", checkoutSubscription(user), { header: (payload) => signWebhook(payload, "whsec_other") });
    expect(result.status).toBe(400);
  });

  test("no webhook secret: refused without throwing, so Stripe retries once it is set", async () => {
    delete process.env.STRIPE_WEBHOOK_SECRET;
    const { t, user } = await setup();
    expect((await deliver(t, "checkout.session.completed", checkoutSubscription(user))).status).toBe(503);
  });

  test("an event type billing does not map is acknowledged and ignored", async () => {
    const { t } = await setup();
    expect(await deliver(t, "customer.created", { id: "cus_1" })).toEqual({ status: 200, body: { received: true, outcome: "ignored:type" } } as any);
  });
});

describe("event mapping", () => {
  test("checkout.session.completed for a plan sets the plan, cap and Stripe ids", async () => {
    const { t, user, wallet } = await setup();
    await deliver(t, "checkout.session.completed", checkoutSubscription(user));
    expect(await wallet()).toMatchObject({
      plan: "plus", period_cap_usd: 12, stripe_customer_id: "cus_1", stripe_subscription_id: "sub_1", subscription_status: "active",
    });
  });

  test("a subscription event that landed first keeps its status over the checkout's", async () => {
    const { t, user, wallet } = await setup();
    expect((await deliver(t, "customer.subscription.created", subscription(user, "trialing", "price_plus"))).body.outcome).toBe("plan:plus");
    await deliver(t, "checkout.session.completed", checkoutSubscription(user));
    expect(await wallet()).toMatchObject({ plan: "plus", subscription_status: "trialing" });
  });

  test("customer.subscription.updated moves the plan with the price and the status", async () => {
    const { t, user, wallet } = await setup();
    await deliver(t, "checkout.session.completed", checkoutSubscription(user));
    expect((await deliver(t, "customer.subscription.updated", subscription(user, "active", "price_pro"))).body.outcome).toBe("plan:pro");
    expect(await wallet()).toMatchObject({ plan: "pro", period_cap_usd: 40 });
    // While Stripe retries a failed card the plan stays.
    await deliver(t, "customer.subscription.updated", subscription(user, "past_due", "price_pro"));
    expect(await wallet()).toMatchObject({ plan: "pro", subscription_status: "past_due" });
    // Out of retries: back to free.
    expect((await deliver(t, "customer.subscription.updated", subscription(user, "unpaid", "price_pro"))).body.outcome).toBe("plan:free");
    expect(await wallet()).toMatchObject({ plan: "free", period_cap_usd: 2, subscription_status: "unpaid" });
  });

  test("an unknown price leaves the plan alone", async () => {
    const { t, user, wallet } = await setup();
    await deliver(t, "checkout.session.completed", checkoutSubscription(user));
    expect((await deliver(t, "customer.subscription.updated", subscription(user, "active", "price_someone_else"))).body.outcome).toBe("ignored:unknown_price");
    expect((await wallet())!.plan).toBe("plus");
  });

  test("customer.subscription.deleted returns the person to free, and a late update cannot undo it", async () => {
    const { t, user, wallet } = await setup();
    await deliver(t, "checkout.session.completed", checkoutSubscription(user));
    expect((await deliver(t, "customer.subscription.deleted", subscription(user, "canceled", "price_plus"))).body.outcome).toBe("plan:free");
    expect(await wallet()).toMatchObject({ plan: "free", period_cap_usd: 2, subscription_status: "canceled" });
    expect((await deliver(t, "customer.subscription.updated", subscription(user, "active", "price_plus"))).body.outcome).toBe("ignored:canceled");
    expect((await wallet())!.plan).toBe("free");
  });

  test("a late delete of an old subscription does not cancel the new one", async () => {
    const { t, user, wallet } = await setup();
    await deliver(t, "checkout.session.completed", checkoutSubscription(user, "pro", { id: "cs_2", subscription: "sub_2" }));
    expect((await deliver(t, "customer.subscription.deleted", subscription(user, "canceled", "price_plus", "sub_1"))).body.outcome).toBe("ignored:other_subscription");
    expect(await wallet()).toMatchObject({ plan: "pro", stripe_subscription_id: "sub_2", subscription_status: "active" });
  });

  test("a paid top-up credits the balance once and keeps the customer", async () => {
    const { t, user, wallet, ledger } = await setup();
    const session = {
      id: "cs_top_1", object: "checkout.session", mode: "payment", status: "complete", payment_status: "paid",
      client_reference_id: user, customer: "cus_7", payment_intent: "pi_1", amount_subtotal: 1000, amount_total: 1080, currency: "usd",
      metadata: { user_id: user, kind: "topup" },
    };
    expect((await deliver(t, "checkout.session.completed", session)).body.outcome).toBe("topup");
    expect((await deliver(t, "checkout.session.completed", session)).body.outcome).toBe("ignored:repeat");
    expect(await wallet()).toMatchObject({ topup_usd: 10, plan: "free", stripe_customer_id: "cus_7" });
    expect((await ledger()).filter((row) => row.kind === "topup")).toMatchObject([{ amount_usd: 10, external_id: "pi_1" }]);
  });

  test("an unpaid checkout grants nothing", async () => {
    const { t, user, wallet } = await setup();
    expect((await deliver(t, "checkout.session.completed", checkoutSubscription(user, "plus", { payment_status: "unpaid" }))).body.outcome).toBe("ignored:unpaid");
    expect(await wallet()).toBeNull();
  });

  test("invoice.paid puts the wallet on Stripe's period, resets usage once, and later periods follow it", async () => {
    const { t, user, wallet, ledger } = await setup();
    await deliver(t, "checkout.session.completed", checkoutSubscription(user));
    const w = (await wallet())!;
    // A wallet on the free plan for ten days, with usage, subscribes two days ago.
    await t.run((ctx) => ctx.db.patch(w._id, { period_cost_usd: 1.5, period_start: Date.now() - 10 * 86_400_000 }));

    const startSec = Math.floor((Date.now() - 2 * 86_400_000) / 1000);
    const start = startSec * 1000;
    const end = addMonths(start, 1);
    const invoice = (reason: string) => ({
      id: "in_1", object: "invoice", customer: "cus_1", billing_reason: reason, status: "paid",
      parent: { subscription_details: { subscription: "sub_1", metadata: { user_id: user } } },
      lines: { data: [{ period: { start: startSec, end: end / 1000 } }] },
    });

    expect((await deliver(t, "invoice.paid", invoice("subscription_update"))).body.outcome).toBe("ignored:not_a_period");
    expect((await deliver(t, "invoice.paid", invoice("subscription_create"))).body.outcome).toBe("period");
    expect(await wallet()).toMatchObject({ period_start: start, period_end: end, period_anchor: start, period_cost_usd: 0, period_cap_usd: 12 });
    expect((await ledger()).filter((row) => row.kind === "period_reset").map((row) => row.amount_usd)).toEqual([1.5]);

    // Redelivered: nothing moves.
    expect((await deliver(t, "invoice.paid", invoice("subscription_create"))).body.outcome).toBe("ignored:period_unchanged");
    expect((await ledger()).filter((row) => row.kind === "period_reset")).toHaveLength(1);

    // The wallet's own rollover after the period lands on Stripe's next boundary.
    const later = end + 3_600_000;
    const { periodAt } = await import("./lib/wallet");
    expect(periodAt(start, later)).toEqual({ start: end, end: addMonths(start, 2) });
    const summary = await t.run(async (ctx) => (await import("./lib/wallet")).walletSummary(ctx, user, later));
    expect(summary).toMatchObject({ created_at: start, period_start: end, period_end: addMonths(start, 2), used_usd: 0 });
  });

  test("an invoice for a period already over is ignored", async () => {
    const { t, user, wallet } = await setup();
    await deliver(t, "checkout.session.completed", checkoutSubscription(user));
    const before = (await wallet())!;
    const old = Math.floor((Date.now() - 60 * 86_400_000) / 1000);
    const outcome = await deliver(t, "invoice.paid", {
      id: "in_old", object: "invoice", customer: "cus_1", billing_reason: "subscription_cycle", subscription: "sub_1",
      lines: { data: [{ period: { start: old, end: old + 30 * 86_400 } }] },
    });
    expect(outcome.body.outcome).toBe("ignored:period_unchanged");
    expect((await wallet())!.period_start).toBe(before.period_start);
  });
});
