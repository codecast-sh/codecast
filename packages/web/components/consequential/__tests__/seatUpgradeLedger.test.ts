import { describe, expect, test } from "bun:test";
import { seatUpgradeLedger } from "../seatUpgradeLedger";
import { assertGlance } from "./glance";

const monthly = { unit_amount: 1200, currency: "usd", interval: "month", interval_count: 1 };
const annual = { unit_amount: 11520, currency: "usd", interval: "year", interval_count: 1 };
const offer = { ok: true as const, monthly, annual: null, trial_days: 14, seats: 3 };

describe("seatUpgradeLedger", () => {
  test("leads with Stripe's price per seat, the seats, the total and the trial", () => {
    const l = seatUpgradeLedger({ team: "Acme", seats: 3, renew: false, offer, billing: "monthly" });
    expect(l.name).toBe("Upgrade to Pro");
    expect(l.figures.map((f) => [f.value, f.label])).toEqual([["$12", "per seat"], ["3", "seats now"], ["$36", "a month"], ["14", "days free"]]);
    expect(l.rows.find((r) => r.k === "Trial")?.v).toBe("14 days, then billed");
    expect(l.blocked).toBeUndefined();
    expect(l.pick).toBeUndefined();
    expect(l.confirm).toBe("Continue to Stripe");
    assertGlance(l);
  });

  test("with a yearly price on sale, the Billed pick switches the figures to the year", () => {
    const withAnnual = { ...offer, annual };
    expect(seatUpgradeLedger({ team: "Acme", seats: 3, renew: false, offer: withAnnual, billing: "monthly" }).pick).toEqual({ k: "Billed", options: ["Monthly", "Yearly"], value: "Monthly" });
    const l = seatUpgradeLedger({ team: "Acme", seats: 3, renew: false, offer: withAnnual, billing: "annual" });
    expect(l.pick?.value).toBe("Yearly");
    expect(l.figures.map((f) => [f.value, f.label])).toEqual([["$115.20", "per seat"], ["3", "seats now"], ["$345.60", "a year"], ["14", "days free"]]);
    assertGlance(l);
  });

  test("holds the confirm until the price arrives, and when it cannot be read", () => {
    expect(seatUpgradeLedger({ team: "Acme", seats: 3, renew: false, offer: undefined, billing: "monthly" }).blocked).toBe("Loading price");
    expect(seatUpgradeLedger({ team: "Acme", seats: 3, renew: false, offer: { ok: false, error: "x" }, billing: "monthly" }).blocked).toBe("Price unavailable");
  });

  test("a renewal has no trial and says so in its name; cents show when the price has them", () => {
    const l = seatUpgradeLedger({ team: "Acme", seats: 5, renew: true, offer: { ...offer, monthly: { ...monthly, unit_amount: 1250 }, trial_days: 0, seats: 5 }, billing: "monthly" });
    expect(l.name).toBe("Renew Pro");
    expect(l.figures.map((f) => f.value)).toEqual(["$12.50", "5", "$62.50"]);
    expect(l.rows.some((r) => r.k === "Trial")).toBe(false);
    assertGlance(l);
  });
});
