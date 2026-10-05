// The plan page's note for a return from Stripe, on the web only: it reads
// and rewrites the URL through the web's router, which the phone's bundle
// must never load (Hermes refuses the router's import.meta). The checkout
// itself, shared with the phone, is billing.ts.
import { useState } from "react";
import { useSearchParams } from "react-router";
import type { WalletSummary } from "@codecast/convex/convex/lib/wallet";
import { BILLING_RETURN, billingReturnOutcome } from "@codecast/shared/contracts/assistant";
import { useMountEffect } from "../../hooks/useMountEffect";
import { BILLING_RETURN_PATIENCE_MS, billingReturnNote, billingReturnSettled, type BillingReturnNote } from "./lane";

/** The note for a return from Stripe (BILLING_RETURN). `?billing=` is read
 *  once and taken off the URL, so a reload or a shared link does not repeat
 *  it. The person is usually back before Stripe's webhook has reached the
 *  wallet, so the note says the payment is on its way until the wallet shows
 *  it (`billingReturnSettled`), then thanks them. A payment still missing
 *  after BILLING_RETURN_PATIENCE_MS gets a note that points to support. */
export function useBillingReturn(wallet: WalletSummary | null): BillingReturnNote | null {
  const [params, setParams] = useSearchParams();
  const [returned] = useState(() => ({ outcome: billingReturnOutcome(params.get(BILLING_RETURN.param)), at: Date.now() }));
  const [late, setLate] = useState(false);
  useMountEffect(() => {
    if (!params.has(BILLING_RETURN.param)) return;
    setParams((current) => {
      const next = new URLSearchParams(current);
      next.delete(BILLING_RETURN.param);
      return next;
    }, { replace: true });
    if (returned.outcome !== "done" && returned.outcome !== "topup") return;
    const timer = setTimeout(() => setLate(true), BILLING_RETURN_PATIENCE_MS);
    return () => clearTimeout(timer);
  });
  if (!returned.outcome) return null;
  return billingReturnNote(returned.outcome, billingReturnSettled(returned.outcome, wallet, returned.at), late);
}
