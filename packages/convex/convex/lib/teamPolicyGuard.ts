// The team POLICY guard, a leaf module like teamFeatureGuard: it reads a
// team's managed policy (teams.policy, set in Team settings > Managed devices)
// and the device a request comes from, and imports nothing from ./functions,
// so cloudPlacement, publicShare and the http actions can all import it.
//
// A restriction applies to a request when either
//   - the row it touches lives in the team's workspace, or
//   - the request comes from a device enrolled in the team (devices.enrolled_team_id),
//     identified by the device its api token is bound to.
// Browser and desktop control are device-only restrictions: the daemon applies
// them from the heartbeat's team_policy, and nothing on the server gates them.
import type { Id } from "../_generated/dataModel";
import { accessError, findTokenDoc, splitPresentedToken } from "@platform/auth/convex";
import {
  parseTeamPolicy,
  policyBlockedMessage,
  policyBlocks,
  type HeartbeatTeamPolicy,
  type TeamPolicy,
  type TeamPolicyKey,
} from "@codecast/shared/contracts";
import { parseWorkspaceKey } from "./accessKeys";
import { teamVisibleConvTeam } from "../privacy";

type DbCtx = { db: any };
type RestrictionKey = Extract<TeamPolicyKey, `${string}_disabled`>;

/** A live team's stored policy, parsed; null for a missing or deleted team. */
export async function teamPolicyOf(
  ctx: DbCtx,
  teamId: Id<"teams"> | null | undefined,
): Promise<{ team_id: Id<"teams">; team_name: string; policy: TeamPolicy } | null> {
  if (!teamId) return null;
  const team = await ctx.db.get(teamId);
  if (!team || team.deleted_at) return null;
  return { team_id: team._id, team_name: team.name, policy: parseTeamPolicy(team.policy) };
}

/** What the heartbeat sends a device enrolled in `teamId`. */
export async function heartbeatTeamPolicy(
  ctx: DbCtx,
  teamId: Id<"teams"> | null | undefined,
): Promise<HeartbeatTeamPolicy | null> {
  const p = await teamPolicyOf(ctx, teamId);
  return p ? { team_id: String(p.team_id), team_name: p.team_name, policy: p.policy, enrolled: true } : null;
}

/**
 * The team the presenting device is enrolled in. The device is the one the
 * token is bound to; an unbound (older) token falls back to the device the
 * client presented beside it.
 */
export async function enrolledTeamForToken(ctx: DbCtx, apiToken: string | null | undefined): Promise<Id<"teams"> | null> {
  if (!apiToken) return null;
  const doc = await findTokenDoc(ctx, apiToken);
  if (!doc) return null;
  const deviceId = doc.device_id ?? splitPresentedToken(apiToken).deviceId;
  if (!deviceId) return null;
  const device = await ctx.db
    .query("devices")
    .withIndex("by_user_device", (q: any) => q.eq("user_id", doc.user_id).eq("device_id", deviceId))
    .first();
  return device?.enrolled_team_id ?? null;
}

/** The team a device's first heartbeat records (its row did not exist when
 *  the enrollment completed): its active enrollment for this person. */
export async function activeEnrollmentTeam(ctx: { db: any }, userId: Id<"users">, deviceId: string): Promise<Id<"teams"> | undefined> {
  const rows = await ctx.db
    .query("device_enrollments")
    .withIndex("by_device", (q: any) => q.eq("device_id", deviceId))
    .collect();
  const active = rows
    .filter((r: any) => r.status === "active" && r.user_id === userId)
    .sort((a: any, b: any) => (b.enrolled_at ?? 0) - (a.enrolled_at ?? 0))[0];
  return active?.team_id;
}

/** The workspace key a row answers to for policy: its stored key, else its
 *  team tag. A conversation has no key; its team is the one it is visible to. */
export function policyWorkspaceOf(table: string, row: any): string | null {
  if (!row) return null;
  if (table === "conversations") {
    const teamId = teamVisibleConvTeam(row);
    return teamId ? `team:${teamId}` : null;
  }
  if (typeof row.workspace === "string" && row.workspace) return row.workspace;
  return row.team_id ? `team:${row.team_id}` : null;
}

/** Where a request stands: the workspace of the row it touches and the token it came with. */
export type PolicyScope = { workspace?: string | null; apiToken?: string | null };

/** The team whose policy turns `key` off for this request, if any. */
export async function teamPolicyBlocker(
  ctx: DbCtx,
  scope: PolicyScope,
  key: RestrictionKey,
): Promise<{ team_id: Id<"teams">; team_name: string } | null> {
  const teamIds: Id<"teams">[] = [];
  const ws = parseWorkspaceKey(scope.workspace);
  if (ws?.type === "team") teamIds.push(ws.teamId);
  const enrolled = await enrolledTeamForToken(ctx, scope.apiToken);
  if (enrolled && !teamIds.includes(enrolled)) teamIds.push(enrolled);
  for (const teamId of teamIds) {
    const p = await teamPolicyOf(ctx, teamId);
    if (p && policyBlocks(p.policy, key)) return { team_id: p.team_id, team_name: p.team_name };
  }
  return null;
}

/** The refusal for `key` under this scope, or null when the request may proceed. */
export async function teamPolicyRefusal(ctx: DbCtx, scope: PolicyScope, key: RestrictionKey): Promise<string | null> {
  const blocker = await teamPolicyBlocker(ctx, scope, key);
  return blocker ? policyBlockedMessage(key, { kind: "team", team_id: String(blocker.team_id), team_name: blocker.team_name }) : null;
}

/** The policy guard: throws the shared message when a team's policy turns `key` off here.
 *  A FORBIDDEN ConvexError by default, so the web shows the words (a plain
 *  Error's message is redacted in production) and a CLI route answers 403. */
export async function requireTeamPolicyAllows(
  ctx: DbCtx,
  scope: PolicyScope,
  key: RestrictionKey,
  fail: (message: string) => never = (m) => { throw accessError("FORBIDDEN", m); },
): Promise<void> {
  const refusal = await teamPolicyRefusal(ctx, scope, key);
  if (refusal) fail(refusal);
}
