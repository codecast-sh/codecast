// Ending a team membership (endMembership) and the session owner rows that
// end with it. teams.ts calls this from every path that removes someone.

import type { Id } from "../_generated/dataModel";
import { recordAuthorityEvent } from "./authorityEvents";
import { isTeamMember } from "../privacy";
import { isTeamMachineFor } from "../sessionLaunch";
import { runnerDeviceOf } from "./runnerDevice";
import { syncPrimaryOwnerCache } from "../sessionOwners";
import { withdrawMember } from "./changesDirty";
import { purgeChatMembership } from "../chat";
import { removeFromTeamHosts } from "../teamHosts";
import { scheduleSeatSync } from "./teamSeats";

// An owner row on a session another account runs steers that account's
// daemon, and it was granted inside one team: starting the session on a
// teammate's shared machine (the machine's device_shares team), a team agent
// box (the bot's team), or a handoff or claim, which needs the session's own
// team (sessionOwnership.resolveOwnerRef). The row holds while that grant
// still does. Another team the two people happen to share grants nothing
// here: it would not let them start a session on that machine either.
export async function ownerGrantHolds(ctx: { db: any }, userId: Id<"users">, conv: any): Promise<boolean> {
  const runner = await ctx.db.get(conv.user_id);
  if (!runner) return false;
  if (runner.is_bot) return !runner.team_id || (await isTeamMember(ctx, userId, runner.team_id));
  if (conv.team_id && (await isTeamMember(ctx, userId, conv.team_id))) return true;
  const device = await runnerDeviceOf(ctx, conv);
  return !!device && (await isTeamMachineFor(ctx, userId, device));
}

// Whether `teamId` is one a grant on this session could have come through.
async function grantRunsThrough(ctx: { db: any }, conv: any, teamId: Id<"teams">): Promise<boolean> {
  const runner = await ctx.db.get(conv.user_id);
  if (runner?.is_bot) return String(runner.team_id ?? "") === String(teamId);
  if (String(conv.team_id ?? "") === String(teamId)) return true;
  if (!conv.owner_device_id) return false;
  const shares = await ctx.db.query("device_shares")
    .withIndex("by_user_device", (q: any) => q.eq("user_id", conv.user_id).eq("device_id", conv.owner_device_id))
    .collect();
  return shares.some((sh: any) => String(sh.team_id) === String(teamId));
}

export async function dropOwnerRow(ctx: { db: any }, row: any): Promise<void> {
  await ctx.db.delete(row._id);
  await syncPrimaryOwnerCache(ctx, row.conversation_id);
}

// When a membership ends, drop the person's owner rows on sessions others run
// whose grant came through that team and no longer holds.
async function releaseStrandedSessionOwnership(ctx: { db: any }, userId: Id<"users">, teamId: Id<"teams">): Promise<void> {
  const rows = await ctx.db
    .query("session_owners")
    .withIndex("by_user", (q: any) => q.eq("user_id", userId))
    .collect();
  for (const row of rows) {
    const conv = await ctx.db.get(row.conversation_id);
    if (!conv || String(conv.user_id) === String(userId)) continue;
    if (!(await grantRunsThrough(ctx, conv, teamId))) continue;
    if (await ownerGrantHolds(ctx, userId, conv)) continue;
    await dropOwnerRow(ctx, row);
  }
}

// End one user's membership in one team, and everything that rides on it:
// the roster row, chat state (reads, follows, room seats, queued pushes), the
// directory mappings that would keep stamping new conversations with the team,
// owner rows on sessions others run whose grant came through this team,
// and the user's own pointers when they name this team. The fallback pointer is
// the user's oldest remaining team (never index order), else no team. Every
// path that ends a membership goes through here: admin removal, self leave,
// team deletion and test cleanup, so none of them can diverge on what "gone"
// means.
export async function endMembership(
  ctx: { db: any },
  userId: Id<"users">,
  teamId: Id<"teams">,
  actor: Id<"users"> = userId,
): Promise<void> {
  const rows = await ctx.db
    .query("team_memberships")
    .withIndex("by_user_team", (q: any) => q.eq("user_id", userId).eq("team_id", teamId))
    .collect();
  for (const row of rows) await ctx.db.delete(row._id);
  if (rows.length && "scheduler" in ctx) await scheduleSeatSync(ctx as any, teamId, "member_left");
  if (rows.length) {
    await recordAuthorityEvent(ctx, {
      kind: "team_member_removed", actor_user_id: actor, team_id: teamId, target_user_id: userId,
      detail: { before: { role: rows[0].role, visibility: rows[0].visibility } },
    });
  }
  await purgeChatMembership(ctx as any, userId, teamId);
  // Their logins on the team's machines go too (locked, home kept).
  await removeFromTeamHosts(ctx as any, userId, teamId);
  const mappings = await ctx.db
    .query("directory_team_mappings")
    .withIndex("by_user_team", (q: any) => q.eq("user_id", userId).eq("team_id", teamId))
    .collect();
  for (const dm of mappings) await ctx.db.delete(dm._id);
  await withdrawMember(ctx, userId, teamId);
  await releaseStrandedSessionOwnership(ctx, userId, teamId);

  const user = await ctx.db.get(userId);
  if (!user) return;
  const pointsHere = (id: unknown) => !!id && String(id) === String(teamId);
  if (!pointsHere(user.team_id) && !pointsHere(user.active_team_id)) return;
  const remaining = await ctx.db
    .query("team_memberships")
    .withIndex("by_user_id", (q: any) => q.eq("user_id", userId))
    .collect();
  const fallback = remaining
    .slice()
    .sort((a: any, b: any) => (a.joined_at ?? 0) - (b.joined_at ?? 0))[0];
  const patch: Record<string, unknown> = {};
  if (pointsHere(user.team_id)) {
    patch.team_id = fallback?.team_id;
    patch.role = fallback?.role;
  }
  if (pointsHere(user.active_team_id)) patch.active_team_id = fallback?.team_id;
  await ctx.db.patch(userId, patch);
}
