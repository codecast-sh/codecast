import { useMemo } from "react";
import { useQuery } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import type { TeamVisibility } from "../lib/team/visibilityLevels";

export type SuggestedWorkspace = {
  path: string;
  git_remote_url: string | null;
  session_count: number;
  last_active: number;
  matched_member_count: number;
  match_type: "github" | "repo_name";
  match_reason: string;
  current_team_id: Id<"teams"> | null;
};

export type TeamOnlyRepo = {
  repo_key: string;
  repo_name: string;
  member_count: number;
};

export type TeamSuggestionsResult = {
  team_id: Id<"teams">;
  team_name: string;
  team_icon?: string | null;
  team_icon_color?: string | null;
  current_visibility: TeamVisibility;
  suggestions: SuggestedWorkspace[];
  team_only_repos: TeamOnlyRepo[];
};

export type UserWorkspace = {
  path: string;
  is_git_repo: boolean;
  git_remote_url?: string;
  session_count: number;
  last_active: number;
  team_id: Id<"teams"> | null;
  auto_share: boolean;
};

/** True when the workspace already flows to this team. */
export function isMappedToTeam(ws: UserWorkspace, teamId: Id<"teams"> | null): boolean {
  return !!teamId && ws.team_id?.toString() === teamId.toString() && ws.auto_share;
}

/**
 * The two reads behind the workspace share step: what teammates already share
 * for this team, and the viewer's own recent workspaces. Both are one shot
 * setup queries, not registered feeds, so a plain subscription is right here.
 * `allProjects` stays undefined until the server answers; pickers use that for
 * the loading state.
 */
export function useTeamWorkspaceSuggestions(teamId: Id<"teams"> | null) {
  const suggestions = useQuery(
    api.users.getSuggestedTeamProjects,
    teamId ? { team_id: teamId } : "skip",
  ) as TeamSuggestionsResult | null | undefined;

  const allProjects = useQuery(
    api.users.getRecentProjectsWithGitInfo,
    teamId ? { limit: 100 } : "skip",
  ) as UserWorkspace[] | undefined;

  const suggestedPaths = useMemo(
    () => new Set(suggestions?.suggestions.map((s) => s.path) ?? []),
    [suggestions?.suggestions],
  );

  const { matched, other } = useMemo(() => {
    const matched: UserWorkspace[] = [];
    const other: UserWorkspace[] = [];
    for (const p of allProjects ?? []) {
      (suggestedPaths.has(p.path) ? matched : other).push(p);
    }
    return { matched, other };
  }, [allProjects, suggestedPaths]);

  return {
    suggestions,
    allProjects,
    suggestedPaths,
    matched,
    other,
    teamName: suggestions?.team_name || "your team",
    teamOnlyRepos: suggestions?.team_only_repos ?? [],
    getSuggestion: (path: string) => suggestions?.suggestions.find((s) => s.path === path),
  };
}

export type TeamWorkspaceSuggestions = ReturnType<typeof useTeamWorkspaceSuggestions>;
