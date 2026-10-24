// The review before a team admin leaves for Stripe to start (or renew) Pro,
// billed per seat (convex/teamBilling.ts). The price comes from Stripe through
// `seatOffer`, so the figures say what Stripe will charge; until it arrives,
// or when it cannot be read, the confirm is held.
import type { SeatOffer } from "@codecast/convex/convex/teamBilling";
import type { SwitchLedger } from "./ConsequentialSwitch";

function money(cents: number, currency: string): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
  }).format(cents / 100);
}

function per(offer: Extract<SeatOffer, { ok: true }>): string {
  return offer.interval_count === 1 ? `a ${offer.interval}` : `every ${offer.interval_count} ${offer.interval}s`;
}

export function seatUpgradeLedger(r: { team: string; seats: number; renew: boolean; offer: SeatOffer | undefined }): SwitchLedger {
  const offer = r.offer?.ok ? r.offer : null;
  const seats = offer?.seats ?? Math.max(1, r.seats);
  const trial = offer?.trial_days ?? 0;
  return {
    name: r.renew ? "Renew Pro" : "Upgrade to Pro",
    subject: r.team,
    shift: ["Starter", "Pro"],
    figures: [
      { value: offer ? money(offer.unit_amount, offer.currency) : "…", label: "per seat" },
      { value: String(seats), label: seats === 1 ? "seat now" : "seats now" },
      { value: offer ? money(offer.unit_amount * seats, offer.currency) : "…", label: offer ? per(offer) : "total", tone: "warn" },
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
    ...(r.offer === undefined ? { blocked: "Loading price" } : !r.offer.ok ? { blocked: "Price unavailable" } : {}),
  };
}
