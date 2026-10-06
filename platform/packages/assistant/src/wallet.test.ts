// The wallet arithmetic over a two-plan catalog: months that do not drift,
// room and charge splitting, debt repayment, proration, the allowance an
// unpaid period grants, and a summary read across its period's end.
import { describe, expect, test } from "bun:test";
import { addMonths, money, periodAt, proratedCap, repayDebt, splitCharge, walletRoom, walletRules, type WalletSummaryFigures } from "./wallet";
import type { PlanCatalog, PlanSpec } from "./plans";

type Id = "free" | "paid";
const plan = (id: Id, included_usd: number): PlanSpec<Id> => ({
  id, label: id, price_usd: included_usd * 2, included_usd, default_model: "m", strong_model: "m",
  routines: { max: null, min_interval_ms: null }, concurrent_turns: 1, turn_ceiling_usd: 1,
});
const CATALOG: PlanCatalog<Id> = { plans: { free: plan("free", 2), paid: plan("paid", 12) }, free: "free" };
const rules = walletRules(CATALOG);

describe("periods", () => {
  test("months count from the wallet's creation without drifting off the 31st", () => {
    const jan31 = Date.UTC(2026, 0, 31, 12);
    expect(new Date(addMonths(jan31, 1)).toISOString()).toBe("2026-02-28T12:00:00.000Z");
    expect(new Date(addMonths(jan31, 2)).toISOString()).toBe("2026-03-31T12:00:00.000Z");
    const p = periodAt(jan31, Date.UTC(2026, 2, 15));
    expect([new Date(p.start).toISOString(), new Date(p.end).toISOString()]).toEqual(["2026-02-28T12:00:00.000Z", "2026-03-31T12:00:00.000Z"]);
    expect(periodAt(jan31, jan31)).toEqual({ start: jan31, end: addMonths(jan31, 1) });
  });
});

describe("room and charges", () => {
  test("room is the allowance left plus top-up, less holds, never below zero", () => {
    expect(walletRoom({ period_cap_usd: 2, period_cost_usd: 1.8, period_reserved_usd: 0.1, topup_usd: 0.5 })).toBe(0.6);
    expect(walletRoom({ period_cap_usd: 2, period_cost_usd: 3, period_reserved_usd: 1, topup_usd: 0 })).toBe(0);
    expect(money(0.1 + 0.2)).toBe(0.3);
  });

  test("a charge spends the allowance, then the top-up, and an overrun lands on usage", () => {
    expect(splitCharge({ period_cap_usd: 2, period_cost_usd: 1.5, topup_usd: 1 }, 1)).toEqual({ periodUsd: 0.5, topupUsd: 0.5 });
    expect(splitCharge({ period_cap_usd: 2, period_cost_usd: 2, topup_usd: 0.25 }, 1)).toEqual({ periodUsd: 0.75, topupUsd: 0.25 });
  });

  test("a debt is paid once from the allowance left", () => {
    expect(repayDebt({ period_cap_usd: 2, period_cost_usd: 0.5, topup_usd: -3 })).toEqual({ period_cost_usd: 2, topup_usd: -1.5, repaid: 1.5 });
    expect(repayDebt({ period_cap_usd: 2, period_cost_usd: 0.5, topup_usd: 1 })).toEqual({ period_cost_usd: 0.5, topup_usd: 1, repaid: 0 });
  });

  test("a plan change counts for the share of the period left, floored at zero only", () => {
    const period = { period_start: 0, period_end: 100, period_cap_usd: 2, period_cost_usd: 1.9 };
    expect(proratedCap(period, 2, 12, 50)).toBe(7);
    expect(proratedCap({ ...period, period_cap_usd: 7 }, 12, 2, 50)).toBe(2);
    expect(proratedCap(period, 12, 2, 0)).toBe(0);
  });
});

describe("allowance", () => {
  test("a failing renewal and a period past the paid one grant the free allowance", () => {
    expect(rules.allowancePlan({ plan: "paid" }, 100)).toBe("paid");
    expect(rules.allowancePlan({ plan: "paid", subscription_status: "past_due" }, 100)).toBe("free");
    expect(rules.allowancePlan({ plan: "paid", paid_through: 50 }, 100)).toBe("free");
    expect(rules.allowanceUsd({ plan: "paid", paid_through: 100 }, 100)).toBe(12);
    expect(rules.allowanceUsd({}, 100)).toBe(2);
  });

  test("a fresh period resets usage, pays debt first, and carries the top-up", () => {
    expect(rules.freshPeriod({ plan: "paid" }, 10, 20, -3)).toEqual({ period_start: 10, period_end: 20, period_cap_usd: 12, period_cost_usd: 3, topup_usd: 0 });
    expect(rules.nextPeriod(0, { plan: "paid" }, 50, 1, 49)).toBeNull();
  });

  test("a summary held across its period's end reads as the next period", () => {
    const anchor = Date.UTC(2026, 0, 31, 12);
    const held: WalletSummaryFigures<Id> & { extra: string } = {
      plan: "free", cap_usd: 2, used_usd: 1.8, reserved_usd: 0.1, remaining_usd: 0.6, topup_usd: 0.5,
      period_anchor: anchor, period_start: anchor, period_end: addMonths(anchor, 1), subscription_status: null, paid_through: null, extra: "kept",
    };
    expect(rules.summaryAt(held, held.period_end! - 1)).toBe(held);
    expect(rules.summaryAt(held, held.period_end!)).toEqual({
      ...held, cap_usd: 2, used_usd: 0, topup_usd: 0.5, remaining_usd: 2.4, period_start: held.period_end, period_end: addMonths(anchor, 2),
    });
  });
});
