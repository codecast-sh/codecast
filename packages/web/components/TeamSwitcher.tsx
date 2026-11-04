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
import { Check, ChevronDown, LogIn, Plus, User, UserPlus } from "lucide-react";
import { useState, lazy, Suspense, forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import { TeamCrest } from "./team/TeamCrest";

const InviteModal = lazy(() => import("./InviteModal").then(m => ({ default: m.InviteModal })));

/** The picker's trigger: the workspace's crest (or the person glyph) and its
 *  name. In the rail it is the header of the workspace's block of pages, so it
 *  spans the rail's width; narrow, it is the crest alone. */
export const TeamSwitcherButton = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & {
    team?: { icon?: string; icon_color?: string } | null;
    label: string;
    elsewhereUnread?: number;
    variant?: "bar" | "rail";
    isNarrow?: boolean;
  }
>(function TeamSwitcherButton({ team, label, elsewhereUnread = 0, variant = "bar", isNarrow = false, ...props }, ref) {
  const rail = variant === "rail";
  const crest = team ? (
    <TeamCrest icon={team.icon} color={team.icon_color} size="sm" className="w-5 h-5 rounded" />
  ) : (
    <span className="flex h-5 w-5 items-center justify-center"><User className="w-4 h-4 text-sol-base1" /></span>
  );
  // Unread in a workspace NOT on screen: a dot, so it never reads as this
  // workspace's own count. The menu names where.
  const dot = elsewhereUnread > 0 && (
    <span
      data-cc-team-elsewhere
      title={`${elsewhereUnread} unread in other workspaces`}
      className="absolute -right-0.5 -top-1 h-2 w-2 rounded-full bg-sol-orange ring-2 ring-sol-bg"
    />
  );
  if (rail && isNarrow) {
    return (
      <button ref={ref} {...props} title={label} className="relative flex w-full justify-center py-2.5 transition-colors hover:bg-sol-bg-alt data-[state=open]:bg-sol-bg-alt">
        <span className="relative flex">{crest}{dot}</span>
      </button>
    );
  }
  return (
    <button
      ref={ref}
      {...props}
      data-cc-team-trigger={variant}
      className={rail
        ? "flex w-full items-center gap-3 px-4 py-2 text-sm text-left transition-colors hover:bg-sol-bg-alt/70 data-[state=open]:bg-sol-bg-alt/70"
        : "flex h-7 items-center gap-1.5 pl-1 pr-1.5 rounded-md text-sm transition-colors hover:bg-sol-bg-alt data-[state=open]:bg-sol-bg-alt"}
    >
      {crest}
      <span data-cc-team-label className={`text-sol-text font-semibold truncate ${rail ? "flex-1" : "max-w-[120px]"}`}>{label}</span>
      <span className="relative flex">
        <ChevronDown className="w-3.5 h-3.5 text-sol-base1" />
        {dot}
      </span>
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
  variant = "bar",
  isNarrow = false,
}: {
  value?: string | null;
  teamsOnly?: boolean;
  /** "rail": the header of the sidebar's workspace block. */
  variant?: "bar" | "rail";
  isNarrow?: boolean;
} = {}) {
  const router = useRouter();
  const { user } = useCurrentUser();
  const teams = useInboxStore((s) => s.teams);
  const switchWorkspace = useSwitchWorkspace();
  const activeTeamId = useInboxStore((s) => s.clientState.ui?.active_team_id) as Id<"teams"> | undefined;
  const [inviteOpen, setInviteOpen] = useState(false);
  const unreadElsewhere = useInboxStore((s) => s.threadUnreadByWorkspace);
  const unreadFor = (teamId: string | null) => unreadElsewhere?.find((w) => w.team_id === teamId)?.count ?? 0;

  if (!user) {
    return null;
  }

  const shownTeamId = value === undefined ? activeTeamId : (value ?? undefined);
  // The server already leaves the active workspace out; the filter covers the
  // moment after a switch, before its answer for the new one lands.
  const elsewhereUnread = (unreadElsewhere ?? [])
    .filter((w) => w.team_id !== (activeTeamId ? String(activeTeamId) : null))
    .reduce((n, w) => n + w.count, 0);
  const activeTeam = teams?.find(t => t?._id === shownTeamId);
  // Invite targets the ACTIVE team; only its admins see the item.
  // A just-created team carries an optimistic stub id until the server row
  // lands; inviting against it would 404 (or fall back to the previous team).
  const canInvite = !!activeTeam && activeTeam.role === "admin" && isConvexId(String(activeTeam._id));

  const handleTeamChange = async (teamId: Id<"teams"> | null) => {
    await switchWorkspace(teamId);
  };

  if (!teams || teams.length === 0) {
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
        <TeamSwitcherButton
          team={activeTeam}
          label={activeTeam?.name || (teamsOnly ? "Choose a team" : "Personal")}
          elsewhereUnread={teamsOnly ? 0 : elsewhereUnread}
          variant={variant}
          isNarrow={isNarrow}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side={variant === "rail" && isNarrow ? "right" : "bottom"} className="w-80 bg-sol-bg border-sol-border p-1">
        <DropdownMenuLabel className="text-sol-base1 text-xs px-2 pt-1.5 pb-1">{teamsOnly ? "Team" : "Workspace"}</DropdownMenuLabel>
        {!teamsOnly && (
          <WorkspaceRow
            selected={!shownTeamId}
            icon={<span className="flex h-6 w-6 items-center justify-center rounded bg-sol-bg-alt"><User className="w-3.5 h-3.5 text-sol-base1" /></span>}
            name="Personal"
            detail="Just you"
            unread={shownTeamId ? unreadFor(null) : 0}
            onSelect={() => handleTeamChange(null)}
          />
        )}
        {teams.map((team) => {
          if (!team) return null;
          const members = (team as any).member_count as number | undefined;
          return (
            <WorkspaceRow
              key={team._id}
              selected={shownTeamId === team._id}
              icon={<TeamCrest icon={team.icon} color={team.icon_color} size="sm" className="w-6 h-6 rounded" />}
              name={team.name}
              detail={members ? `${members} ${members === 1 ? "member" : "members"}` : ""}
              unread={shownTeamId === team._id ? 0 : unreadFor(String(team._id))}
              onSelect={() => handleTeamChange(team._id)}
            />
          );
        })}
        <DropdownMenuSeparator className="bg-sol-border/60" />
        <div className="flex items-center gap-1 px-1 py-0.5">
          <DropdownMenuItem
            onClick={() => router.push("/settings/team/create")}
            className="flex flex-1 items-center justify-center gap-1.5 whitespace-nowrap cursor-pointer text-xs text-sol-cyan hover:bg-sol-base02/50"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Create team</span>
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => router.push("/settings/team/join")}
            className="flex flex-1 items-center justify-center gap-1.5 whitespace-nowrap cursor-pointer text-xs text-sol-base1 hover:bg-sol-base02/50"
          >
            <LogIn className="w-3.5 h-3.5" />
            <span>Join team</span>
          </DropdownMenuItem>
          {canInvite && (
            <DropdownMenuItem
              onClick={() => setInviteOpen(true)}
              className="flex flex-1 items-center justify-center gap-1.5 whitespace-nowrap cursor-pointer text-xs text-sol-base1 hover:bg-sol-base02/50"
            >
              <UserPlus className="w-3.5 h-3.5" />
              <span className="truncate">Invite</span>
            </DropdownMenuItem>
          )}
        </div>
      </DropdownMenuContent>
      {canInvite && (
        <Suspense fallback={null}>
          <InviteModal teamId={activeTeam._id} open={inviteOpen} onOpenChange={setInviteOpen} />
        </Suspense>
      )}
    </DropdownMenu>
  );
}

/** One workspace in the picker: its mark, name, who is in it, and how many of
 *  your threads in it have unseen replies. */
function WorkspaceRow({ selected, icon, name, detail, unread, onSelect }: {
  selected: boolean;
  icon: ReactNode;
  name: string;
  detail: string;
  unread: number;
  onSelect: () => void;
}) {
  return (
    <DropdownMenuItem
      onClick={onSelect}
      data-selected={selected || undefined}
      className="flex items-center gap-2.5 px-2 py-1.5 cursor-pointer text-sol-text hover:bg-sol-base02/50 data-[selected]:bg-sol-bg-alt"
    >
      {icon}
      <span className="flex min-w-0 flex-1 flex-col leading-tight">
        <span className={`truncate ${selected ? "font-medium" : ""}`}>{name}</span>
        {detail && <span className="truncate text-[11px] text-sol-text-dim">{detail}</span>}
      </span>
      {unread > 0 && (
        <span
          title={`${unread} unread ${unread === 1 ? "thread" : "threads"}`}
          className="min-w-[18px] rounded-full bg-sol-orange px-1.5 text-center text-[10px] font-semibold leading-[18px] text-sol-bg"
        >
          {unread > 99 ? "99+" : unread}
        </span>
      )}
      {selected && <Check className="w-4 h-4 shrink-0 text-sol-cyan" />}
    </DropdownMenuItem>
  );
}
