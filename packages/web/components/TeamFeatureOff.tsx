"use client";
// The honest landing for a feature page (chat, calls) reached while the active
// team has that opt-in feature off — a direct URL, a stale tab, an old link.
// Every entry point is hidden when a feature is off, so this is the only chat
// or calls UI that can render then: a line saying so, and the way to turn it
// on for whoever can.
import Link from "next/link";
import { TEAM_FEATURES, type TeamFeatureKey } from "@codecast/shared/contracts";
import { useInboxStore } from "../store/inboxStore";

export function TeamFeatureOff({ feature }: { feature: TeamFeatureKey }) {
  const desc = TEAM_FEATURES.find((f) => f.key === feature);
  const isAdmin = useInboxStore((s) => {
    const teamId = s.clientState.ui?.active_team_id;
    const team = (s.teams || []).find((t: any) => String(t._id) === String(teamId));
    return team?.role === "admin";
  });
  return (
    <div className="flex h-full min-h-0 items-center justify-center p-8">
      <div className="max-w-sm text-center">
        <p className="text-sm text-sol-text">{desc?.name ?? feature} is off for this team.</p>
        <p className="mt-1 text-xs text-sol-text-dim">{desc?.desc}</p>
        {isAdmin ? (
          <Link
            href="/settings/team"
            className="mt-4 inline-block rounded border border-sol-border px-3 py-1.5 text-xs text-sol-text transition-colors hover:border-sol-blue/40 hover:text-sol-blue"
          >
            Turn it on in team settings
          </Link>
        ) : (
          <p className="mt-4 text-xs text-sol-text-dim">A team admin can turn it on under Settings → Team.</p>
        )}
      </div>
    </div>
  );
}
