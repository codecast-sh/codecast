// Org tree — store-fed singleton (docs/architecture/org-roles.md S6). Mirrors
// useSyncSessionThreads: the page paints from the cached snapshot; the feeder
// replaces it as the server recomputes. Scoped by the active team pointer
// (clientState.ui.active_team_id); absent = the personal workspace.
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore, isConvexId } from "../store/inboxStore";
import { useSyncCollection } from "./useSyncCollection";
import type { OrgTree } from "../components/org/orgTypes";

const api = _api as any;

/** Convex answers a query that isn't deployed with this exact text; the page
 *  treats it as "backend not shipped" and runs on the fixture. The generated
 *  `api` is a proxy that resolves ANY path, so this cannot be checked statically. */
export function isMissingFunctionError(error: Error | undefined): boolean {
  return !!error && /Could not find public function/i.test(error.message ?? "");
}

export function useSyncOrgTree(): { tree: OrgTree | null; ready: boolean; error?: Error; missing: boolean } {
  const activeTeamId = useInboxStore((s) => s.clientState.ui?.active_team_id);
  // A team stub id (createTeam in flight) is not a Convex id. Skip until it
  // resolves: falling back to `{}` would load the PERSONAL tree into the slot
  // and show the user's own org under the team they just created.
  const teamArg = !activeTeamId ? {} : isConvexId(activeTeamId) ? { team_id: activeTeamId } : "skip";
  const { ready, error } = useSyncCollection("orgTree", api.org.tree, teamArg);
  const tree = useInboxStore((s) => s.orgTree);
  return { tree, ready, error, missing: isMissingFunctionError(error) };
}
