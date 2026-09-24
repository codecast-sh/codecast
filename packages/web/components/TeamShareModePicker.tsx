// The per-session team sharing choice: Hidden, Summary or Full, with one line
// on what the team sees, why the session is shared when a repo mapping did it,
// and the offer to share every new session in full once this one is. The
// session header's share popover and the team feed's share chip both render
// it; the parent owns the value and performs the writes.
import { useMemo, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { useInboxStore } from "../store/inboxStore";
import { TEAM_VISIBILITY_RANK, currentMembershipVisibility, teamVisibilityFor } from "../lib/teamVisibility";
import type { TeamShareMode } from "../lib/teamFeedRows";

const MODES: { value: TeamShareMode; label: string; selected: string; icon: string }[] = [
  {
    value: "private",
    label: "Hidden",
    selected: "bg-sol-base02/50 text-sol-text",
    icon: "M3.98 8.223A10.477 10.477 0 001.934 12C3.226 16.338 7.244 19.5 12 19.5c.993 0 1.953-.138 2.863-.395M6.228 6.228A10.45 10.45 0 0112 4.5c4.756 0 8.773 3.162 10.065 7.498a10.523 10.523 0 01-4.293 5.774M6.228 6.228L3 3m3.228 3.228l3.65 3.65m7.894 7.894L21 21m-3.228-3.228l-3.65-3.65m0 0a3 3 0 10-4.243-4.243m4.242 4.242L9.88 9.88",
  },
  {
    value: "summary",
    label: "Summary",
    selected: "bg-teal-500/15 text-teal-600 dark:text-teal-400",
    icon: "M8.25 6.75h12M8.25 12h12m-12 5.25h12M3.75 6.75h.007v.008H3.75V6.75zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zM3.75 12h.007v.008H3.75V12zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm-.375 5.25h.007v.008H3.75v-.008zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0z",
  },
  {
    value: "full",
    label: "Full",
    selected: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
    icon: "M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z M15 12a3 3 0 11-6 0 3 3 0 016 0z",
  },
];

const MODE_HINT: Record<TeamShareMode, string> = {
  private: "Hidden from team members",
  summary: "Team sees title and activity summary",
  full: "Team can view the full conversation",
};

export function TeamShareModePicker({
  mode,
  onChange,
  teamId,
  sharedVia,
  gated,
  onNavigate,
}: {
  mode: TeamShareMode;
  onChange: (mode: TeamShareMode) => void | Promise<void>;
  /** The team the session is shared with, for the share-all-new-sessions offer. */
  teamId?: string | null;
  /** The directory whose team mapping shared this session, when a mapping did. */
  sharedVia?: string | null;
  /** The member's own level for the team keeps every session out of the feed. */
  gated?: boolean;
  /** Called before a link inside the picker leaves the page (close a popover). */
  onNavigate?: () => void;
}) {
  const [isUpdating, setIsUpdating] = useState(false);
  // The moment to suggest the team-wide switch: this session is now Full while
  // the member's level for the team is still lower, and someone else is on it.
  // Subscribed by signature: the teams list re-pushes whole, and every card on
  // a feed renders one of these.
  const teamSig = useInboxStore((s) => {
    const t = teamVisibilityFor(s.teams, teamId);
    return t ? `${t._id}|${t.name}|${t.member_count ?? 0}|${currentMembershipVisibility(t)}` : "";
  });
  // eslint-disable-next-line react-hooks/exhaustive-deps -- teamSig stands in for the churny list
  const team = useMemo(() => teamVisibilityFor(useInboxStore.getState().teams, teamId), [teamSig, teamId]);
  const setTeamMembershipVisibility = useInboxStore((s) => s.setTeamMembershipVisibility);
  const teamBelowFull =
    !!team && (team.member_count ?? 0) > 1 &&
    TEAM_VISIBILITY_RANK[currentMembershipVisibility(team)] < TEAM_VISIBILITY_RANK.full;

  const pick = async (next: TeamShareMode) => {
    if (next === mode) return;
    setIsUpdating(true);
    try {
      await onChange(next);
    } finally {
      setIsUpdating(false);
    }
  };

  return (
    <div className="space-y-2">
      <span className="text-xs font-medium text-sol-text-dim uppercase tracking-wide">Team</span>
      <div className="flex rounded-lg border border-sol-border overflow-hidden">
        {MODES.map((m, i) => (
          <button
            key={m.value}
            type="button"
            onClick={() => pick(m.value)}
            disabled={isUpdating}
            aria-pressed={mode === m.value}
            className={`flex-1 px-3 py-2 text-xs font-medium transition-colors flex items-center justify-center gap-1.5 ${i === 1 ? "border-l border-r border-sol-border " : ""}${
              mode === m.value ? m.selected : "bg-sol-bg text-sol-text-muted hover:bg-sol-bg-alt"
            }`}
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d={m.icon} />
            </svg>
            {m.label}
          </button>
        ))}
      </div>
      <p className="text-[11px] text-sol-text-dim">{MODE_HINT[mode]}</p>
      {gated && (
        <p className="text-[11px] text-sol-text-dim">
          Your level for this team keeps all your sessions out of its feed.{" "}
          <Link href="/settings/sync" className="text-sol-cyan hover:underline" onClick={onNavigate}>
            Change team visibility
          </Link>
        </p>
      )}
      {mode !== "private" && sharedVia && (
        <p className="text-[11px] text-sol-text-dim">
          Shared because the repo{" "}
          <span className="font-mono text-sol-text-muted">{sharedVia.split("/").pop() || sharedVia}</span>{" "}
          is shared with the team.{" "}
          <Link href="/settings/sync" className="text-sol-cyan hover:underline" onClick={onNavigate}>
            Manage repo sharing
          </Link>
        </p>
      )}
      {mode === "full" && teamBelowFull && team && (
        <button
          type="button"
          onClick={() => {
            setTeamMembershipVisibility(String(team._id), "full", "going_forward");
            toast.success(`${team.name} sees the whole conversation for new sessions`);
          }}
          className="text-[11px] text-sol-cyan hover:underline"
        >
          Share all new sessions with {team.name} in full
        </button>
      )}
    </div>
  );
}
