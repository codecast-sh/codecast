// The bar under the header while the active team should be on Pro and is not
// (convex/teamBilling.ts `needs_pro`): Starter with more members than it
// covers, its grandfathering over or never given. Nothing is switched off for
// such a team; this bar is the whole of it, with the upgrade one press away
// for an admin. It is a state of the team rather than a nudge, so it has no
// dismiss and sits outside the nudge slot.
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import { Users } from "lucide-react";
import { useActiveWorkspaceKey } from "../../hooks/useWorkspaceCollection";
import { useSeatState, type EnforcedSeatState } from "../../hooks/useSeatState";
import { Button } from "../ui/button";
import { useSeatUpgrade } from "../../hooks/useSeatUpgrade";

export function SeatBanner() {
  const key = useActiveWorkspaceKey();
  const teamId = key?.startsWith("team:") ? (key.slice(5) as Id<"teams">) : null;
  return teamId ? <TeamSeatBanner key={teamId} teamId={teamId} /> : null;
}

function TeamSeatBanner({ teamId }: { teamId: Id<"teams"> }) {
  const state = useSeatState(teamId);
  return state?.needs_pro ? <NeedsPro teamId={teamId} state={state} /> : null;
}

function NeedsPro({ teamId, state }: { teamId: Id<"teams">; state: EnforcedSeatState }) {
  const upgrade = useSeatUpgrade(teamId, state);
  return (
    <div data-cc-banner data-seat-banner className="border-b border-sol-orange/30 bg-sol-orange/10">
      <div className="flex items-center justify-between gap-3 px-3 py-1.5 sm:px-4">
        <span className="flex min-w-0 items-center gap-2.5 text-sm">
          <Users className="h-4 w-4 flex-shrink-0 text-sol-orange" />
          <span className="truncate font-medium text-sol-text">{state.team_name}</span>
          <span className="whitespace-nowrap tabular-nums text-sol-orange">
            {state.members} members · Starter covers {state.free_capacity}
          </span>
        </span>
        {state.is_admin ? (
          <Button size="xs" onClick={upgrade.open} disabled={upgrade.stripe.busy} className="tf-primary flex-shrink-0" data-seat-upgrade>
            {state.lapsed ? "Renew Pro" : "Upgrade to Pro"}
          </Button>
        ) : (
          <span className="flex-shrink-0 text-sm text-sol-text-dim">Admin can upgrade</span>
        )}
      </div>
      {upgrade.stripe.error && <p aria-live="polite" className="px-4 pb-1.5 text-sm text-sol-red">{upgrade.stripe.error}</p>}
      {upgrade.review}
    </div>
  );
}
