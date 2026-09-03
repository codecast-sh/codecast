/**
 * Admin-only helpers behind `cast app as-user`: sign the agent browser in as a
 * named account so a verification run has a known identity. Internal
 * functions, so only the admin key (packages/convex/run.sh) can call them.
 */
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";
import { internalQuery } from "./functions";
import type { Id } from "./_generated/dataModel";

type FoundUser = { _id: Id<"users">; email?: string; name?: string } | null;

export const findUser = internalQuery({
  args: { email: v.optional(v.string()), user_id: v.optional(v.string()) },
  handler: async (ctx, args): Promise<FoundUser> => {
    if (args.user_id) {
      const user = await ctx.db.get(args.user_id as Id<"users">);
      return user ? { _id: user._id, email: user.email, name: user.name } : null;
    }
    if (!args.email) return null;
    const users = await ctx.db.query("users").collect();
    const user = users.find((u) => u.email === args.email);
    return user ? { _id: user._id, email: user.email, name: user.name } : null;
  },
});

/**
 * A real token pair for the user, minted the way a login mints one, so the
 * client's refresh path works (a hand-signed JWT dies on the first reconnect).
 */
export const mintSession = internalAction({
  args: { email: v.optional(v.string()), user_id: v.optional(v.string()) },
  handler: async (ctx, args): Promise<{ user: NonNullable<FoundUser>; token: string; refreshToken: string }> => {
    const user = await ctx.runQuery(internal.verification.findUser, args);
    if (!user) throw new Error(`no user for ${args.email ?? args.user_id}`);
    const res: any = await ctx.runMutation(internal.auth.store, {
      args: { type: "signIn", userId: user._id, generateTokens: true },
    });
    const tokens = res?.tokens;
    if (!tokens?.token || !tokens?.refreshToken) throw new Error("auth store returned no tokens");
    return { user, token: tokens.token, refreshToken: tokens.refreshToken };
  },
});
