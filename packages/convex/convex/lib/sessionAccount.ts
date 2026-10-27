// Which account a session's turns are spent on: a leaf (no server imports)
// so the usage insert path (lib/usageDaily.ts) can read it without pulling
// the pool's module graph in.

import type { Doc } from "../_generated/dataModel";
import { fleetAccount } from "../ccAccountsShared";

export const normalizeEmail = (email: string) => email.trim().toLowerCase();

/**
 * The Claude account (email) a session's turns are spent on right now: its pin
 * (the profile it launched on), else the account its machine's fleet runs on. Read when a
 * batch with usage lands, so a switch mid-session splits its tokens there.
 */
export async function accountOfSession(ctx: { db: any }, conversation: Doc<"conversations">, now = Date.now()): Promise<string | undefined> {
  if (!conversation.owner_device_id) return undefined;
  const device: Doc<"devices"> | null = await ctx.db
    .query("devices")
    .withIndex("by_user_device", (q: any) => q.eq("user_id", conversation.user_id).eq("device_id", conversation.owner_device_id))
    .first();
  if (!device) return undefined;
  // Claude accounts only: a Codex login can share an email with a Claude
  // account, and its tokens are not that account's.
  if (conversation.agent_type === "codex") return undefined;
  const accounts = device.cc_accounts;
  if (!accounts) return undefined;
  if (conversation.cc_account) {
    const pinned = accounts.profiles.find((p) => p.name === conversation.cc_account)?.email;
    if (pinned) return normalizeEmail(pinned);
  }
  const email = fleetAccount(accounts, now).email;
  return email ? normalizeEmail(email) : undefined;
}
