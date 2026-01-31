"use client";

import { useQuery, useMutation } from "convex/react";
import { useRouter } from "next/navigation";
import { api } from "@codecast/convex/convex/_generated/api";
import { useActiveTeamStore } from "../store/activeTeamStore";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  DropdownMenuLabel,
} from "./ui/dropdown-menu";
import { Check, ChevronDown, Users, Plus, UserPlus } from "lucide-react";
import { useEffect } from "react";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";

export function TeamSwitcher() {
  const router = useRouter();
  const user = useQuery(api.users.getCurrentUser);
  const teams = useQuery(api.teams.getUserTeams);
  const setDefaultTeam = useMutation(api.teams.setDefaultTeam);
  const { activeTeamId, setActiveTeam } = useActiveTeamStore();

  useEffect(() => {
    if (user && !activeTeamId && user.default_team_id) {
      setActiveTeam(user.default_team_id);
    } else if (user && activeTeamId) {
      const isValidTeam = teams?.some(t => t?._id === activeTeamId);
      if (!isValidTeam && user.default_team_id) {
        setActiveTeam(user.default_team_id);
      } else if (!isValidTeam) {
        setActiveTeam(null);
      }
    }
  }, [user, teams, activeTeamId, setActiveTeam]);

  if (!user) {
    return null;
  }

  const activeTeam = teams?.find(t => t?._id === activeTeamId);

  const handleTeamChange = async (teamId: Id<"teams"> | null) => {
    setActiveTeam(teamId);
    await setDefaultTeam({ team_id: teamId ?? undefined });
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button className="flex items-center gap-1.5 px-2 py-1 rounded-md hover:bg-sol-base02/50 transition-colors text-sm">
          <Users className="w-4 h-4 text-sol-base1" />
          <span className="text-sol-text font-medium max-w-[120px] truncate">
            {activeTeam?.name || "Personal"}
          </span>
          <ChevronDown className="w-3.5 h-3.5 text-sol-base1" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56 bg-sol-bg border-sol-border">
        <DropdownMenuLabel className="text-sol-base1 text-xs">Switch Team</DropdownMenuLabel>
        <DropdownMenuItem
          onClick={() => handleTeamChange(null)}
          className="flex items-center justify-between cursor-pointer text-sol-text hover:bg-sol-base02/50"
        >
          <span>Personal</span>
          {!activeTeamId && <Check className="w-4 h-4 text-sol-cyan" />}
        </DropdownMenuItem>
        {teams && teams.length > 0 && (
          <>
            <DropdownMenuSeparator className="bg-sol-border" />
            {teams.map((team) => {
              if (!team) return null;
              return (
                <DropdownMenuItem
                  key={team._id}
                  onClick={() => handleTeamChange(team._id)}
                  className="flex items-center justify-between cursor-pointer text-sol-text hover:bg-sol-base02/50"
                >
                  <div className="flex items-center gap-2">
                    <span>{team.name}</span>
                    <span className="text-xs text-sol-base1">
                      {team.role === "admin" ? "Admin" : "Member"}
                    </span>
                  </div>
                  {activeTeamId === team._id && <Check className="w-4 h-4 text-sol-cyan" />}
                </DropdownMenuItem>
              );
            })}
          </>
        )}
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
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
