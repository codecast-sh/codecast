/**
 * Live progress of a session folder moving between one owner's machines
 * (docs/architecture/peer-transport.md, "Discovery and UI"). The machine that
 * owns the session reports each phase onto `conversations.peer_transfer`; the
 * conversation header draws it, and Cancel stamps `cancel_requested_at`, which
 * the next report hands back to the daemon.
 */

import { mutation } from "./functions";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { getAuthenticatedUserId } from "./permissions";
import { ownDevice } from "./devices";

export const PEER_TRANSFER_TEXT_MAX = 200;

const phase = v.union(v.literal("asking"), v.literal("receiving"), v.literal("unpacking"), v.literal("done"), v.literal("failed"));
const mode = v.union(v.literal("direct"), v.literal("relay"));

const text = (s: string | undefined) => (s ? s.slice(0, PEER_TRANSFER_TEXT_MAX) : undefined);
const count = (n: number | undefined) => (n !== undefined && Number.isFinite(n) && n >= 0 ? Math.round(n) : undefined);

export const reportPeerTransfer = mutation({
  args: {
    api_token: v.optional(v.string()),
    device_id: v.string(),
    conversation_id: v.id("conversations"),
    started_at: v.number(),
    phase,
    from: v.optional(v.string()),
    mode: v.optional(mode),
    bytes: v.optional(v.number()),
    total: v.optional(v.number()),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ cancel: boolean }> => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) throw new Error("Authentication required");
    const conv = await ctx.db.get(args.conversation_id);
    if (!conv || conv.user_id.toString() !== userId.toString()) throw new Error("not your conversation");
    if (!(await ownDevice(ctx, userId, args.device_id))) throw new Error("Unknown device");
    if (conv.owner_device_id && conv.owner_device_id !== args.device_id) throw new Error("another machine runs this session");
    const prev = conv.peer_transfer?.started_at === args.started_at ? conv.peer_transfer : undefined;
    const cancel = !!prev?.cancel_requested_at && prev.cancel_requested_at >= args.started_at;
    if (args.phase === "done") {
      const cur = conv.peer_transfer;
      if (cur && (prev || cur.phase === "failed")) await ctx.db.patch(conv._id, { peer_transfer: undefined });
      return { cancel };
    }
    await ctx.db.patch(conv._id, {
      peer_transfer: {
        phase: args.phase,
        from: text(args.from),
        mode: args.mode,
        bytes: count(args.bytes),
        total: count(args.total),
        reason: text(args.reason),
        started_at: args.started_at,
        updated_at: Date.now(),
        cancel_requested_at: prev?.cancel_requested_at,
      },
    });
    return { cancel };
  },
});

// Only the transfer the person saw: a newer one started since keeps running.
export async function performCancelPeerTransfer(ctx: any, userId: Id<"users">, conversationId: Id<"conversations">, startedAt: number) {
  const conv = await ctx.db.get(conversationId);
  if (!conv || conv.user_id.toString() !== userId.toString()) throw new Error("not your conversation");
  const pt = conv.peer_transfer;
  if (!pt || pt.started_at !== startedAt || pt.phase === "failed" || pt.cancel_requested_at) return;
  await ctx.db.patch(conv._id, { peer_transfer: { ...pt, cancel_requested_at: Math.max(Date.now(), pt.started_at) } });
}

export const cancelPeerTransfer = mutation({
  args: { conversation_id: v.id("conversations"), started_at: v.number() },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx);
    if (!userId) throw new Error("Authentication required");
    await performCancelPeerTransfer(ctx, userId, args.conversation_id, args.started_at);
  },
});

// Only the transfer the person saw: a newer one its daemon started since stays.
export async function performDismissPeerTransfer(ctx: any, userId: Id<"users">, conversationId: Id<"conversations">, startedAt: number) {
  const conv = await ctx.db.get(conversationId);
  if (!conv || conv.user_id.toString() !== userId.toString()) throw new Error("not your conversation");
  if (conv.peer_transfer?.started_at === startedAt) await ctx.db.patch(conv._id, { peer_transfer: undefined });
}

export const dismissPeerTransfer = mutation({
  args: { conversation_id: v.id("conversations"), started_at: v.number() },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx);
    if (!userId) throw new Error("Authentication required");
    await performDismissPeerTransfer(ctx, userId, args.conversation_id, args.started_at);
  },
});
