// One page of org.sessionsUnder (docs/architecture/org-roles.md S4): a per view
// query, not a registry feed. Lives in hooks/ so the page never names a query.
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { useQueryNoThrow } from "./useQueryNoThrow";
import type { OrgParentRef, OrgSession } from "../components/org/orgTypes";

const api = _api as any;

export type OrgSessionsPage = { sessions: OrgSession[]; next_cursor?: string };

export function useOrgSessionsUnder(args: { parent: OrgParentRef; team_id?: string; cursor?: string; limit: number } | "skip"): { data: OrgSessionsPage | undefined; error?: Error } {
  const { data, error } = useQueryNoThrow(api.org.sessionsUnder, args);
  return { data: data as OrgSessionsPage | undefined, error };
}
