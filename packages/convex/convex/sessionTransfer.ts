/**
 * Carrying a session's real transcript between the owner's machines
 * (cli/src/sessionTransfer.ts, docs/architecture/peer-transport.md). The
 * machine that now owns a session but has no transcript for it asks the
 * owner's other online machines; the one that ran it answers with the
 * transcript, directly over the tailnet or through storage. The args name
 * only the conversation: the source finds the session id in its own records
 * and never reads a path from the request.
 */

import { mutation, query } from "./functions";
import { v } from "convex/values";
import { discardPeerBundle, peerExportOutcomes, requestPeerExport } from "./folderSync";

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
    await requestPeerExport(ctx, args, "export_session", () => ({})),
});

export const sessionExportOutcomes = query({
  args: { api_token: v.optional(v.string()), command_ids: v.array(v.id("daemon_commands")) },
  handler: (ctx, args) => peerExportOutcomes(ctx, args, "export_session"),
});

export const discardSessionBundle = mutation({
  args: { api_token: v.optional(v.string()), command_id: v.id("daemon_commands") },
  handler: (ctx, args) => discardPeerBundle(ctx, args, "export_session"),
});
