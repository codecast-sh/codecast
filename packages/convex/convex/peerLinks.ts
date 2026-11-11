/**
 * The last transfer outcome per ordered pair of one owner's machines
 * (docs/architecture/peer-transport.md): the requester records how each
 * folder or transcript pull went, direct or through the relay, and the
 * Machines page reads it to say how the pair actually talks.
 */

import { mutation, query } from "./functions";
import { v } from "convex/values";
import { getAuthenticatedUserId } from "./permissions";
import { ownDevice } from "./devices";

export const PEER_LINK_REASON_MAX = 200;

export const recordPeerLink = mutation({
  args: {
    api_token: v.optional(v.string()),
    from_device_id: v.string(),
    to_device_id: v.string(),
    mode: v.union(v.literal("direct"), v.literal("relay")),
    ok: v.boolean(),
    reason: v.optional(v.string()),
    bytes: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) throw new Error("Authentication required");
    if (args.from_device_id === args.to_device_id) throw new Error("a link needs two machines");
    for (const id of [args.from_device_id, args.to_device_id]) {
      if (!(await ownDevice(ctx, userId, id))) throw new Error("Unknown device");
    }
    const now = Date.now();
    const bytes = args.bytes !== undefined && Number.isFinite(args.bytes) && args.bytes >= 0 ? Math.round(args.bytes) : undefined;
    const patch = {
      updated_at: now,
      ...(args.ok && bytes !== undefined ? { last_bytes: bytes } : {}),
      ...(args.mode === "direct"
        ? args.ok
          ? { last_direct_ok_at: now }
          : { last_direct_failure: { at: now, reason: (args.reason || "failed").slice(0, PEER_LINK_REASON_MAX) } }
        : args.ok ? { last_relay_ok_at: now } : {}),
    };
    const existing = await ctx.db
      .query("peer_links")
      .withIndex("by_user_pair", (q) => q.eq("user_id", userId).eq("from_device_id", args.from_device_id).eq("to_device_id", args.to_device_id))
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, patch);
      return existing._id;
    }
    return await ctx.db.insert("peer_links", { user_id: userId, from_device_id: args.from_device_id, to_device_id: args.to_device_id, ...patch });
  },
});

export const listPeerLinks = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthenticatedUserId(ctx);
    if (!userId) return [];
    return await ctx.db.query("peer_links").withIndex("by_user", (q) => q.eq("user_id", userId)).collect();
  },
});

/** Settings → Machines "Accept direct links": off keeps folderSync from asking this machine for a direct grant. */
export const setDeviceDirectLinks = mutation({
  args: { api_token: v.optional(v.string()), device_id: v.string(), enabled: v.boolean() },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) throw new Error("Authentication required");
    const device = await ownDevice(ctx, userId, args.device_id);
    if (!device) throw new Error("Unknown device");
    await ctx.db.patch(device._id, { direct_links_off: args.enabled ? undefined : true });
    return { direct_links_off: !args.enabled };
  },
});
