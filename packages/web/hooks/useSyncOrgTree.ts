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

// The team argument both feeders share. Web reads the mirrored pointer.
// Mobile switches teams through users.active_team_id alone and never writes
// the mirror, so it hands over the canonical pointer instead (null = the
// personal workspace). A team stub id (createTeam in flight) is not a Convex
// id: skip until it resolves, because falling back to `{}` would load the
// PERSONAL org into the slot under the team just created.
function useOrgTeamArg(canonicalTeamId?: string | null, enabled = true): Record<string, string> | "skip" {
  const mirroredTeamId = useInboxStore((s) => s.clientState.ui?.active_team_id);
  const activeTeamId = canonicalTeamId === undefined ? mirroredTeamId : canonicalTeamId;
  if (!enabled) return "skip";
  return !activeTeamId ? {} : isConvexId(activeTeamId) ? { team_id: activeTeamId } : "skip";
}

function useOrgFeed(query: any, canonicalTeamId?: string | null, enabled = true) {
  const { ready, error, refused, retry } = useSyncCollection("orgTree", query, useOrgTeamArg(canonicalTeamId, enabled));
  return { ready, error, missing: isMissingFunctionError(error), refused, retry };
}

/** The feeder alone, for a surface that only NAMES roles (an owner chip, the
 *  role picker, the task board, the inbox): it subscribes to org.roles, which
 *  reads roles and seats and no session, so it re-runs only when the org
 *  changes. Read the roles with useOrgRoles. A surface that draws sessions,
 *  counts or a standing agent's live state uses useSyncOrgTree instead.
 *  `enabled` false skips the subscription (a workspace with Org off). */
export function useSyncOrgTreeFeeder(canonicalTeamId?: string | null, enabled = true): { ready: boolean; error?: Error; missing: boolean; refused: boolean; retry: () => void } {
  return useOrgFeed(api.org.roles, canonicalTeamId, enabled);
}

/** The full tree feeder (org.tree): people, per role sessions and counts, and
 *  the standing agents' live state. It re-runs on every session write in the
 *  workspace, so only surfaces that draw those mount it. */
export function useSyncOrgTreeFull(canonicalTeamId?: string | null): { ready: boolean; error?: Error; missing: boolean; refused: boolean; retry: () => void } {
  return useOrgFeed(api.org.tree, canonicalTeamId);
}

export function useSyncOrgTree(): { tree: OrgTree | null; ready: boolean; error?: Error; missing: boolean; refused: boolean; retry: () => void } {
  const state = useSyncOrgTreeFull();
  const tree = useInboxStore((s) => s.orgTree);
  return { tree, ...state };
}
