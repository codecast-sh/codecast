// The plan screen's door to billing (convex/billing.ts, the billing piece of
// pl-840). Billing is env-gated: with no Stripe keys `billingAvailable`
// answers `available: false` and plans are granted by hand, so the screen
// says so instead of offering a button that can only fail. A query that
// errors reads as unavailable too. Until the first answer lands `known` is
// false, and the screen claims neither that card payments are open nor that
// they are not.
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import { useAction } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import type { BillingRedirect, BillingStatus } from "@codecast/convex/convex/billing";
import type { WalletSummary } from "@codecast/convex/convex/lib/wallet";
import { BILLING_RETURN, billingReturnOutcome, type PlanId } from "@codecast/shared/contracts/assistant";
import { useQueryNoThrow } from "../../hooks/useQueryNoThrow";
import { billingReturnNote, billingReturnSettled } from "./lane";

/** A plan to subscribe to, or a top-up in one of `TOPUP.amounts_usd`. Where
 *  Stripe sends the person back is BILLING_RETURN, this lane's plan page. */
export type CheckoutRequest = { plan: PlanId } | { topup_usd: number };

const DIDNT_OPEN = "Stripe didn't open. Try again in a moment.";
const NOTHING_OFFERED: BillingStatus = { available: false, plans: [], topup: false };

/** Opens a Stripe page. The web leaves for it in the same tab; the phone
 *  hands it to the browser. */
export type OpenBillingPage = (url: string) => void;

const leaveForPage: OpenBillingPage = (url) => window.location.assign(url);

export function useBilling(open: OpenBillingPage = leaveForPage): BillingStatus & {
  /** The first answer (or an error) has landed. */
  known: boolean;
  busy: boolean;
  error: string | null;
  checkout: (req: CheckoutRequest) => Promise<void>;
  /** Stripe's billing portal: card, invoices, plan change and cancel. */
  manage: () => Promise<void>;
} {
  const query = useQueryNoThrow(api.billing.billingAvailable, {});
  const status = query.data ?? NOTHING_OFFERED;
  const known = query.data !== undefined || !!query.error;
  const startCheckout = useAction(api.billing.startCheckout);
  const openPortal = useAction(api.billing.openPortal);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Both doors answer a BillingRedirect: a Stripe page to open, or why not.
  // A plan change for someone already subscribed comes back as the portal
  // (`via: "portal"`); either way the page to open is `url`.
  const redirect = async (mint: () => Promise<BillingRedirect>) => {
    setError(null);
    setBusy(true);
    try {
      const res = await mint();
      if (res.ok) open(res.url);
      else setError(res.error);
    } catch {
      setError(DIDNT_OPEN);
    } finally {
      setBusy(false);
    }
  };

  return {
    ...status,
    known,
    busy,
    error,
    checkout: (req) => redirect(() => startCheckout(req)),
    manage: () => redirect(() => openPortal({})),
  };
}

/** The note for a return from Stripe (BILLING_RETURN). `?billing=` is read
 *  once and taken off the URL, so a reload or a shared link does not repeat
 *  it. The person is usually back before Stripe's webhook has reached the
 *  wallet, so the note says the payment is on its way until the wallet shows
 *  it (`billingReturnSettled`), then thanks them. */
export function useBillingReturn(wallet: WalletSummary | null): ReturnType<typeof billingReturnNote> {
  const [params, setParams] = useSearchParams();
  const [returned] = useState(() => ({ outcome: billingReturnOutcome(params.get(BILLING_RETURN.param)), at: Date.now() }));
  useEffect(() => {
    if (!params.has(BILLING_RETURN.param)) return;
    setParams((current) => {
      const next = new URLSearchParams(current);
      next.delete(BILLING_RETURN.param);
      return next;
    }, { replace: true });
  }, [params, setParams]);
  if (!returned.outcome) return null;
  return billingReturnNote(returned.outcome, billingReturnSettled(returned.outcome, wallet, returned.at));
}
