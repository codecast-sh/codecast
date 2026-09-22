import { useState } from "react";
import Link from "next/link";
import { Eye, X } from "lucide-react";
import { toast } from "sonner";
import { useInboxStore } from "../store/inboxStore";
import { useMountEffect } from "../hooks/useMountEffect";
import { pickTeamSharingNudge, teamVisibilityOption } from "../lib/teamVisibility";

// Snoozed for a month per dismiss, synced per user like the other strips.
const SNOOZE_MS = 30 * 24 * 60 * 60 * 1000;

/** One quiet strip: a team with other people on it, a project already flowing
 *  to it, and the member showing less than the whole conversation. The action
 *  raises the level for NEW sessions only, so past sessions stay as they were
 *  and the click is safe to take without reading the settings page first. */
export function TeamSharingNudgeBanner() {
  const snoozedAt = useInboxStore((s) => s.clientState.dismissed?.team_sharing_prompt ?? 0);
  const updateDismissed = useInboxStore((s) => s.updateClientDismissed);
  const setTeamMembershipVisibility = useInboxStore((s) => s.setTeamMembershipVisibility);
  const teams = useInboxStore((s) => s.teams);
  const [mounted, setMounted] = useState(false);
  useMountEffect(() => { setMounted(true); });

  if (!mounted) return null;
  if (snoozedAt > 0 && Date.now() - snoozedAt < SNOOZE_MS) return null;
  const team = pickTeamSharingNudge(teams);
  if (!team) return null;

  const sees = teamVisibilityOption(team.visibility).sees;
  const others = Math.max(1, (team.member_count ?? 2) - 1);

  const shareNew = () => {
    setTeamMembershipVisibility(String(team._id), "full", "going_forward");
    updateDismissed("team_sharing_prompt", Date.now());
    toast.success(`${team.name} sees the whole conversation for new sessions`);
  };

  return (
    <div className="bg-gradient-to-r from-sol-cyan/10 via-sol-cyan/5 to-sol-cyan/10 border-b border-sol-cyan/30">
      <div className="px-4 py-2 flex items-center justify-between gap-4">
        <div className="flex items-center gap-3 min-w-0">
          <Eye className="w-4 h-4 text-sol-cyan flex-shrink-0" />
          <span className="text-sm text-sol-text truncate">
            {others === 1 ? "Your teammate" : `${others} teammates`} in {team.name} see only {sees} of your sessions.{" "}
            <span className="text-sol-text-muted">Share new sessions in full so they can follow along.</span>
          </span>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <button
            onClick={shareNew}
            className="px-2.5 py-1 text-xs font-medium rounded-md bg-sol-cyan text-sol-base03 hover:opacity-90 transition-opacity"
          >
            Share new sessions in full
          </button>
          <Link
            href="/settings/sync"
            className="px-2.5 py-1 text-xs font-medium rounded-md text-sol-text-muted hover:text-sol-text transition-colors"
          >
            Settings
          </Link>
          <button
            onClick={() => updateDismissed("team_sharing_prompt", Date.now())}
            className="p-1 text-sol-text-dim hover:text-sol-text transition-colors"
            aria-label="Dismiss"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
