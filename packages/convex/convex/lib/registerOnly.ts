import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";

export const deliveryTargetValidator = v.union(
  v.object({ kind: v.literal("herdr"), socket: v.string(), pane: v.string() }),
  v.object({ kind: v.literal("paseo"), agent_id: v.string() }),
);

export async function isRegisterOnly(ctx: { db: any }, conversationId: Id<"conversations">): Promise<boolean> {
  return !!(await ctx.db.get(conversationId))?.register_only;
}

export function assertNotRegisterOnly(conv: { register_only?: boolean } | null | undefined): void {
  if (conv?.register_only) throw new Error("a registered session can't move devices");
}
