import { useEffect, useMemo, useRef, useState } from "react";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import {
  isMappedToTeam,
  type TeamWorkspaceSuggestions,
  type UserWorkspace,
} from "./useTeamWorkspaceSuggestions";

/** Initial selection: workspaces teammates already share, plus those already
 *  mapped to this team. Pure so the create flow can reseed after the team id
 *  swaps from a stub to the real row. */
export function seedWorkspaceSelection(
  allProjects: UserWorkspace[],
  suggestedPaths: Set<string>,
  teamId: Id<"teams"> | null,
): Record<string, boolean> {
  const initial: Record<string, boolean> = {};
  for (const p of allProjects) {
    initial[p.path] = suggestedPaths.has(p.path) || isMappedToTeam(p, teamId);
  }
  return initial;
}

/** Owns the selected set for a share picker and reseeds it whenever the
 *  suggestion data or the target team changes. Lives in hooks/ so the picker
 *  component stays a clean Fast Refresh boundary. */
export function useWorkspaceSelection(
  data: Pick<TeamWorkspaceSuggestions, "allProjects" | "suggestedPaths">,
  teamId: Id<"teams"> | null,
) {
  const { allProjects, suggestedPaths } = data;
  const [selectedPaths, setSelectedPaths] = useState<Record<string, boolean>>({});

  // Reseed only when the SEED CONTENT changes, not on every new query ref.
  // The workspace query is live and `last_active` churns while sessions run,
  // so a ref-keyed effect would wipe the user's toggles seconds after they
  // make them.
  const seed = useMemo(
    () => (allProjects ? seedWorkspaceSelection(allProjects, suggestedPaths, teamId) : null),
    [allProjects, suggestedPaths, teamId],
  );
  const seedSig = seed
    ? Object.keys(seed).sort().map((p) => `${p}:${seed[p] ? 1 : 0}`).join("|")
    : null;
  const seedRef = useRef(seed);
  seedRef.current = seed;
  useEffect(() => {
    if (seedRef.current) setSelectedPaths(seedRef.current);
  }, [seedSig]);

  const toggle = (path: string) =>
    setSelectedPaths((prev) => ({ ...prev, [path]: !prev[path] }));
  const selectedCount = Object.values(selectedPaths).filter(Boolean).length;
  return { selectedPaths, toggle, selectedCount };
}
