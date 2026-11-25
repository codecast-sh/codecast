// Which workspace a session belongs to for priorities, and whether a team may
// list it: the ONE predicate the pass (priorityPassRun.ts) and the API
// (priorities.ts) decide team-workspace questions with.
//
// A session is listed to a team when its owner is still a member, lists their
// sessions to that team at all (privacy.listsSessionsToTeam, the team session
// list's rule), and the team may read at least its summary at the level the
// owner shared when it started (privacy.teamReadLevelSync over
// effectiveMembershipVisibility). That last read is what keeps a locked-private
// session out even when it was auto-shared, where the policy team
// (teamVisibleConvTeam) would still name the team. A workflow's run log is never
// listed (isRunLog, as the team floor leaves it out). A session listed to no team
// is its owner's personal work.
//
// Leaf: reads rows, defines no functions.
import { isRunLog } from "@codecast/shared/contracts";
import type { Doc, Id } from "../_generated/dataModel";
import { getOwnerMembership, listsSessionsToTeam, teamReadLevelSync } from "../privacy";
import { currentMembershipVisibility, effectiveMembershipVisibility, type MembershipVisibilityFacts } from "../teamVisibility";

type Session = Pick<Doc<"conversations">, "user_id" | "team_id" | "is_private" | "team_visibility" | "started_at" | "is_workflow_primary" | "workflow_run_id">;

/** Pure: the session listed to `teamId`, given its owner's account and their membership there (absent when not a member). */
export function sessionListedToTeam(
  conv: Session,
  teamId: Id<"teams"> | string,
  owner: { activity_visibility?: string | null } | null,
  membership: MembershipVisibilityFacts | null | undefined,
): boolean {
  if (!membership || !conv.team_id || String(conv.team_id) !== String(teamId) || isRunLog(conv)) return false;
  if (!listsSessionsToTeam(owner, currentMembershipVisibility(membership))) return false;
  return teamReadLevelSync(conv, effectiveMembershipVisibility(membership, conv.started_at)) !== "none";
}

export type SessionVisibility = {
  /** The session listed to this team. */
  listedTo: (conv: Session, teamId: Id<"teams"> | string) => Promise<boolean>;
  /** The workspace key the session counts in: its team's when listed there, else its owner's personal one. */
  workspaceOf: (conv: Session) => Promise<string>;
};

/** The reader for one call: each owner's account and membership are read once. */
export function sessionVisibility(ctx: { db: any }): SessionVisibility {
  const owners = new Map<string, Promise<any>>();
  const memberships = new Map<string, Promise<MembershipVisibilityFacts | null | undefined>>();
  const listedTo = async (conv: Session, teamId: Id<"teams"> | string) => {
    if (!conv.team_id || String(conv.team_id) !== String(teamId)) return false;
    const owner = String(conv.user_id);
    const key = `${owner}|${teamId}`;
    if (!owners.has(owner)) owners.set(owner, ctx.db.get(conv.user_id));
    if (!memberships.has(key)) memberships.set(key, getOwnerMembership(ctx, conv.user_id, conv.team_id));
    return sessionListedToTeam(conv, teamId, await owners.get(owner), await memberships.get(key));
  };
  return {
    listedTo,
    workspaceOf: async (conv) => (conv.team_id && (await listedTo(conv, conv.team_id)) ? `team:${conv.team_id}` : `user:${conv.user_id}`),
  };
}
