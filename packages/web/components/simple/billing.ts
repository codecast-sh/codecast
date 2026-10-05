// The plan screen's door to billing (convex/billing.ts, the billing piece of
// pl-840). Billing is env-gated: with no Stripe keys `billingAvailable`
// answers false and plans are granted by hand, so the screen says so instead
// of offering a button that can only fail. Until the billing module is
// deployed the query errors, which reads as unavailable too.
import { useState } from "react";
import { useAction } from "convex/react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import type { PlanId } from "@codecast/shared/contracts/assistant";
import { useQueryNoThrow } from "../../hooks/useQueryNoThrow";
import { LANE_PATHS } from "./lane";

const billing = (_api as any).billing;

export type CheckoutRequest = { plan: PlanId } | { topup_usd: number };

export function useBilling(): {
  available: boolean;
  busy: boolean;
  error: string | null;
  checkout: (req: CheckoutRequest) => Promise<void>;
} {
  const available = useQueryNoThrow(billing.billingAvailable, {}).data === true;
  const startCheckout = useAction(billing.startCheckout);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const checkout = async (req: CheckoutRequest) => {
    setError(null);
    setBusy(true);
    try {
      const res = (await startCheckout({ ...req, return_to: LANE_PATHS.plan })) as { ok?: boolean; url?: string; error?: string } | null;
      if (res?.url) window.location.assign(res.url);
      else setError(res?.error ?? "Checkout didn't open. Try again in a moment.");
    } catch {
      setError("Checkout didn't open. Try again in a moment.");
    } finally {
      setBusy(false);
    }
  };

  return { available, busy, error, checkout };
}
