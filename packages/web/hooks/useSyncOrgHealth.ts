// Org health — store-fed singleton (docs/architecture/org-staffing.md S3).
// Mirrors useSyncOrgTree: the staffing pane paints the flags from the cached
// snapshot; the feeder replaces it as the server recomputes. Scoped by the
// active team pointer; absent = the personal workspace.
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore, isConvexId } from "../store/inboxStore";
import { useSyncCollection } from "./useSyncCollection";
import { isMissingFunctionError } from "./useSyncOrgTree";
import type { OrgHealth } from "../components/org/orgStaffingTypes";

const api = _api as any;

export function useSyncOrgHealth(enabled = true): { health: OrgHealth | null; ready: boolean; error?: Error; missing: boolean } {
  const activeTeamId = useInboxStore((s) => s.clientState.ui?.active_team_id);
  const teamArg = !enabled ? "skip" : !activeTeamId ? {} : isConvexId(activeTeamId) ? { team_id: activeTeamId } : "skip";
  const { ready, error } = useSyncCollection("orgHealth", api.org.health, teamArg);
  const health = useInboxStore((s) => s.orgHealth);
  return { health, ready, error, missing: isMissingFunctionError(error) };
}
