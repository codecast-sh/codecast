import { v } from "convex/values";
import { internalMutation } from "./functions";
import { foldUsage } from "./lib/usageDaily";

export const fold = internalMutation({
  args: { conversation_id: v.id("conversations") },
  handler: async (ctx, { conversation_id }): Promise<void> => {
    await foldUsage(ctx, conversation_id);
  },
});
