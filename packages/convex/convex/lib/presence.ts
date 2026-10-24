// Presence gates (vault.md "Ask first"): an action an agent driving the
// person's own browser could otherwise press for them needs a grant a passkey
// assertion earned (passkeys.ts presenceFinish), for that action on that
// target, unexpired and unused, spent with the secret handed to the caller
// that began it. A leaf, so secrets.ts and secretApprovals.ts gate without
// importing the passkeys module graph.

import { presenceRequiredMessage, type PresenceAction, type PresenceGrant } from "@codecast/shared/contracts/secrets";
import type { Doc, Id } from "../_generated/dataModel";
import { sha256Hex } from "./hash";

type Ctx = { db: any };

/** The grant string presenceBegin hands its caller: the challenge id and the secret whose hash the row keeps. */
export const grantString = (challengeId: string, secret: string): PresenceGrant => `${challengeId}.${secret}`;

/** The challenge a grant string names, or null for one that is not a grant. */
export function grantChallengeId(ctx: Ctx, grant: PresenceGrant | undefined): Id<"passkey_challenges"> | null {
  const [ref, secret] = grant?.split(".") ?? [];
  return ref && secret ? ctx.db.normalizeId("passkey_challenges", ref) : null;
}

/** The row a grant string names, when it is granted for exactly this user, action and target, unexpired, and the secret matches. */
async function liveGrant(ctx: Ctx, userId: Id<"users">, action: PresenceAction, target: string, grant: PresenceGrant | undefined): Promise<Doc<"passkey_challenges"> | null> {
  const id = grantChallengeId(ctx, grant);
  const row: Doc<"passkey_challenges"> | null = id ? await ctx.db.get(id) : null;
  if (!row || row.purpose !== "presence" || row.status !== "granted" || row.expires_at <= Date.now()) return null;
  if (String(row.user_id) !== String(userId) || row.action !== action || row.target !== target) return null;
  return row.grant_hash && row.grant_hash === (await sha256Hex(grant!.split(".")[1])) ? row : null;
}

/** The refusal when `grant` does not pass, else null; consumes nothing, for a check that runs before the write consumes it. */
export async function presenceRefusal(ctx: Ctx, userId: Id<"users">, action: PresenceAction, target: string, grant: PresenceGrant | undefined): Promise<string | null> {
  return (await liveGrant(ctx, userId, action, target, grant)) ? null : presenceRequiredMessage(action);
}

/** Spend `grant` on this action on this target: the refusal when it does not pass, else null. */
export async function consumePresence(ctx: Ctx, userId: Id<"users">, action: PresenceAction, target: string, grant: PresenceGrant | undefined): Promise<string | null> {
  const row = await liveGrant(ctx, userId, action, target, grant);
  if (!row) return presenceRequiredMessage(action);
  await ctx.db.patch(row._id, { status: "used" });
  return null;
}
