import { describe, expect, test } from "bun:test";
import {
  invoiceOpensPeriod,
  invoicePaymentIntentId,
  invoicePeriod,
  invoiceSubscriptionId,
  invoiceSubscriptionMetadata,
  isLiveSubscription,
  portalConfigurationProblem,
  sessionAmountBeforeTax,
  stripeId,
  subscriptionPeriod,
  subscriptionPriceId,
} from "./events";

describe("accessors", () => {
  test("stripeId reads bare and expanded ids", () => {
    expect(stripeId("cus_1")).toBe("cus_1");
    expect(stripeId({ id: "cus_2" })).toBe("cus_2");
    expect(stripeId(null)).toBeNull();
  });

  test("subscription period and price from the item (basil) or the subscription (older)", () => {
    const basil = { id: "sub_1", status: "active", items: { data: [{ id: "si_1", price: { id: "price_plus" }, current_period_start: 100, current_period_end: 200 }] } };
    expect(subscriptionPeriod(basil)).toEqual({ start: 100_000, end: 200_000 });
    expect(subscriptionPriceId(basil)).toBe("price_plus");
    const older = { id: "sub_1", status: "active", current_period_start: 10, current_period_end: 20, items: { data: [{ id: "si_1" }] } };
    expect(subscriptionPeriod(older)).toEqual({ start: 10_000, end: 20_000 });
    expect(subscriptionPriceId(older)).toBeNull();
  });

  test("invoice subscription and metadata from either shape", () => {
    expect(invoiceSubscriptionId({ id: "in_1", parent: { subscription_details: { subscription: "sub_new", metadata: { user_id: "u1" } } } })).toBe("sub_new");
    expect(invoiceSubscriptionMetadata({ id: "in_1", parent: { subscription_details: { subscription: "sub_new", metadata: { user_id: "u1" } } } })).toEqual({ user_id: "u1" });
    expect(invoiceSubscriptionId({ id: "in_2", subscription: { id: "sub_old" }, subscription_details: { metadata: { user_id: "u2" } } })).toBe("sub_old");
    expect(invoiceSubscriptionMetadata({ id: "in_2", subscription_details: { metadata: { user_id: "u2" } } })).toEqual({ user_id: "u2" });
    expect(invoiceSubscriptionId({ id: "in_3" })).toBeNull();
  });

  test("invoicePeriod takes the line reaching furthest, earliest start on a tie", () => {
    expect(invoicePeriod({ id: "in", lines: { data: [
      { period: { start: 150, end: 200 } },
      { period: { start: 100, end: 200 } },
      { period: { start: 50, end: 100 } },
      { period: { start: 5, end: 5 } },
    ] } })).toEqual({ start: 100_000, end: 200_000 });
    expect(invoicePeriod({ id: "in", lines: { data: [] } })).toBeNull();
  });

  test("only create and cycle invoices open a period; live statuses keep the plan", () => {
    expect(invoiceOpensPeriod({ id: "a", billing_reason: "subscription_cycle" })).toBe(true);
    expect(invoiceOpensPeriod({ id: "b", billing_reason: "subscription_update" })).toBe(false);
    expect(["active", "trialing", "past_due"].every(isLiveSubscription)).toBe(true);
    expect(["canceled", "unpaid", "incomplete", "incomplete_expired", "paused", undefined].some(isLiveSubscription)).toBe(false);
  });
});

describe("sessionAmountBeforeTax", () => {
  test("takes the total after discounts, less tax", () => {
    expect(sessionAmountBeforeTax({ id: "cs", mode: "payment", amount_subtotal: 2000, amount_total: 1650, total_details: { amount_tax: 150, amount_discount: 500 } })).toBe(1500);
  });
  test("falls back to the subtotal when there is no total", () => {
    expect(sessionAmountBeforeTax({ id: "cs", mode: "payment", amount_subtotal: 1000 })).toBe(1000);
  });
});

describe("invoicePaymentIntentId", () => {
  test("prefers the paid payment of an expanded invoice, then the older field", () => {
    expect(invoicePaymentIntentId({ id: "in", payments: { data: [
      { status: "canceled", payment: { type: "payment_intent", payment_intent: "pi_old" } },
      { status: "paid", payment: { type: "payment_intent", payment_intent: { id: "pi_paid" } } },
    ] } })).toBe("pi_paid");
    expect(invoicePaymentIntentId({ id: "in", payment_intent: "pi_1" })).toBe("pi_1");
    expect(invoicePaymentIntentId({ id: "in" })).toBeNull();
  });
});

describe("portalConfigurationProblem", () => {
  const config = (update: Record<string, unknown> | undefined, active = true) => ({ id: "bpc_1", active, features: { subscription_update: update as any } });
  const products = [{ product: "prod_plus", prices: ["price_plus"] }, { product: "prod_pro", prices: ["price_pro"] }];

  test("safe when plan changes are invoiced at once and every price is offered", () => {
    expect(portalConfigurationProblem(config({ enabled: true, proration_behavior: "always_invoice", products }), ["price_plus", "price_pro"])).toBeNull();
  });

  test("Stripe's default proration, or none, leaves an upgrade unpaid until renewal", () => {
    expect(portalConfigurationProblem(config({ enabled: true, proration_behavior: "create_prorations", products }), ["price_plus"])).toContain("create_prorations");
    expect(portalConfigurationProblem(config({ enabled: true, products }), ["price_plus"])).toContain("(default)");
  });

  test("a missing price, plan changes off, or an inactive configuration is named", () => {
    expect(portalConfigurationProblem(config({ enabled: true, proration_behavior: "always_invoice", products: products.slice(0, 1) }), ["price_plus", "price_pro"])).toBe("does not offer price_pro");
    expect(portalConfigurationProblem(config({ enabled: false }), ["price_plus"])).toBe("does not allow plan changes");
    expect(portalConfigurationProblem(config({ enabled: false }), [])).toBeNull();
    expect(portalConfigurationProblem(config({ enabled: true, proration_behavior: "always_invoice", products }, false), [])).toBe("is not active");
  });
});
