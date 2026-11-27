import { v } from "convex/values";
import { internalMutation } from "./functions";

/** Switch an experiment on or off for one person. Idempotent; returns the
 *  person's resulting experiment list. */
export const set = internalMutation({
  args: { user_id: v.id("users"), name: v.string(), on: v.boolean() },
  handler: async (ctx, args): Promise<string[]> => {
    const user = await ctx.db.get(args.user_id);
    if (!user) throw new Error("user not found");
    const rest = (user.experiments ?? []).filter((n) => n !== args.name);
    const next = args.on ? [...rest, args.name] : rest;
    await ctx.db.patch(args.user_id, { experiments: next });
    return next;
  },
});
