import { useMutation } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import type { TeamVisibility } from "../../components/team/VisibilityPicker";
import { isMappedToTeam, type UserWorkspace } from "../../hooks/useTeamWorkspaceSuggestions";

type SetVisibility = (args: { team_id: Id<"teams">; visibility: TeamVisibility }) => Promise<unknown>;
type MapDirectory = (args: {
  path_prefix: string;
  team_id: Id<"teams">;
  auto_share: boolean;
}) => Promise<unknown>;

export type SaveTeamSetupInput = {
  teamId: Id<"teams">;
  visibility: TeamVisibility;
  /** path -> selected. Only true entries are mapped. */
  selectedPaths: Record<string, boolean>;
  /** The viewer's workspaces; paths already mapped to the team are skipped. */
  allProjects?: UserWorkspace[];
};

/**
 * Persist a member's team setup: their visibility on the team, then one
 * directory mapping per newly selected workspace. Returns how many mappings
 * were written so the caller can word its confirmation.
 */
export async function saveTeamSetup(
  input: SaveTeamSetupInput,
  mutations: { setTeamVisibility: SetVisibility; updateDirectoryMapping: MapDirectory },
): Promise<{ mapped: number }> {
  const { teamId, visibility, selectedPaths, allProjects } = input;
  await mutations.setTeamVisibility({ team_id: teamId, visibility });

  let mapped = 0;
  for (const [path, selected] of Object.entries(selectedPaths)) {
    if (!selected) continue;
    const ws = allProjects?.find((p) => p.path === path);
    if (ws && isMappedToTeam(ws, teamId)) continue;
    await mutations.updateDirectoryMapping({ path_prefix: path, team_id: teamId, auto_share: true });
    mapped++;
  }
  return { mapped };
}

/** Binds the two mutations so a component calls `save(input)` directly. */
export function useSaveTeamSetup() {
  const setTeamVisibility = useMutation(api.teams.setTeamVisibility);
  const updateDirectoryMapping = useMutation(api.users.updateDirectoryTeamMapping);
  return (input: SaveTeamSetupInput) =>
    saveTeamSetup(input, { setTeamVisibility, updateDirectoryMapping });
}
