import { Check, ChevronDown, Eye, EyeOff, ListChecks, Lock, LockOpen } from "lucide-react";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { TeamIcon } from "../TeamIcon";
import {
  currentMembershipVisibility,
  describeTeamSharing,
  teamVisibilityOption,
  type TeamSharingFacts,
} from "../../lib/teamVisibility";
import { shareMenuActions, startOfDay, type ShareImpact } from "../../lib/team/shareImpact";

export type ShareMenuTeam = TeamSharingFacts & {
  _id: Id<"teams">;
  icon?: string | null;
  icon_color?: string | null;
};

/** The rule a row is under today, as the trigger and the check marks read it. */
export type ShareMenuCurrent = {
  locked?: false;
  teamId: Id<"teams">;
  teamName: string;
  shareSince: number | null;
  /** Shared through a rule on another checkout of the same repository. */
  inherited?: boolean;
  /** Shared through the team's default share paths, not a rule of this row. */
  isDefault?: boolean;
} | {
  /** A "never share" lock: no rule can share the row, the repository's included. */
  locked: true;
  /** Locked through a lock on another checkout of the same repository. */
  inherited?: boolean;
} | null;

/**
 * The control that shares a repository with a team. Every option says what
 * one click does, with the number it exposes, before the click: who sees it
 * and at what level (the group label), and the two scopes with their counts.
 * "Choose which sessions" opens the review for a date or single sessions.
 * Nothing here needs a confirm; the caller offers undo on the toast.
 */
export function ShareMenu({
  name,
  impact,
  counting,
  teams,
  current,
  onShare,
  onStop,
  onLock,
  onReview,
}: {
  name: string;
  impact: ShareImpact;
  /** The exact counts have not landed yet; actions wait for them. */
  counting: boolean;
  teams: ShareMenuTeam[];
  current: ShareMenuCurrent;
  onShare: (teamId: Id<"teams">, since: number | null) => void;
  /** Stop sharing, or lift a lock: the row is plain private either way. */
  onStop: () => void;
  onLock: () => void;
  onReview: (teamId: Id<"teams">) => void;
}) {
  const today = startOfDay();
  const actions = shareMenuActions(impact);
  const locked = !!current?.locked;
  const team = current && !current.locked ? current : null;
  const shared = !!team && !team.isDefault;
  const detailClass = "block text-[11px] leading-snug text-sol-text-muted";
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`Who can open ${name}`}
          className={`flex min-w-[140px] items-center justify-between gap-2 rounded-md border px-3 py-1.5 text-sm transition-colors ${
            shared
              ? "border-sol-cyan bg-sol-cyan/10 text-sol-text"
              : locked
                ? "border-sol-green/60 bg-sol-green/10 text-sol-text"
                : team?.isDefault
                  ? "border-sol-border/60 bg-sol-bg-highlight/20 text-sol-text"
                  : "border-sol-border bg-sol-bg text-sol-text-muted hover:bg-sol-bg-highlight/40 hover:text-sol-text"
          }`}
        >
          <span className="flex items-center gap-2">
            {locked ? <Lock className="h-4 w-4 text-sol-green" /> : team ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
            <span>
              {locked ? "Never shared" : team ? team.teamName : "Only me"}
              {current?.inherited && (
                <span className="ml-0.5 text-xs text-sol-text-muted" title={locked ? "Locked through another checkout of this repository" : "Shared through a rule on another checkout of this repository"}>
                  (repo)
                </span>
              )}
              {team?.isDefault && (
                <span className="ml-0.5 text-xs text-sol-text-muted" title="Shared automatically via your team's share paths">
                  (auto)
                </span>
              )}
            </span>
          </span>
          <ChevronDown className="h-3 w-3 opacity-50" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[380px] max-h-[70dvh] overflow-y-auto">
        {shared && (
          <>
            <DropdownMenuItem onClick={onStop} className="items-start gap-3 py-2">
              <EyeOff className="mt-0.5 h-4 w-4 shrink-0 text-sol-text-muted" />
              <span className="min-w-0">
                <span className="block text-sm text-sol-text">Stop sharing with {team!.teamName}</span>
                <span className={detailClass}>Only you can open it again. One click to undo.</span>
              </span>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        )}
        {locked ? (
          <DropdownMenuItem onClick={onStop} className="items-start gap-3 py-2">
            <LockOpen className="mt-0.5 h-4 w-4 shrink-0 text-sol-text-muted" />
            <span className="min-w-0">
              <span className="block text-sm text-sol-text">Unlock</span>
              <span className={detailClass}>Still private to you, but a share rule can reach it again.</span>
            </span>
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem onClick={onLock} className="items-start gap-3 py-2">
            <Lock className="mt-0.5 h-4 w-4 shrink-0 text-sol-green" />
            <span className="min-w-0">
              <span className="block text-sm text-sol-text">Never share</span>
              <span className={detailClass}>
                No rule can share it, this repository's included. Only you can open its sessions, past and future.
              </span>
            </span>
          </DropdownMenuItem>
        )}
        {teams.length > 0 && <DropdownMenuSeparator />}
        {teams.map((teamRow, i) => {
          const level = teamVisibilityOption(currentMembershipVisibility(teamRow));
          const hidden = level.value === "hidden";
          const isCurrent = !!team && team.teamId === teamRow._id && !team.isDefault;
          const onToday = isCurrent && team!.shareSince != null && team!.shareSince >= today;
          const onEverything = isCurrent && team!.shareSince == null;
          const disabled = counting || hidden;
          return (
            <div key={teamRow._id}>
              {i > 0 && <DropdownMenuSeparator />}
              <DropdownMenuLabel className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-sol-text-dim">
                <TeamIcon icon={teamRow.icon} color={teamRow.icon_color} className="h-3 w-3" />
                <span className="truncate">{teamRow.name}</span>
                <span className="font-normal normal-case tracking-normal">
                  · {describeTeamSharing(teamRow)} · {hidden ? "your level is Hidden" : `they get ${level.sees}`}
                </span>
              </DropdownMenuLabel>
              {hidden && (
                <p className="px-2 pb-1.5 text-[11px] text-sol-yellow">
                  Nothing shows to {teamRow.name} until you raise your level for it.
                </p>
              )}
              <DropdownMenuItem
                disabled={disabled || onToday}
                onClick={() => onShare(teamRow._id, today)}
                className="items-start gap-3 py-2"
              >
                <Check className={`mt-0.5 h-4 w-4 shrink-0 ${onToday ? "text-sol-cyan" : "opacity-0"}`} />
                <span className="min-w-0">
                  <span className="block text-sm text-sol-text">{actions.fromToday.label}</span>
                  <span className={detailClass}>{counting ? "Counting sessions." : actions.fromToday.detail}</span>
                </span>
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={disabled || onEverything}
                onClick={() => onShare(teamRow._id, null)}
                className="items-start gap-3 py-2"
              >
                <Check className={`mt-0.5 h-4 w-4 shrink-0 ${onEverything ? "text-sol-cyan" : "opacity-0"}`} />
                <span className="min-w-0">
                  <span className="block text-sm text-sol-text">{actions.everything.label}</span>
                  <span className={detailClass}>{counting ? "Counting sessions." : actions.everything.detail}</span>
                </span>
              </DropdownMenuItem>
              <DropdownMenuItem disabled={hidden} onClick={() => onReview(teamRow._id)} className="items-start gap-3 py-2">
                <ListChecks className="mt-0.5 h-4 w-4 shrink-0 text-sol-cyan" />
                <span className="min-w-0">
                  <span className="block text-sm text-sol-cyan">Choose which sessions</span>
                  <span className={detailClass}>Pick a date, or keep single sessions private.</span>
                </span>
              </DropdownMenuItem>
            </div>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
