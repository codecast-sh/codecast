// The scope page's three per view queries (docs/architecture/scopes-and-feed.md
// F2, F3; org-roles-standing.md T2). Per view, not registry feeds: a role's
// feed page, its board counts and its brief belong to the page that shows them,
// like org.sessionsUnder. Hooks live here so the page never names a query.
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { useQueryNoThrow } from "./useQueryNoThrow";
import { isMissingFunctionError } from "./useSyncOrgTree";
import type { FeedKind, FeedPage, RoleBrief, ScopeSummary } from "../components/org/scope/scopeTypes";

const api = _api as any;

/** Which scope a query reads: a role by id, or a literal set of projects and plans. */
export type ScopeRef = { role_id: string } | { scope: { project_ids: string[]; plan_ids: string[] }; team_id?: string };

export function useScopeFeedPage(args: (ScopeRef & { cursor?: string; limit?: number; kinds?: FeedKind[] }) | "skip"): { data: FeedPage | undefined; error?: Error; missing: boolean } {
  const { data, error } = useQueryNoThrow(api.org.scopeFeed, args);
  return { data: data as FeedPage | undefined, error, missing: isMissingFunctionError(error) };
}

export function useScopeSummary(args: ScopeRef | "skip"): { data: ScopeSummary | null | undefined; error?: Error; missing: boolean } {
  const { data, error } = useQueryNoThrow(api.org.scopeSummary, args);
  return { data: data as ScopeSummary | null | undefined, error, missing: isMissingFunctionError(error) };
}

export function useRoleBrief(roleId: string | null): { data: RoleBrief | null | undefined; error?: Error; missing: boolean } {
  const { data, error } = useQueryNoThrow(api.org.brief, roleId ? { role_id: roleId } : "skip");
  return { data: data as RoleBrief | null | undefined, error, missing: isMissingFunctionError(error) };
}
