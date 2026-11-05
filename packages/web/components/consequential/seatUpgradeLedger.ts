// The review before a team admin leaves for Stripe to start (or renew) Pro,
// billed per seat, monthly or yearly (convex/teamBilling.ts). The prices come
// from Stripe through `seatOffer`, so the figures say what Stripe will charge;
// until they arrive, or when they cannot be read, the confirm is held. The
// Billed pick shows only where a yearly price is on sale.
import type { SeatOffer, SeatPrice } from "@codecast/convex/convex/teamBilling";
import type { SwitchLedger } from "./ConsequentialSwitch";

function money(cents: number, currency: string): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
  }).format(cents / 100);
}

function per(price: SeatPrice): string {
  return price.interval_count === 1 ? `a ${price.interval}` : `every ${price.interval_count} ${price.interval}s`;
}

export type SeatBillingChoice = "monthly" | "annual";
export const BILLED_OPTIONS = { Monthly: "monthly", Yearly: "annual" } as const satisfies Record<string, SeatBillingChoice>;

export function seatUpgradeLedger(r: { team: string; seats: number; renew: boolean; offer: SeatOffer | undefined; billing: SeatBillingChoice }): SwitchLedger {
  const offer = r.offer?.ok ? r.offer : null;
  const price = offer ? (r.billing === "annual" && offer.annual) || offer.monthly : null;
  const seats = offer?.seats ?? Math.max(1, r.seats);
  const trial = offer?.trial_days ?? 0;
  return {
    name: r.renew ? "Renew Pro" : "Upgrade to Pro",
    subject: r.team,
    shift: ["Starter", "Pro"],
    figures: [
      { value: price ? money(price.unit_amount, price.currency) : "…", label: "per seat" },
      { value: String(seats), label: seats === 1 ? "seat now" : "seats now" },
      { value: price ? money(price.unit_amount * seats, price.currency) : "…", label: price ? per(price) : "total", tone: "warn" },
      ...(trial > 0 ? [{ value: String(trial), label: "days free" }] : []),
    ],
    rows: [
      ...(trial > 0 ? [{ k: "Trial", v: `${trial} days, then billed` }] : []),
      { k: "Seats", v: "One per member, kept in sync" },
      { k: "Changes", v: "Prorated" },
      { k: "Invites", v: "Free until joined", tone: "ok" as const },
      { k: "Pay on", v: "Stripe checkout" },
    ],
    stop: "Cancel in Billing",
    confirm: "Continue to Stripe",
    keep: "Not now",
    ...(offer?.annual ? { pick: { k: "Billed", options: Object.keys(BILLED_OPTIONS), value: r.billing === "annual" ? "Yearly" : "Monthly" } } : {}),
    ...(r.offer === undefined ? { blocked: "Loading price" } : !r.offer.ok ? { blocked: "Price unavailable" } : {}),
  };
}
