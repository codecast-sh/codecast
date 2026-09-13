import { v } from "convex/values";
import { internalMutation } from "./functions";
import { recordUserSend } from "./lib/userSend";

export const record = internalMutation({
  args: { user_id: v.id("users"), team_id: v.optional(v.id("teams")), timestamp: v.number() },
  handler: (ctx, args): Promise<void> => recordUserSend(ctx, { user_id: args.user_id, team_id: args.team_id }, args.timestamp),
});
