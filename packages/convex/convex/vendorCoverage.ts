// The vendor guard's read for actions, which have no ctx.db: lib/vendorGuard
// calls it through ctx.runQuery.
import { v } from "convex/values";
import { internalQuery } from "./_generated/server";
import { VENDORS, type ContentVendor } from "@codecast/shared/contracts/vendorCoverage";
import { vendorRefusalFromDb } from "./lib/vendorGuard";

export const refusalFor = internalQuery({
  args: {
    workspace: v.optional(v.union(v.string(), v.null())),
    api_token: v.optional(v.union(v.string(), v.null())),
    conversation_id: v.optional(v.union(v.string(), v.null())),
    row: v.optional(v.union(v.object({ table: v.string(), id: v.string() }), v.null())),
    vendor: v.string(),
  },
  handler: async (ctx, args): Promise<string | null> => {
    const vendor = args.vendor as ContentVendor;
    if ((VENDORS as Record<string, { receives: string }>)[vendor]?.receives !== "content") throw new Error(`Not a content vendor: ${args.vendor}`);
    return vendorRefusalFromDb(ctx, { workspace: args.workspace, apiToken: args.api_token, conversationId: args.conversation_id, row: args.row }, vendor);
  },
});
