import { v } from "convex/values";

export const deliveryTargetValidator = v.union(
  v.object({ kind: v.literal("herdr"), socket: v.string(), pane: v.string() }),
  v.object({ kind: v.literal("paseo"), agent_id: v.string() }),
);
