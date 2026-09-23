import { Check, ChevronDown, Eye, EyeOff, ListChecks } from "lucide-react";
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
  teamId: Id<"teams">;
  teamName: string;
  shareSince: number | null;
  /** Shared through a rule on another checkout of the same repository. */
  inherited?: boolean;
  /** Shared through the team's default share paths, not a rule of this row. */
  isDefault?: boolean;
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
  onReview,
}: {
  name: string;
  impact: ShareImpact;
  /** The exact counts have not landed yet; actions wait for them. */
  counting: boolean;
  teams: ShareMenuTeam[];
  current: ShareMenuCurrent;
  onShare: (teamId: Id<"teams">, since: number | null) => void;
  onStop: () => void;
  onReview: (teamId: Id<"teams">) => void;
}) {
  const today = startOfDay();
  const actions = shareMenuActions(impact);
  const shared = !!current && !current.isDefault;
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
              : current?.isDefault
                ? "border-sol-border/60 bg-sol-bg-highlight/20 text-sol-text"
                : "border-sol-border bg-sol-bg text-sol-text-muted hover:bg-sol-bg-highlight/40 hover:text-sol-text"
          }`}
        >
          <span className="flex items-center gap-2">
            {current ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
            <span>
              {current ? current.teamName : "Only me"}
              {current?.inherited && (
                <span className="ml-0.5 text-xs text-sol-text-muted" title="Shared through a rule on another checkout of this repository">
                  (repo)
                </span>
              )}
              {current?.isDefault && (
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
                <span className="block text-sm text-sol-text">Stop sharing with {current!.teamName}</span>
                <span className={detailClass}>Only you can open it again. One click to undo.</span>
              </span>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        )}
        {teams.map((team, i) => {
          const level = teamVisibilityOption(currentMembershipVisibility(team));
          const hidden = level.value === "hidden";
          const isCurrent = !!current && current.teamId === team._id && !current.isDefault;
          const onToday = isCurrent && current!.shareSince != null && current!.shareSince >= today;
          const onEverything = isCurrent && current!.shareSince == null;
          const disabled = counting || hidden;
          return (
            <div key={team._id}>
              {i > 0 && <DropdownMenuSeparator />}
              <DropdownMenuLabel className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-sol-text-dim">
                <TeamIcon icon={team.icon} color={team.icon_color} className="h-3 w-3" />
                <span className="truncate">{team.name}</span>
                <span className="font-normal normal-case tracking-normal">
                  · {describeTeamSharing(team)} · {hidden ? "your level is Hidden" : `they get ${level.sees}`}
                </span>
              </DropdownMenuLabel>
              {hidden && (
                <p className="px-2 pb-1.5 text-[11px] text-sol-yellow">
                  Nothing shows to {team.name} until you raise your level for it.
                </p>
              )}
              <DropdownMenuItem
                disabled={disabled || onToday}
                onClick={() => onShare(team._id, today)}
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
                onClick={() => onShare(team._id, null)}
                className="items-start gap-3 py-2"
              >
                <Check className={`mt-0.5 h-4 w-4 shrink-0 ${onEverything ? "text-sol-cyan" : "opacity-0"}`} />
                <span className="min-w-0">
                  <span className="block text-sm text-sol-text">{actions.everything.label}</span>
                  <span className={detailClass}>{counting ? "Counting sessions." : actions.everything.detail}</span>
                </span>
              </DropdownMenuItem>
              <DropdownMenuItem disabled={hidden} onClick={() => onReview(team._id)} className="items-start gap-3 py-2">
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
