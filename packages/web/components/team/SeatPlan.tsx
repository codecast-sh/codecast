// A team's seat plan where invites happen (convex/teamBilling.ts): Starter's
// free seats as dots, or Pro's seat count and trial, with the one action that
// fits. A full Starter offers the upgrade right here; the press opens the
// consequential review with Stripe's price before leaving for checkout. With
// seat billing off on this deployment the row renders nothing.
//
// The state is server-only data (plan, counts, Stripe status) read as an
// enrichment, like the invite code beside it: if it never arrives the invite
// panel works as before.
import { useState } from "react";
import { useAction } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import type { SeatOffer, SeatState } from "@codecast/convex/convex/teamBilling";
import { useQueryNoThrow } from "../../hooks/useQueryNoThrow";
import { useStripeRedirect } from "../simple/billing";
import { SwitchReview } from "../consequential/ConsequentialSwitch";
import { seatUpgradeLedger } from "../consequential/seatUpgradeLedger";
import { Button } from "../ui/button";

export type EnforcedSeatState = Extract<SeatState, { enforced: true }>;

/** The team's seat plan when seat billing is on here, else null. */
export function useSeatState(teamId: Id<"teams">): EnforcedSeatState | null {
  const state = useQueryNoThrow(api.teamBilling.getSeatState, { team_id: teamId }).data;
  return state?.enforced ? state : null;
}

const DAY_MS = 86_400_000;
const shortDate = (ms: number) => new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });

function SeatDots({ members, pending, capacity }: { members: number; pending: number; capacity: number }) {
  return (
    <span className="inline-flex items-center gap-1" aria-hidden>
      {Array.from({ length: capacity }, (_, i) => (
        <i
          key={i}
          className={`h-2 w-2 rounded-full ${
            i < members ? "bg-sol-text-muted" : i < members + pending ? "bg-sol-text-muted/35" : "border border-sol-border"
          }`}
        />
      ))}
    </span>
  );
}

export function SeatPlanRow({ teamId, teamName, state }: { teamId: Id<"teams">; teamName: string; state: EnforcedSeatState }) {
  const offerAction = useAction(api.teamBilling.seatOffer);
  const checkout = useAction(api.teamBilling.startSeatCheckout);
  const portal = useAction(api.teamBilling.openSeatPortal);
  const stripe = useStripeRedirect();
  const [reviewing, setReviewing] = useState(false);
  const [offer, setOffer] = useState<SeatOffer | undefined>(undefined);

  if (state.grandfathered) return null;
  const pro = state.plan === "pro";
  const used = state.members + state.pending;
  const needsPlan = state.full || state.lapsed;

  const openReview = () => {
    setOffer(undefined);
    setReviewing(true);
    offerAction({ team_id: teamId }).then(setOffer, () => setOffer({ ok: false, error: "Could not read the price." }));
  };

  const trialDays = state.trial_end ? Math.max(0, Math.ceil((state.trial_end - Date.now()) / DAY_MS)) : null;

  return (
    <div className="space-y-1.5" data-seat-plan={state.lapsed ? "lapsed" : state.plan} data-seat-full={state.full || undefined}>
      <div className="flex min-h-11 items-center justify-between gap-3 rounded-md border border-sol-border bg-sol-bg-alt/40 px-3 py-1.5 text-sm">
        <span className="flex min-w-0 items-center gap-2.5">
          <span className={`whitespace-nowrap font-medium ${state.lapsed ? "text-sol-red" : "text-sol-text"}`}>{pro ? "Pro" : state.lapsed ? "Pro lapsed" : "Starter"}</span>
          {pro ? (
            <span className="truncate tabular-nums text-sol-text-muted">
              {state.members} {state.members === 1 ? "seat" : "seats"}
              {trialDays !== null && <span className="text-sol-cyan"> · Trial, {trialDays}d left</span>}
              {state.cancel_at_period_end && state.current_period_end && <span className="text-sol-orange"> · Ends {shortDate(state.current_period_end)}</span>}
              {state.status === "past_due" && <span className="text-sol-orange"> · Payment due</span>}
            </span>
          ) : (
            <>
              <SeatDots members={state.members} pending={state.pending} capacity={state.free_capacity} />
              <span
                className={`whitespace-nowrap tabular-nums ${state.full ? "text-sol-orange" : "text-sol-text-muted"}`}
                title={`${state.members} members, ${state.pending} pending invites`}
              >
                {used} of {state.free_capacity} used
              </span>
            </>
          )}
        </span>
        <span className="flex shrink-0 items-center gap-3">
          {state.is_admin && state.has_billing && (
            <button
              type="button"
              onClick={() => stripe.redirect(() => portal({ team_id: teamId }))}
              disabled={stripe.busy}
              className="text-sm text-sol-text-dim underline decoration-sol-border underline-offset-2 hover:text-sol-text disabled:opacity-50"
              data-seat-billing
            >
              Billing
            </button>
          )}
          {!pro && state.is_admin && (
            needsPlan ? (
              <Button size="xs" onClick={openReview} disabled={stripe.busy} className="tf-primary" data-seat-upgrade>
                {state.lapsed ? "Renew Pro" : "Upgrade to Pro"}
              </Button>
            ) : (
              <button
                type="button"
                onClick={openReview}
                className="text-sm text-sol-text-dim underline decoration-sol-border underline-offset-2 hover:text-sol-text"
                data-seat-upgrade
              >
                Upgrade
              </button>
            )
          )}
          {!pro && !state.is_admin && needsPlan && <span className="text-sol-text-dim">Admin can upgrade</span>}
        </span>
      </div>
      <p aria-live="polite" className={stripe.error ? "text-sm text-sol-red" : "sr-only"}>{stripe.error}</p>
      {reviewing && (
        <SwitchReview
          ledger={seatUpgradeLedger({ team: teamName, seats: state.members, renew: state.lapsed, offer })}
          onClose={() => setReviewing(false)}
          onConfirm={() => {
            setReviewing(false);
            void stripe.redirect(() => checkout({ team_id: teamId }));
          }}
        />
      )}
    </div>
  );
}
