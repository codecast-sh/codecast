"use client";
// Placeholder for the Changes page until its components land
// (docs/proposals/changes-page.md T12, which owns and replaces this file). It
// already keeps the page's gates: Changes is written for a team, and only
// for a team that turned the feature on.
import { useSearchParams } from "next/navigation";
import { TeamFeatureOff } from "../TeamFeatureOff";
import { useTeamFeature } from "../../lib/teamFeatures";
import { changesDayLabel, localDay } from "../../lib/changesDay";
import { useInboxStore } from "../../store/inboxStore";

export function ChangesPage() {
  const searchParams = useSearchParams();
  const hasTeam = useInboxStore((s) => !!s.clientState.ui?.active_team_id);
  const on = useTeamFeature("changes");

  if (!hasTeam) {
    return (
      <div className="flex h-full min-h-0 items-center justify-center p-8">
        <p className="max-w-sm text-center text-sm text-sol-text">
          Changes is written for a team. Join or create one to see it.
        </p>
      </div>
    );
  }
  if (!on) return <TeamFeatureOff feature="changes" />;

  const day = changesDayLabel(searchParams.get("d")) ?? changesDayLabel(localDay());
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[1180px] px-6 py-6">
        <h1 className="text-[20px] font-semibold text-sol-text">Changes</h1>
        <p className="mt-1 text-xs text-sol-text-dim">{day}</p>
      </div>
    </div>
  );
}
