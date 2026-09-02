"use client";
// The honest landing for a feature page (chat, calls) reached while the active
// team has that opt-in feature off — a direct URL, a stale tab, an old link.
// Every entry point is hidden when a feature is off, so this is the only chat
// or calls UI that can render then: a line saying so, and the way to turn it
// on for whoever can.
//
// The words come from @platform/flags (featureOffCopy), so the CLI's refusal,
// the server's error and this page say the same thing about the same feature.
import Link from "next/link";
import { type TeamFeatureKey } from "@codecast/shared/contracts";
import { featureOffCopy } from "@platform/flags";
import { TEAM_FEATURE_CATALOG } from "../lib/teamFeatures";
import { useInboxStore } from "../store/inboxStore";

export function TeamFeatureOff({ feature }: { feature: TeamFeatureKey }) {
  const isAdmin = useInboxStore((s) => {
    const teamId = s.clientState.ui?.active_team_id;
    const team = (s.teams || []).find((t: any) => String(t._id) === String(teamId));
    return team?.role === "admin";
  });
  const copy = featureOffCopy(TEAM_FEATURE_CATALOG, feature, isAdmin);
  return (
    <div className="flex h-full min-h-0 items-center justify-center p-8">
      <div className="max-w-sm text-center">
        <p className="text-sm text-sol-text">{copy.title}</p>
        <p className="mt-1 text-xs text-sol-text-dim">{copy.desc}</p>
        {copy.canToggle ? (
          <Link
            href="/settings/team"
            className="mt-4 inline-block rounded border border-sol-border px-3 py-1.5 text-xs text-sol-text transition-colors hover:border-sol-blue/40 hover:text-sol-blue"
          >
            {copy.hint}
          </Link>
        ) : (
          <p className="mt-4 text-xs text-sol-text-dim">{copy.hint}</p>
        )}
      </div>
    </div>
  );
}
