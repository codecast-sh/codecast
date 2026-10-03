import { v } from "convex/values";
import { internalMutation } from "./functions";
import { recordUserSend } from "./lib/userSend";

export const record = internalMutation({
  args: { user_id: v.id("users"), team_id: v.optional(v.id("teams")), words: v.number(), timestamp: v.number() },
  handler: (ctx, { timestamp, ...send }): Promise<void> => recordUserSend(ctx, send, timestamp),
});
