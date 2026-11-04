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
import { workspaceFeatureEnabled, type TeamFeatureKey } from "@codecast/shared/contracts";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import { TeamCrest } from "./team/TeamCrest";

const InviteModal = lazy(() => import("./InviteModal").then(m => ({ default: m.InviteModal })));

/** The picker's trigger: the workspace's crest (or the person glyph) and its name. */
export const TeamSwitcherButton = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { team?: { icon?: string; icon_color?: string } | null; label: string; elsewhereUnread?: number }
>(function TeamSwitcherButton({ team, label, elsewhereUnread = 0, ...props }, ref) {
  return (
    <button ref={ref} {...props} className="flex h-7 items-center gap-1.5 pl-1 pr-1.5 rounded-md text-sm transition-colors hover:bg-sol-bg-alt data-[state=open]:bg-sol-bg-alt">
      {team ? (
        <TeamCrest icon={team.icon} color={team.icon_color} size="sm" className="w-5 h-5 rounded" />
      ) : (
        <User className="w-4 h-4 text-sol-base1" />
      )}
      <span data-cc-team-label className="text-sol-text font-medium max-w-[120px] truncate">{label}</span>
      {/* Unread in a workspace NOT on screen: a dot on the chevron, so it
          never reads as this workspace's own count. The menu names where. */}
      <span className="relative flex">
        <ChevronDown className="w-3.5 h-3.5 text-sol-base1" />
        {elsewhereUnread > 0 && (
          <span
            data-cc-team-elsewhere
            title={`${elsewhereUnread} unread in other workspaces`}
            className="absolute -right-0.5 -top-1 h-2 w-2 rounded-full bg-sol-orange ring-2 ring-sol-bg"
          />
        )}
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
  // The workspace under the pointer, previewed in the scope legend; undefined
  // while nothing is hovered, null for Personal.
  const [previewId, setPreviewId] = useState<string | null | undefined>(undefined);
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
    <DropdownMenu onOpenChange={(open) => { if (!open) setPreviewId(undefined); }}>
      <DropdownMenuTrigger asChild>
        <TeamSwitcherButton
          team={activeTeam}
          label={activeTeam?.name || (teamsOnly ? "Choose a team" : "Personal")}
          elsewhereUnread={teamsOnly ? 0 : elsewhereUnread}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-80 bg-sol-bg border-sol-border p-1">
        <DropdownMenuLabel className="text-sol-base1 text-xs px-2 pt-1.5 pb-1">{teamsOnly ? "Team" : "Workspace"}</DropdownMenuLabel>
        {!teamsOnly && (
          <WorkspaceRow
            selected={!shownTeamId}
            icon={<span className="flex h-6 w-6 items-center justify-center rounded bg-sol-bg-alt"><User className="w-3.5 h-3.5 text-sol-base1" /></span>}
            name="Personal"
            detail="Just you"
            unread={shownTeamId ? unreadFor(null) : 0}
            onSelect={() => handleTeamChange(null)}
            onPreview={() => setPreviewId(null)}
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
              onPreview={() => setPreviewId(String(team._id))}
            />
          );
        })}
        {!teamsOnly && <ScopeLegend teams={teams} workspaceId={previewId === undefined ? (shownTeamId ? String(shownTeamId) : null) : previewId} />}
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
 *  your threads in it have unseen replies. Hovering it previews its scope in
 *  the legend below. */
function WorkspaceRow({ selected, icon, name, detail, unread, onSelect, onPreview }: {
  selected: boolean;
  icon: ReactNode;
  name: string;
  detail: string;
  unread: number;
  onSelect: () => void;
  onPreview: () => void;
}) {
  return (
    <DropdownMenuItem
      onClick={onSelect}
      onFocus={onPreview}
      onPointerEnter={onPreview}
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

// What the picker changes and what it leaves alone, as the app scopes today:
// these pages read the active workspace; the inbox and the queues read all of
// them. Kept here beside the control that the split belongs to.
const SWITCHED = ["Tasks", "Plans", "Docs", "Projects", "People", "Chat"];
const EVERYWHERE = ["Inbox", "Decisions", "Notifications"];
const TEAM_ONLY: Array<[TeamFeatureKey, string]> = [["chat", "Chat"], ["calls", "Calls"], ["changes", "Changes"]];

/** The scope of the workspace under the pointer (or the current one): which
 *  pages it filters, which always show every workspace, and which are off. */
function ScopeLegend({ teams, workspaceId }: { teams: any[]; workspaceId: string | null }) {
  const off = TEAM_ONLY.filter(([key]) => !workspaceFeatureEnabled(teams, workspaceId, key)).map(([, label]) => label);
  const name = workspaceId ? teams.find((t) => String(t?._id) === workspaceId)?.name ?? "this team" : "Personal";
  return (
    <div data-cc-scope-legend className="mx-1 mt-1 mb-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-md bg-sol-bg-alt/60 px-2.5 py-2 text-[11px] leading-snug">
      <span className="text-sol-text-dim">Filters</span>
      <span className="text-sol-text">{SWITCHED.filter((p) => !off.includes(p)).join(" · ")}</span>
      <span className="text-sol-text-dim">Always all</span>
      <span className="text-sol-text">{EVERYWHERE.join(" · ")}</span>
      {off.length > 0 && (
        <>
          <span className="text-sol-text-dim">Off in {name}</span>
          <span className="text-sol-text-dim">{off.join(" · ")}</span>
        </>
      )}
    </div>
  );
}
