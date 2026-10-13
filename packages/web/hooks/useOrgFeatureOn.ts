// Whether the active workspace has the team feature `org` on: it gates the
// Org screen's conversation pane only (cohesive build spec D11). Goals,
// projects and people need no agents and show either way.
import { useWorkspaceFeature } from "../lib/teamFeatures";

export function useOrgFeatureOn(): boolean {
  return useWorkspaceFeature("org");
}
