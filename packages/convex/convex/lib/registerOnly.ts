import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";

export const deliveryTargetValidator = v.union(
  v.object({ kind: v.literal("herdr"), socket: v.string(), pane: v.string() }),
  v.object({ kind: v.literal("paseo"), agent_id: v.string(), home: v.optional(v.string()) }),
);

export async function isRegisterOnly(ctx: { db: any }, conversationId: Id<"conversations">): Promise<boolean> {
  return !!(await ctx.db.get(conversationId))?.register_only;
}

export function assertNotRegisterOnly(conv: { register_only?: boolean } | null | undefined, message = "a registered session can't move devices"): void {
  if (conv?.register_only) throw new Error(message);
}

export function moveRefusal(conv: { register_only?: boolean } | null | undefined, fallback: string): string {
  return conv?.register_only ? "a registered session can't move devices" : fallback;
}

export function sameDeliveryTarget(a: any, b: any): boolean {
  if (!a || !b || a.kind !== b.kind) return false;
  return a.kind === "herdr" ? a.socket === b.socket && a.pane === b.pane : a.agent_id === b.agent_id && (a.home ?? "") === (b.home ?? "");
}
