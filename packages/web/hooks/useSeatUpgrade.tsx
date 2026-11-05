import { useState } from "react";
import { useAction } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import type { SeatOffer } from "@codecast/convex/convex/teamBilling";
import type { EnforcedSeatState } from "./useSeatState";
import { useStripeRedirect } from "../components/simple/billing";
import { SwitchReview } from "../components/consequential/ConsequentialSwitch";
import { BILLED_OPTIONS, seatUpgradeLedger, type SeatBillingChoice } from "../components/consequential/seatUpgradeLedger";

/** Starting (or renewing) Pro from anywhere: `open` shows the consequential
 *  review with Stripe's prices, `review` is that dialog to render, and its
 *  confirm leaves for Stripe checkout with the picked billing. */
export function useSeatUpgrade(teamId: Id<"teams">, state: EnforcedSeatState) {
  const offerAction = useAction(api.teamBilling.seatOffer);
  const checkout = useAction(api.teamBilling.startSeatCheckout);
  const stripe = useStripeRedirect();
  const [reviewing, setReviewing] = useState(false);
  const [offer, setOffer] = useState<SeatOffer | undefined>(undefined);
  const [billing, setBilling] = useState<SeatBillingChoice>("monthly");

  const open = () => {
    setOffer(undefined);
    setReviewing(true);
    offerAction({ team_id: teamId }).then(setOffer, () => setOffer({ ok: false, error: "Could not read the price." }));
  };

  const review = reviewing ? (
    <SwitchReview
      ledger={seatUpgradeLedger({ team: state.team_name, seats: state.members, renew: state.lapsed, offer, billing })}
      onClose={() => setReviewing(false)}
      onPick={(option) => setBilling(BILLED_OPTIONS[option as keyof typeof BILLED_OPTIONS] ?? "monthly")}
      onConfirm={() => {
        setReviewing(false);
        void stripe.redirect(() => checkout({ team_id: teamId, billing }));
      }}
    />
  ) : null;

  return { open, review, stripe };
}
