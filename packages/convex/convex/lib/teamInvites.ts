// Team invite codes and the removals that close them for one person.

import type { Id } from "../_generated/dataModel";

// How long a team invite code lives from the moment it is generated.
export const INVITE_CODE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function inviteRowFor(ctx: { db: any }, teamId: Id<"teams">, email: string): Promise<any | null> {
  return ctx.db
    .query("team_invites")
    .withIndex("by_team_email", (q: any) => q.eq("team_id", teamId).eq("email", email))
    .first();
}

// An admin removal is recorded on the person's invite row for the team
// (team_invites, keyed by email), so the link they still hold does not let them
// straight back in. Everyone else's link keeps working: it refuses only a code
// generated before the removal, and only until an admin invites them again
// (a fresh invite email, or a new code).
export async function recordAdminRemoval(
  ctx: { db: any },
  team: { _id: Id<"teams">; invite_code?: string },
  email: string | undefined,
  adminId: Id<"users">,
): Promise<void> {
  const key = email?.trim().toLowerCase();
  if (!key) return;
  const now = Date.now();
  const row = await inviteRowFor(ctx, team._id, key);
  if (row) {
    await ctx.db.patch(row._id, { removed_at: now, ...(row.accepted_at ? {} : { accepted_at: now }) });
    return;
  }
  // accepted_at keeps this row from holding a seat as a pending invite.
  await ctx.db.insert("team_invites", {
    team_id: team._id, email: key, invite_code: team.invite_code ?? "", invited_by: adminId,
    created_at: now, accepted_at: now, removed_at: now,
  });
}

export async function removedSinceCodeIssued(
  ctx: { db: any },
  team: { _id: Id<"teams">; invite_code_expires_at?: number },
  email: string | undefined,
): Promise<boolean> {
  const key = email?.trim().toLowerCase();
  if (!key) return false;
  const row = await inviteRowFor(ctx, team._id, key);
  if (!row?.removed_at) return false;
  if (row.created_at > row.removed_at) return false; // invited again since
  const issuedAt = team.invite_code_expires_at ? team.invite_code_expires_at - INVITE_CODE_TTL_MS : 0;
  return issuedAt <= row.removed_at;
}
