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
import { normalizePeerTailnet } from "@codecast/shared/contracts/peerTransport";

export const FOLDER_EXPORT_PEER_CAP = 6;

type PeerDevice = { device_id: string; last_seen: number; label?: string };

/** The machines worth asking: online, not the requester, most recently seen first. */
export function pickFolderPeers<D extends PeerDevice>(devices: D[], requester: string, now: number): D[] {
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

export const FOLDER_EXPORT_REUSE_MS = 2 * 60_000;
export const FOLDER_EXPORT_RATE_WINDOW_MS = 10 * 60_000;
export const FOLDER_EXPORT_RATE_LIMIT = 20;

const TOKEN_HASH = /^[0-9a-f]{64}$/;

/** This user's export_folder rows still waiting, created inside the reuse window. */
async function liveExports(ctx: { db: any }, userId: Id<"users">, now: number) {
  return (await ctx.db
    .query("daemon_commands")
    .withIndex("by_user_pending", (q: any) => q.eq("user_id", userId).eq("executed_at", undefined).gt("_creationTime", now - FOLDER_EXPORT_REUSE_MS))
    .collect()).filter((c: any) => c.command === "export_folder");
}

export const requestFolderExport = mutation({
  args: {
    api_token: v.optional(v.string()),
    device_id: v.string(),
    conversation_id: v.id("conversations"),
    path: v.string(),
    // The requester's own place on its tailnet and sha256 of the grant secret
    // it keeps (docs/architecture/peer-transport.md); both or neither.
    tailnet: v.optional(v.object({ ip: v.string(), name: v.string() })),
    token_hash: v.optional(v.string()),
    // A retry after a failed direct pull: no grant this time.
    relay_only: v.optional(v.boolean()),
    // Ask this one machine only (the retry goes back to the machine that answered).
    only_device_id: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ command_ids: string[]; labels: Record<string, string> }> => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) throw new Error("Authentication required");
    const conv = await ctx.db.get(args.conversation_id);
    if (!conv || conv.user_id.toString() !== userId.toString()) throw new Error("not your conversation");
    const path = trimSlash(args.path);
    if (!conversationFolders(conv).includes(path)) throw new Error("path is not this conversation's folder");
    if (args.token_hash !== undefined && !TOKEN_HASH.test(args.token_hash)) throw new Error("token_hash must be 64 lowercase hex characters");
    if (args.tailnet && !normalizePeerTailnet(args.tailnet)) throw new Error("tailnet must be an IPv4 address and a node name");
    const now = Date.now();
    const devices = (await ctx.db
      .query("devices")
      .withIndex("by_user_id", (q: any) => q.eq("user_id", userId))
      .collect()) as Array<PeerDevice & { _id: Id<"devices">; direct_links_off?: boolean; folder_export_at?: number[] }>;
    const requester = devices.find((d) => d.device_id === args.device_id);
    if (!requester) throw new Error("device_id is not one of your machines");
    const candidates = args.only_device_id ? devices.filter((d) => d.device_id === args.only_device_id) : devices;
    const peers = pickFolderPeers(candidates, args.device_id, now);
    if (args.only_device_id && peers.length === 0) throw new Error("that machine is not one of your online machines");

    const grant = args.tailnet && args.token_hash && args.relay_only !== true && requester.direct_links_off !== true
      ? { requester: { ip: args.tailnet.ip, name: args.tailnet.name }, token_hash: args.token_hash }
      : undefined;
    const argsFor = (peer: { direct_links_off?: boolean }) => JSON.stringify({
      path,
      conversation_id: args.conversation_id,
      requester: args.device_id,
      ...(grant && peer.direct_links_off !== true ? { direct: grant } : {}),
    });
    const live = await liveExports(ctx, userId, now);
    const plan = peers.map((peer) => {
      const cmdArgs = argsFor(peer);
      return { peer, cmdArgs, reuse: live.find((c: any) => c.target_device_id === peer.device_id && c.args === cmdArgs) };
    });

    const since = now - FOLDER_EXPORT_RATE_WINDOW_MS;
    const inWindow = (d: { folder_export_at?: number[] }) => (d.folder_export_at ?? []).filter((t) => t > since);
    const recent = devices.reduce((n, d) => n + inWindow(d).length, 0);
    const inserts = plan.filter((p) => !p.reuse).length;
    if (recent + inserts > FOLDER_EXPORT_RATE_LIMIT) {
      throw new Error(`too many folder requests: at most ${FOLDER_EXPORT_RATE_LIMIT} every ${FOLDER_EXPORT_RATE_WINDOW_MS / 60_000} minutes`);
    }
    if (inserts > 0) {
      await ctx.db.patch(requester._id, { folder_export_at: [...inWindow(requester), ...Array(inserts).fill(now)] });
    }

    const command_ids: string[] = [];
    const labels: Record<string, string> = {};
    for (const { peer, cmdArgs, reuse } of plan) {
      const id = reuse?._id ?? await ctx.db.insert("daemon_commands", {
        user_id: userId,
        command: "export_folder" as const,
        args: cmdArgs,
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
        device_id: cmd.target_device_id ?? null,
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
