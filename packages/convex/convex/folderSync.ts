/**
 * Carrying a session's folder between the owner's machines (cli/src/folderSync.ts).
 *
 * The machine that now owns a session but lacks its folder asks every other
 * online machine of the same user for it: one targeted export_folder command
 * each. The machine holding the folder uploads an archive to storage and
 * answers with its storage id; the requester downloads it, unpacks it, and
 * discards the archive here. Only the requester's own conversation, only its
 * own devices, and only commands it asked for can be read or discarded.
 */

import { mutation, query } from "./functions";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { DEVICE_ONLINE_MS } from "./deviceRouting";
import { getAuthenticatedUserId } from "./permissions";

export const FOLDER_EXPORT_PEER_CAP = 6;

type PeerDevice = { device_id: string; last_seen: number; label?: string };

/** The machines worth asking: online, not the requester, most recently seen first. */
export function pickFolderPeers(devices: PeerDevice[], requester: string, now: number): PeerDevice[] {
  return devices
    .filter((d) => d.device_id !== requester && now - d.last_seen < DEVICE_ONLINE_MS)
    .sort((a, b) => b.last_seen - a.last_seen)
    .slice(0, FOLDER_EXPORT_PEER_CAP);
}

function trimSlash(p: string): string {
  return p.length > 1 ? p.replace(/\/+$/, "") : p;
}

/** The folders a conversation recorded: the only paths a fetch may name. */
export function conversationFolders(conv: { project_path?: string; git_root?: string; worktree_path?: string }): string[] {
  return [conv.project_path, conv.git_root, conv.worktree_path]
    .filter((p): p is string => typeof p === "string" && p.startsWith("/") && p !== "/")
    .map(trimSlash);
}

export const requestFolderExport = mutation({
  args: {
    api_token: v.optional(v.string()),
    device_id: v.string(),
    conversation_id: v.id("conversations"),
    path: v.string(),
  },
  handler: async (ctx, args): Promise<{ command_ids: string[]; labels: Record<string, string> }> => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) throw new Error("Authentication required");
    const conv = await ctx.db.get(args.conversation_id);
    if (!conv || conv.user_id.toString() !== userId.toString()) throw new Error("not your conversation");
    if (!conversationFolders(conv).includes(trimSlash(args.path))) throw new Error("path is not this conversation's folder");
    const now = Date.now();
    const devices = await ctx.db
      .query("devices")
      .withIndex("by_user_id", (q: any) => q.eq("user_id", userId))
      .collect();
    const command_ids: string[] = [];
    const labels: Record<string, string> = {};
    for (const peer of pickFolderPeers(devices as PeerDevice[], args.device_id, now)) {
      const id = await ctx.db.insert("daemon_commands", {
        user_id: userId,
        command: "export_folder" as const,
        args: JSON.stringify({ path: trimSlash(args.path), conversation_id: args.conversation_id }),
        created_at: now,
        target_device_id: peer.device_id,
      });
      command_ids.push(id);
      labels[id] = peer.label ?? peer.device_id.slice(0, 8);
    }
    return { command_ids, labels };
  },
});

async function ownExportCommand(ctx: { db: any }, userId: Id<"users">, id: Id<"daemon_commands">) {
  const cmd = await ctx.db.get(id);
  if (!cmd || cmd.user_id.toString() !== userId.toString() || cmd.command !== "export_folder") return null;
  return cmd;
}

export const folderExportOutcomes = query({
  args: { api_token: v.optional(v.string()), command_ids: v.array(v.id("daemon_commands")) },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) return [];
    const devices = await ctx.db
      .query("devices")
      .withIndex("by_user_id", (q: any) => q.eq("user_id", userId))
      .collect();
    const labelOf = new Map(devices.map((d: any) => [d.device_id, d.label ?? null]));
    const out = [];
    for (const id of args.command_ids.slice(0, FOLDER_EXPORT_PEER_CAP)) {
      const cmd = await ownExportCommand(ctx, userId, id);
      if (!cmd) continue;
      out.push({
        command_id: id as string,
        executed_at: cmd.executed_at ?? null,
        result: cmd.result ?? null,
        error: cmd.error ?? null,
        label: (cmd.target_device_id && labelOf.get(cmd.target_device_id)) ?? null,
      });
    }
    return out;
  },
});

/** Delete an export's archive from storage once the requester has it (or gave up on it). */
export const discardFolderBundle = mutation({
  args: { api_token: v.optional(v.string()), command_id: v.id("daemon_commands") },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) throw new Error("Authentication required");
    const cmd = await ownExportCommand(ctx, userId, args.command_id);
    if (!cmd?.result) return { discarded: false };
    let storageId: string | undefined;
    try { storageId = JSON.parse(cmd.result)?.storage_id; } catch {}
    if (!storageId) return { discarded: false };
    await ctx.storage.delete(storageId as Id<"_storage">).catch(() => {});
    return { discarded: true };
  },
});
