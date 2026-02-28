"use client";

import { useQuery, useMutation } from "convex/react";
import { useRouter } from "next/navigation";
import { api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore } from "../store/inboxStore";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  DropdownMenuLabel,
} from "./ui/dropdown-menu";
import { Check, ChevronDown, Plus, UserPlus } from "lucide-react";
import { useEffect, useState, lazy, Suspense } from "react";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import { TeamIcon } from "./TeamIcon";

const InviteModal = lazy(() => import("./InviteModal").then(m => ({ default: m.InviteModal })));

export function TeamSwitcher() {
  const router = useRouter();
  const user = useQuery(api.users.getCurrentUser);
  const teams = useQuery(api.teams.getUserTeams);
  const saveActiveTeam = useMutation(api.teams.setActiveTeam);
  const activeTeamId = useInboxStore((s) => s.clientState.ui?.active_team_id) as Id<"teams"> | undefined;
  const updateClientUI = useInboxStore((s) => s.updateClientUI);
  const setActiveTeam = (id: Id<"teams"> | null) => updateClientUI({ active_team_id: id ?? undefined });
  const [inviteOpen, setInviteOpen] = useState(false);
  const isAdmin = user?.role === "admin";

  useEffect(() => {
    if (user && !activeTeamId && user.active_team_id) {
      setActiveTeam(user.active_team_id);
    } else if (user && activeTeamId) {
      const isValidTeam = teams?.some(t => t?._id === activeTeamId);
      if (!isValidTeam && user.active_team_id) {
        setActiveTeam(user.active_team_id);
      } else if (!isValidTeam && teams && teams.length > 0) {
        setActiveTeam(teams[0]?._id ?? null);
      }
    } else if (user && !activeTeamId && teams && teams.length > 0) {
      setActiveTeam(teams[0]?._id ?? null);
    }
  }, [user, teams, activeTeamId, setActiveTeam]);

  if (!user) {
    return null;
  }

  const activeTeam = teams?.find(t => t?._id === activeTeamId);

  const handleTeamChange = async (teamId: Id<"teams">) => {
    setActiveTeam(teamId);
    await saveActiveTeam({ team_id: teamId });
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
        <button className="flex items-center gap-1.5 px-2 py-1 rounded-md hover:bg-sol-base02/50 transition-colors text-sm">
          <TeamIcon icon={activeTeam?.icon} color={activeTeam?.icon_color} className="w-4 h-4" />
          <span className="text-sol-text font-medium max-w-[120px] truncate">
            {activeTeam?.name || "Select Team"}
          </span>
          <ChevronDown className="w-3.5 h-3.5 text-sol-base1" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56 bg-sol-bg border-sol-border">
        <DropdownMenuLabel className="text-sol-base1 text-xs">Switch Team</DropdownMenuLabel>
        {teams.map((team) => {
          if (!team) return null;
          return (
            <DropdownMenuItem
              key={team._id}
              onClick={() => handleTeamChange(team._id)}
              className="flex items-center justify-between cursor-pointer text-sol-text hover:bg-sol-base02/50"
            >
              <div className="flex items-center gap-2">
                <TeamIcon icon={team.icon} color={team.icon_color} className="w-4 h-4" />
                <span>{team.name}</span>
                <span className="text-xs text-sol-base1">
                  {team.role === "admin" ? "Admin" : "Member"}
                </span>
              </div>
              {activeTeamId === team._id && <Check className="w-4 h-4 text-sol-cyan" />}
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
        {isAdmin && (
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
      {isAdmin && (
        <Suspense fallback={null}>
          <InviteModal open={inviteOpen} onOpenChange={setInviteOpen} />
        </Suspense>
      )}
    </DropdownMenu>
  );
}
