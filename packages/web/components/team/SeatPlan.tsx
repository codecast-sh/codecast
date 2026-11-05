// A team's seat plan where invites happen (convex/teamBilling.ts): Starter's
// free seats as dots, or Pro's seat count and trial, with the one action that
// fits. A full Starter offers the upgrade right here; the press opens the
// consequential review with Stripe's price before leaving for checkout. With
// seat billing off on this deployment the row renders nothing.
//
// The state is server-only data (plan, counts, Stripe status) read as an
// enrichment, like the invite code beside it: if it never arrives the invite
// panel works as before.
import { useAction } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import type { EnforcedSeatState } from "../../hooks/useSeatState";
import { Button } from "../ui/button";
import { useSeatUpgrade } from "../../hooks/useSeatUpgrade";

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

export function SeatPlanRow({ teamId, state }: { teamId: Id<"teams">; state: EnforcedSeatState }) {
  const portal = useAction(api.teamBilling.openSeatPortal);
  const { open: openReview, review, stripe } = useSeatUpgrade(teamId, state);

  const freeUntil = state.grandfathered ? state.grandfathered_until : null;
  if (state.grandfathered && freeUntil === null) return null;
  const pro = state.plan === "pro";
  const used = state.members + state.pending;
  const needsPlan = state.full || state.lapsed;

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
          ) : freeUntil !== null ? (
            <span className="truncate tabular-nums text-sol-text-muted">
              {state.members} seats <span className="text-sol-orange">· Free until {shortDate(freeUntil)}</span>
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
      {review}
    </div>
  );
}
