// The plan screen's door to billing (convex/billing.ts, the billing piece of
// pl-840). Billing is env-gated: with no Stripe keys `billingAvailable`
// answers `available: false` and plans are granted by hand, so the screen
// says so instead of offering a button that can only fail. A query that
// errors reads as unavailable too.
import { useState } from "react";
import { useAction } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import type { BillingStatus } from "@codecast/convex/convex/billing";
import type { PlanId } from "@codecast/shared/contracts/assistant";
import { useQueryNoThrow } from "../../hooks/useQueryNoThrow";

/** A plan to subscribe to, or a top-up in one of `TOPUP.amounts_usd`. Where
 *  Stripe sends the person back is the server's (BILLING_RETURN_PATH, this
 *  lane's plan page). */
export type CheckoutRequest = { plan: PlanId } | { topup_usd: number };

const DIDNT_OPEN = "Checkout didn't open. Try again in a moment.";
const NOTHING_OFFERED: BillingStatus = { available: false, plans: [], topup: false };

export function useBilling(): BillingStatus & {
  busy: boolean;
  error: string | null;
  checkout: (req: CheckoutRequest) => Promise<void>;
} {
  const status = useQueryNoThrow(api.billing.billingAvailable, {}).data ?? NOTHING_OFFERED;
  const startCheckout = useAction(api.billing.startCheckout);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const checkout = async (req: CheckoutRequest) => {
    setError(null);
    setBusy(true);
    try {
      // A plan change for someone already subscribed comes back as the
      // portal (`via: "portal"`); either way the page to open is `url`.
      const res = await startCheckout(req);
      if (res.ok) window.location.assign(res.url);
      else setError(res.error);
    } catch {
      setError(DIDNT_OPEN);
    } finally {
      setBusy(false);
    }
  };

  return { ...status, busy, error, checkout };
}
