// The per-session team sharing choice: Hidden, Summary or Full, with one line
// on what the team sees, why the session is shared when a repo mapping did it,
// and the offer to share every new session in full once this one is. The
// session header's share popover and the team feed's share chip both render
// it; the parent owns the value and performs the writes.
import { useMemo, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { useInboxStore } from "../store/inboxStore";
import { TEAM_VISIBILITY_RANK, currentMembershipVisibility, teamVisibilityFor, teamVisibilityOption } from "../lib/teamVisibility";
import { ConsequentialSwitch } from "./consequential/ConsequentialSwitch";
import { shareInFullLedger } from "./consequential/ledgers";
import type { TeamShareMode } from "../lib/teamFeedRows";
import { TEAM_SHARE_MODES, type SegmentedOption } from "../lib/teamShareModes";

const MODE_HINT: Record<TeamShareMode, string> = {
  private: "Only you can see this. It stays out of the team feed.",
  summary: "The team feed shows the title and a summary of the work.",
  full: "The team can read the whole conversation.",
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
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs font-medium text-sol-text-muted">
          {team?.name ? <>Team <span className="text-sol-text">{team.name}</span></> : "Team"}
        </span>
        {isUpdating && <span className="text-meta text-sol-text-dim">Saving…</span>}
      </div>
      <SegmentedChoice label="What the team sees" options={TEAM_SHARE_MODES} value={mode} onPick={pick} disabled={isUpdating} />
      <p className="text-xs leading-snug text-sol-text-muted">{MODE_HINT[mode]}</p>
      {gated && (
        <p className="text-meta leading-snug text-sol-text-dim">
          Your level for this team keeps all your sessions out of its feed.{" "}
          <Link href="/settings/sync" className="text-sol-cyan hover:underline" onClick={onNavigate}>
            Change team visibility
          </Link>
        </p>
      )}
      {mode !== "private" && sharedVia && (
        <p className="text-meta leading-snug text-sol-text-dim">
          Shared automatically: the repo{" "}
          <span className="font-mono text-sol-text-muted">{sharedVia.split("/").pop() || sharedVia}</span>{" "}
          is shared with this team.{" "}
          <Link href="/settings/sync" className="text-sol-cyan hover:underline whitespace-nowrap" onClick={onNavigate}>
            Repo settings
          </Link>
        </p>
      )}
      {mode === "full" && teamBelowFull && team && (
        <ConsequentialSwitch
          on={false}
          ledger={shareInFullLedger({ team: team.name, others: Math.max(1, (team.member_count ?? 2) - 1), sees: teamVisibilityOption(team.visibility).sees })}
          onTurnOn={() => {
            setTeamMembershipVisibility(String(team._id), "full", "going_forward");
            toast.success(`${team.name} sees the whole conversation for new sessions`);
          }}
          onTurnOff={() => {}}
          trigger={({ press }) => (
        <button
          type="button"
          onClick={press}
          aria-haspopup="dialog"
          className="text-meta text-sol-cyan hover:underline text-left"
        >
          Share all new sessions with {team.name} in full
        </button>
          )}
        />
      )}
    </div>
  );
}

export type { SegmentedOption };

/** A row of mutually exclusive share choices, one icon and label each. The
 *  team level and the link access in the share popover both pick with it. */
/** `compact`: the inline size for a composer's meta row, beside its switches;
 *  only the picked option is spelled out, the others are their icons. */
export function SegmentedChoice<T extends string>({ label, options, value, onPick, disabled, compact }: {
  label: string;
  options: SegmentedOption<T>[];
  /** Nothing is selected while undefined. */
  value: T | undefined;
  onPick: (value: T) => void;
  disabled?: boolean;
  compact?: boolean;
}) {
  return (
    <div role="radiogroup" aria-label={label} className={compact ? "inline-flex gap-px rounded-full bg-sol-bg-alt/70 p-px" : "flex gap-0.5 rounded-lg bg-sol-bg-alt p-0.5"}>
      {options.map((m) => {
        const on = value === m.value;
        return (
          <button
            key={m.value}
            type="button"
            role="radio"
            aria-checked={on}
            aria-label={m.label}
            title={compact ? m.label : undefined}
            onClick={() => onPick(m.value)}
            disabled={disabled}
            className={`${compact ? "rounded-full px-1.5 py-px text-meta gap-1" : "flex-1 rounded-md px-2 py-1.5 text-xs font-medium gap-1.5"} transition-colors flex items-center justify-center outline-none focus-visible:ring-1 focus-visible:ring-sol-cyan disabled:cursor-wait ${
              on ? `${m.selected} ${compact ? "" : "shadow-sm shadow-black/20"}` : `${compact ? "text-sol-text-dim" : "text-sol-text-muted"} hover:text-sol-text hover:bg-sol-bg/60`
            }`}
          >
            <svg className={`${compact ? "w-3 h-3" : "w-3.5 h-3.5"} shrink-0`} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d={m.icon} />
            </svg>
            {(!compact || on) && m.label}
          </button>
        );
      })}
    </div>
  );
}
