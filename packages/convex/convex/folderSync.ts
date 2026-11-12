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

export const FOLDER_EXPORT_RATE_WINDOW_MS = 10 * 60_000;
export const FOLDER_EXPORT_RATE_LIMIT = 20;

const TOKEN_HASH = /^[0-9a-f]{64}$/;

export type PeerExportCommand = "export_folder" | "export_session";

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
    const path = trimSlash(args.path);
    return await requestPeerExport(ctx, args, "export_folder", (conv) => {
      if (!conversationFolders(conv).includes(path)) throw new Error("path is not this conversation's folder");
      return { path };
    });
  },
});

export interface PeerExportArgs {
  api_token?: string;
  device_id: string;
  conversation_id: Id<"conversations">;
  tailnet?: { ip: string; name: string };
  token_hash?: string;
  relay_only?: boolean;
  only_device_id?: string;
}

/** Ask the owner's other online machines to run `command` for one of the
 *  owner's conversations: the auth, peer choice, direct gating and the shared
 *  rate limit every peer export goes through. Every request gets rows of its
 *  own, so one requester discarding never abandons or deletes another's.
 *  `payload` checks the conversation and names what to export beyond the
 *  conversation itself. */
export async function requestPeerExport(
  ctx: { db: any },
  args: PeerExportArgs,
  command: PeerExportCommand,
  payload: (conv: any) => Record<string, unknown> | Promise<Record<string, unknown>>,
): Promise<{ command_ids: string[]; labels: Record<string, string> }> {
  const userId = await getAuthenticatedUserId(ctx, args.api_token);
  if (!userId) throw new Error("Authentication required");
  const conv = await ctx.db.get(args.conversation_id);
  if (!conv || conv.user_id.toString() !== userId.toString()) throw new Error("not your conversation");
  const extra = await payload(conv);
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
    ...extra,
    conversation_id: args.conversation_id,
    requester: args.device_id,
    ...(grant && peer.direct_links_off !== true ? { direct: grant } : {}),
  });
  const since = now - FOLDER_EXPORT_RATE_WINDOW_MS;
  const inWindow = (d: { folder_export_at?: number[] }) => (d.folder_export_at ?? []).filter((t) => t > since);
  const recent = devices.reduce((n, d) => n + inWindow(d).length, 0);
  if (peers.length > 0) {
    if (recent + 1 > FOLDER_EXPORT_RATE_LIMIT) {
      throw new Error(`too many ${command === "export_folder" ? "folder" : "transcript"} requests: at most ${FOLDER_EXPORT_RATE_LIMIT} every ${FOLDER_EXPORT_RATE_WINDOW_MS / 60_000} minutes`);
    }
    await ctx.db.patch(requester._id, { folder_export_at: [...inWindow(requester), now] });
  }

  const command_ids: string[] = [];
  const labels: Record<string, string> = {};
  for (const peer of peers) {
    const id = await ctx.db.insert("daemon_commands", {
      user_id: userId,
      command,
      args: argsFor(peer),
      created_at: now,
      target_device_id: peer.device_id,
    });
    command_ids.push(id);
    labels[id] = peer.label ?? peer.device_id.slice(0, 8);
  }
  return { command_ids, labels };
}

async function ownExportCommand(ctx: { db: any }, userId: Id<"users">, id: Id<"daemon_commands">, command: PeerExportCommand) {
  const cmd = await ctx.db.get(id);
  if (!cmd || cmd.user_id.toString() !== userId.toString() || cmd.command !== command) return null;
  return cmd;
}

export const folderExportOutcomes = query({
  args: { api_token: v.optional(v.string()), command_ids: v.array(v.id("daemon_commands")) },
  handler: (ctx, args) => peerExportOutcomes(ctx, args, "export_folder"),
});

/** The answers to the caller's own `command` rows, with the answering machine's label. */
export async function peerExportOutcomes(ctx: { db: any }, args: { api_token?: string; command_ids: Id<"daemon_commands">[] }, command: PeerExportCommand) {
  const userId = await getAuthenticatedUserId(ctx, args.api_token);
  if (!userId) return [];
  const devices = await ctx.db
    .query("devices")
    .withIndex("by_user_id", (q: any) => q.eq("user_id", userId))
    .collect();
  const labelOf = new Map(devices.map((d: any) => [d.device_id, d.label ?? null]));
  const out = [];
  for (const id of args.command_ids.slice(0, FOLDER_EXPORT_PEER_CAP)) {
    const cmd = await ownExportCommand(ctx, userId, id, command);
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
}

/** Delete an export's archive from storage once the requester has it (or gave up on it). */
export const discardFolderBundle = mutation({
  args: { api_token: v.optional(v.string()), command_id: v.id("daemon_commands") },
  handler: (ctx, args) => discardPeerBundle(ctx, args, "export_folder"),
});

export async function discardPeerBundle(ctx: { db: any; storage: any }, args: { api_token?: string; command_id: Id<"daemon_commands"> }, command: PeerExportCommand) {
  const userId = await getAuthenticatedUserId(ctx, args.api_token);
  if (!userId) throw new Error("Authentication required");
  const cmd = await ownExportCommand(ctx, userId, args.command_id, command);
  if (cmd && cmd.executed_at === undefined) {
    await ctx.db.patch(cmd._id, { executed_at: Date.now(), error: "abandoned" });
    return { discarded: false };
  }
  if (!cmd?.result) return { discarded: false };
  let storageId: string | undefined;
  try { storageId = JSON.parse(cmd.result)?.storage_id; } catch {}
  if (!storageId) return { discarded: false };
  await ctx.storage.delete(storageId as Id<"_storage">).catch(() => {});
  return { discarded: true };
}

/** An export answer that arrives after its requester discarded the request
 *  (or after another answer settled it) is not recorded: its archive is
 *  deleted and the row stays as it was. True when the report was handled here. */
export async function dropLateExportAnswer(ctx: { storage: any }, command: { command: string; executed_at?: number }, result: string | undefined): Promise<boolean> {
  if ((command.command !== "export_folder" && command.command !== "export_session") || command.executed_at === undefined) return false;
  let storageId: unknown;
  try { storageId = result ? JSON.parse(result)?.storage_id : undefined; } catch {}
  if (typeof storageId === "string" && storageId) await ctx.storage.delete(storageId as Id<"_storage">).catch(() => {});
  return true;
}
