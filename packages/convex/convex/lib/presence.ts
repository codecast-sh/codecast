// Presence gates (vault.md "Ask first"): an action an agent driving the
// person's own browser could otherwise press for them needs a grant a passkey
// assertion earned (passkeys.ts presenceFinish), for that action on that
// target, unexpired and unused. A leaf, so secrets.ts and secretApprovals.ts
// gate without importing the passkeys module graph.

import { presenceRequiredMessage, type PresenceAction } from "@codecast/shared/contracts/secrets";
import type { Doc, Id } from "../_generated/dataModel";

type Ctx = { db: any };

async function liveGrant(ctx: Ctx, userId: Id<"users">, action: PresenceAction, target: string, now: number): Promise<Doc<"passkey_challenges"> | null> {
  const rows: Doc<"passkey_challenges">[] = await ctx.db
    .query("passkey_challenges")
    .withIndex("by_user_action_target", (q: any) => q.eq("user_id", userId).eq("action", action).eq("target", target))
    .collect();
  return rows.find((r) => r.status === "granted" && r.expires_at > now) ?? null;
}

/** The refusal when no grant is held, else null; consumes nothing, for a check that runs before the write consumes it. */
export async function presenceRefusal(ctx: Ctx, userId: Id<"users">, action: PresenceAction, target: string): Promise<string | null> {
  return (await liveGrant(ctx, userId, action, target, Date.now())) ? null : presenceRequiredMessage(action);
}

/** Use up the grant for this action on this target: the refusal when there is none, else null. */
export async function consumePresence(ctx: Ctx, userId: Id<"users">, action: PresenceAction, target: string): Promise<string | null> {
  const grant = await liveGrant(ctx, userId, action, target, Date.now());
  if (!grant) return presenceRequiredMessage(action);
  await ctx.db.patch(grant._id, { status: "used" });
  return null;
}
