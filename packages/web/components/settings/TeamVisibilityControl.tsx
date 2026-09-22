import { useState } from "react";
import { Check, ChevronDown, Eye, EyeOff } from "lucide-react";
import { toast } from "sonner";
import { useInboxStore } from "../../store/inboxStore";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import { Button } from "../ui/button";
import { SettingsOptionGroup } from "./ui";
import {
  TEAM_VISIBILITY_OPTIONS,
  TEAM_VISIBILITY_RANK,
  currentMembershipVisibility,
  teamVisibilityOption,
  type TeamSharingFacts,
  type TeamVisibilityLevel,
  type VisibilityChangeMode,
} from "../../lib/teamVisibility";

/** The one control for "how much does this team see of my sessions". A menu
 *  whose items say what each level means, so the choice explains itself at the
 *  moment it is made. Lowering applies at once. Raising asks one question
 *  first: only new sessions, or everything, because a raise opens past
 *  sessions teammates could not read before. */
export function TeamVisibilityControl({ team }: { team: TeamSharingFacts }) {
  const setTeamMembershipVisibility = useInboxStore((s) => s.setTeamMembershipVisibility);
  const current = currentMembershipVisibility(team);
  const currentOption = teamVisibilityOption(current);
  const [raiseTo, setRaiseTo] = useState<TeamVisibilityLevel | null>(null);

  const apply = (level: TeamVisibilityLevel, mode: VisibilityChangeMode) => {
    setTeamMembershipVisibility(String(team._id), level, mode);
    const option = teamVisibilityOption(level);
    toast.success(
      mode === "going_forward"
        ? `${team.name} sees ${option.sees} for new sessions`
        : `${team.name} now sees ${option.sees}`,
    );
  };

  const pick = (level: TeamVisibilityLevel) => {
    if (level === current) return;
    if (TEAM_VISIBILITY_RANK[level] > TEAM_VISIBILITY_RANK[current]) {
      setRaiseTo(level);
      return;
    }
    apply(level, "everything");
  };

  const raiseOption = raiseTo ? teamVisibilityOption(raiseTo) : null;
  const Icon = current === "hidden" ? EyeOff : Eye;

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={`What ${team.name} sees`}
            className="flex min-w-[150px] items-center justify-between gap-2 rounded-md border border-sol-border bg-sol-bg px-3 py-1.5 text-sm text-sol-text transition-colors hover:bg-sol-bg-highlight/40"
          >
            <span className="flex items-center gap-2">
              <Icon className="h-4 w-4 text-sol-text-muted" />
              <span>{currentOption.label}</span>
            </span>
            <ChevronDown className="h-3 w-3 opacity-50" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-[300px]">
          {TEAM_VISIBILITY_OPTIONS.map((option) => {
            const active = option.value === current;
            return (
              <DropdownMenuItem
                key={option.value}
                onClick={() => pick(option.value)}
                className={`items-start gap-3 py-2 ${active ? "bg-sol-bg-highlight/40" : ""}`}
              >
                <Check className={`mt-0.5 h-4 w-4 shrink-0 ${active ? "text-sol-cyan" : "opacity-0"}`} />
                <span className="min-w-0">
                  <span className="block text-sm text-sol-text">{option.label}</span>
                  <span className="block text-xs leading-snug text-sol-text-muted">{option.detail}</span>
                </span>
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={raiseTo !== null} onOpenChange={(open) => !open && setRaiseTo(null)}>
        <DialogContent className="bg-sol-bg border-sol-border sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="text-sol-text">Show {team.name} more?</DialogTitle>
            <DialogDescription className="text-sol-text-muted">
              Teammates in {team.name} see {currentOption.sees} today. With {raiseOption?.label}, {raiseOption ? lowerFirst(raiseOption.detail) : ""} Choose which sessions that applies to.
            </DialogDescription>
          </DialogHeader>
          {raiseTo && raiseOption && (
            <SettingsOptionGroup
              label="Which sessions"
              value=""
              onChange={(mode) => {
                apply(raiseTo, mode as VisibilityChangeMode);
                setRaiseTo(null);
              }}
              options={[
                {
                  value: "going_forward",
                  label: "Only new sessions",
                  description: `Sessions you start from now on show ${raiseOption.sees}. Everything before today stays at ${currentOption.label}.`,
                },
                {
                  value: "everything",
                  label: "All sessions, past and future",
                  description: `Teammates see ${raiseOption.sees} for every session you have shared with ${team.name}, including past ones.`,
                },
              ]}
              className="py-1"
            />
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setRaiseTo(null)}>Cancel</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

/** Plain words for the row under a team's name: who is on it and what flows to it. */
export function describeTeamSharing(team: TeamSharingFacts): string {
  const others = Math.max(0, (team.member_count ?? 1) - 1);
  const who = others === 0 ? "just you" : others === 1 ? "1 teammate" : `${others} teammates`;
  const projects = team.shared_project_count ?? 0;
  const what = projects === 0 ? "no projects shared yet" : projects === 1 ? "1 project shared" : `${projects} projects shared`;
  return `${who} · ${what}`;
}
