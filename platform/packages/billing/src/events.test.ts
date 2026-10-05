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
  unitPriceProblem,
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
  const products = [{ product: "prod_plus", prices: ["price_plus"] }, { product: "prod_pro", prices: ["price_pro"] }];
  const safeUpdate = {
    enabled: true,
    proration_behavior: "always_invoice",
    schedule_at_period_end: { conditions: [{ type: "decreasing_item_amount" }] },
    products,
  };
  const safeCancel = { enabled: true, mode: "at_period_end", proration_behavior: "none" };
  const config = (update: Record<string, unknown> | undefined, opts: { active?: boolean; cancel?: Record<string, unknown> } = {}) => ({
    id: "bpc_1",
    active: opts.active ?? true,
    features: { subscription_update: update as any, subscription_cancel: (opts.cancel ?? safeCancel) as any },
  });
  const prices = ["price_plus", "price_pro"];

  test("safe: upgrades invoiced at once, downgrades and cancels at the period's end, every price offered", () => {
    expect(portalConfigurationProblem(config(safeUpdate), prices)).toBeNull();
    expect(portalConfigurationProblem(config(safeUpdate, { cancel: { enabled: false, mode: "immediately" } }), prices)).toBeNull();
    expect(portalConfigurationProblem(config({ ...safeUpdate, billing_cycle_anchor: "unchanged" }), prices)).toBeNull();
  });

  test("Stripe's default proration, or none, leaves an upgrade unpaid until renewal", () => {
    expect(portalConfigurationProblem(config({ ...safeUpdate, proration_behavior: "create_prorations" }), prices)).toContain("create_prorations");
    expect(portalConfigurationProblem(config({ ...safeUpdate, proration_behavior: undefined }), prices)).toContain("(default)");
  });

  test("an immediate cancel is refused, with or without prorations", () => {
    for (const proration_behavior of ["create_prorations", "always_invoice", "none"]) {
      expect(portalConfigurationProblem(config(safeUpdate, { cancel: { enabled: true, mode: "immediately", proration_behavior } }), prices)).toContain("not at_period_end");
    }
  });

  test("a downgrade applied at once, or a change that restarts the cycle, is refused", () => {
    expect(portalConfigurationProblem(config({ ...safeUpdate, schedule_at_period_end: null }), prices)).toContain("downgrade");
    expect(portalConfigurationProblem(config({ ...safeUpdate, schedule_at_period_end: { conditions: [{ type: "shortening_interval" }] } }), prices)).toContain("downgrade");
    expect(portalConfigurationProblem(config({ ...safeUpdate, billing_cycle_anchor: "now" }), prices)).toContain("billing_cycle_anchor");
  });

  test("a missing price, plan changes off, or an inactive configuration is named", () => {
    expect(portalConfigurationProblem(config({ ...safeUpdate, products: products.slice(0, 1) }), prices)).toBe("does not offer price_pro");
    expect(portalConfigurationProblem(config({ ...safeUpdate, products: undefined }), prices)).toBe("does not offer price_plus, price_pro");
    expect(portalConfigurationProblem(config({ enabled: false }), ["price_plus"])).toBe("does not allow plan changes");
    expect(portalConfigurationProblem(config({ enabled: false }), [])).toBeNull();
    expect(portalConfigurationProblem(config(safeUpdate, { active: false }), [])).toBe("is not active");
  });
});

describe("unitPriceProblem", () => {
  const dollar = { id: "price_1", active: true, unit_amount: 100, currency: "usd", recurring: null };
  test("a one-off $1.00 USD price is the unit", () => {
    expect(unitPriceProblem(dollar, 100)).toBeNull();
    expect(unitPriceProblem({ ...dollar, currency: "USD" }, 100)).toBeNull();
  });
  test("another amount, currency, a recurring or an inactive price is named", () => {
    expect(unitPriceProblem({ ...dollar, unit_amount: 1000 }, 100)).toBe("costs 1000 a unit, not 100");
    expect(unitPriceProblem({ ...dollar, currency: "eur" }, 100)).toBe("is in eur, not usd");
    expect(unitPriceProblem({ ...dollar, recurring: { interval: "month", interval_count: 1 } }, 100)).toBe("is recurring, not one-off");
    expect(unitPriceProblem({ ...dollar, active: false }, 100)).toBe("is not active");
  });
});
