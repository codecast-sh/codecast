import { useHostedMode } from "../lib/surfaces";
import { useRouter } from "next/navigation";
import { useInboxStore, isConvexId } from "../store/inboxStore";
import { useSwitchWorkspace } from "../hooks/useSwitchWorkspace";
import { useCurrentUser } from "../hooks/useCurrentUser";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  DropdownMenuLabel,
} from "./ui/dropdown-menu";
import { Check, ChevronDown, Plus, User, UserPlus } from "lucide-react";
import { useState, lazy, Suspense, forwardRef, type ButtonHTMLAttributes } from "react";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import { TeamCrest } from "./team/TeamCrest";
import { useSurface } from "../lib/surfaces";

const InviteModal = lazy(() => import("./InviteModal").then(m => ({ default: m.InviteModal })));

/** The picker's trigger: the workspace's crest (or the person glyph) and its name. */
export const TeamSwitcherButton = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { team?: { icon?: string; icon_color?: string } | null; label: string }
>(function TeamSwitcherButton({ team, label, ...props }, ref) {
  // Hosted mode marks a workspace by its initial, in ink, rather than a
  // team's chosen emoji, which read as developer flair beside the calm bar.
  const hosted = useHostedMode();
  return (
    <button ref={ref} {...props} className="flex h-7 items-center gap-1.5 pl-1 pr-1.5 rounded-md text-sm transition-colors hover:bg-sol-bg-alt data-[state=open]:bg-sol-bg-alt">
      {team && hosted ? (
        <span data-cc-team-initial aria-hidden className="flex h-5 w-5 items-center justify-center rounded bg-sol-bg-alt text-[11px] font-semibold text-sol-text">{label.trim().charAt(0).toUpperCase()}</span>
      ) : team ? (
        <TeamCrest icon={team.icon} color={team.icon_color} size="sm" className="w-5 h-5 rounded" />
      ) : (
        <User className="w-4 h-4 text-sol-base1" />
      )}
      <span className="text-sol-text font-medium max-w-[120px] truncate">{label}</span>
      <ChevronDown className="w-3.5 h-3.5 text-sol-base1" />
    </button>
  );
});

/**
 * The workspace picker. It switches the whole workspace (`useSwitchWorkspace`)
 * and by default shows the workspace the client is on. A surface whose data
 * answers for a team the server resolved (the integrations ledger, which falls
 * back to the home team when the client is on Personal) passes `value` so the
 * label names the team its content belongs to, and `teamsOnly` when Personal
 * is not a meaningful choice there.
 */
export function TeamSwitcher({
  value,
  teamsOnly = false,
}: {
  value?: string | null;
  teamsOnly?: boolean;
} = {}) {
  const router = useRouter();
  const { user } = useCurrentUser();
  const teams = useInboxStore((s) => s.teams);
  const switchWorkspace = useSwitchWorkspace();
  const activeTeamId = useInboxStore((s) => s.clientState.ui?.active_team_id) as Id<"teams"> | undefined;
  const [inviteOpen, setInviteOpen] = useState(false);
  const createShown = useSurface("topbar.createTeam");

  if (!user) {
    return null;
  }

  const shownTeamId = value === undefined ? activeTeamId : (value ?? undefined);
  const activeTeam = teams?.find(t => t?._id === shownTeamId);
  // Invite targets the ACTIVE team; only its admins see the item.
  // A just-created team carries an optimistic stub id until the server row
  // lands; inviting against it would 404 (or fall back to the previous team).
  const canInvite = !!activeTeam && activeTeam.role === "admin" && isConvexId(String(activeTeam._id));

  const handleTeamChange = async (teamId: Id<"teams"> | null) => {
    await switchWorkspace(teamId);
  };

  if (!teams || teams.length === 0) {
    if (!createShown) return null;
    return (
      <button
        onClick={() => router.push("/settings/team/create")}
        className="flex items-center gap-1.5 px-2 py-1 rounded-md hover:bg-sol-base02/50 transition-colors text-sm text-sol-cyan"
      >
        <Plus className="w-4 h-4" />
        <span className="font-medium">Create Team</span>
      </button>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <TeamSwitcherButton team={activeTeam} label={activeTeam?.name || (teamsOnly ? "Choose a team" : "Personal")} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56 bg-sol-bg border-sol-border">
        <DropdownMenuLabel className="text-sol-base1 text-xs">{teamsOnly ? "Team" : "Workspace"}</DropdownMenuLabel>
        {!teamsOnly && (
          <>
            <DropdownMenuItem
              onClick={() => handleTeamChange(null)}
              className="flex items-center justify-between cursor-pointer text-sol-text hover:bg-sol-base02/50"
            >
              <div className="flex items-center gap-2">
                <User className="w-4 h-4 text-sol-base1" />
                <span>Personal</span>
              </div>
              {!shownTeamId && <Check className="w-4 h-4 text-sol-cyan" />}
            </DropdownMenuItem>
            <DropdownMenuSeparator className="bg-sol-border" />
          </>
        )}
        {teams.map((team) => {
          if (!team) return null;
          return (
            <DropdownMenuItem
              key={team._id}
              onClick={() => handleTeamChange(team._id)}
              className="flex items-center justify-between cursor-pointer text-sol-text hover:bg-sol-base02/50"
            >
              <div className="flex items-center gap-2">
                <TeamCrest icon={team.icon} color={team.icon_color} size="sm" />
                <span>{team.name}</span>
              </div>
              {shownTeamId === team._id && <Check className="w-4 h-4 text-sol-cyan" />}
            </DropdownMenuItem>
          );
        })}
        <DropdownMenuSeparator className="bg-sol-border" />
        <DropdownMenuItem
          onClick={() => router.push("/settings/team/create")}
          className="flex items-center gap-2 cursor-pointer text-sol-cyan hover:bg-sol-base02/50"
        >
          <Plus className="w-4 h-4" />
          <span>Create Team</span>
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => router.push("/settings/team/join")}
          className="flex items-center gap-2 cursor-pointer text-sol-base1 hover:bg-sol-base02/50"
        >
          <UserPlus className="w-4 h-4" />
          <span>Join Team</span>
        </DropdownMenuItem>
        {canInvite && (
          <>
            <DropdownMenuSeparator className="bg-sol-border" />
            <DropdownMenuItem
              onClick={() => setInviteOpen(true)}
              className="flex items-center gap-2 cursor-pointer text-sol-base1 hover:bg-sol-base02/50"
            >
              <UserPlus className="w-4 h-4" />
              <span>Invite</span>
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
      {canInvite && (
        <Suspense fallback={null}>
          <InviteModal teamId={activeTeam._id} open={inviteOpen} onOpenChange={setInviteOpen} />
        </Suspense>
      )}
    </DropdownMenu>
  );
}
