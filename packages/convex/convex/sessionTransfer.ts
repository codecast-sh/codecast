import { mutation, query } from "./functions";
import { v } from "convex/values";
import { discardPeerBundle, peerExportOutcomes, requestPeerExport } from "./folderSync";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SERVER_MINTED = new Set(["machine_switch", "agent_switch"]);

export const requestSessionExport = mutation({
  args: {
    api_token: v.optional(v.string()),
    device_id: v.string(),
    conversation_id: v.id("conversations"),
    tailnet: v.optional(v.object({ ip: v.string(), name: v.string() })),
    token_hash: v.optional(v.string()),
    relay_only: v.optional(v.boolean()),
    only_device_id: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ command_ids: string[]; labels: Record<string, string> }> =>
    await requestPeerExport(ctx, args, "export_session", async (conv) => {
      if (!UUID.test(conv.session_id ?? "")) throw new Error("this conversation has no transcript to fetch");
      // A machine that ran the session earlier may hold an older copy; the
      // source refuses a transcript that lacks the newest synced message. Rows
      // the server writes itself (the switch dividers) are in no transcript.
      const recent = await ctx.db
        .query("messages")
        .withIndex("by_conversation_timestamp", (q) => q.eq("conversation_id", conv._id))
        .order("desc")
        .take(50);
      const last_uuid = recent.find((m) => UUID.test(m.message_uuid ?? "") && !SERVER_MINTED.has(m.subtype ?? ""))?.message_uuid;
      return { session_id: conv.session_id, ...(last_uuid ? { last_uuid } : {}) };
    }),
});

export const sessionExportOutcomes = query({
  args: { api_token: v.optional(v.string()), command_ids: v.array(v.id("daemon_commands")) },
  handler: (ctx, args) => peerExportOutcomes(ctx, args, "export_session"),
});

export const discardSessionBundle = mutation({
  args: { api_token: v.optional(v.string()), command_id: v.id("daemon_commands") },
  handler: (ctx, args) => discardPeerBundle(ctx, args, "export_session"),
});
