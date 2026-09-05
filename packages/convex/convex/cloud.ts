/**
 * Sessions on the cloud host: placement, wake requests, and the web's handoff
 * to a local daemon.
 *
 * A cloud session is an ordinary session whose owner device is the remote
 * Linux box and whose project path is an isolated worktree on that box. The
 * laptop prepares the host over SSH (wake, refresh the checkout, copy the
 * manifest's secret files, `cast ws acquire` there) and then places the row
 * here; from that point every existing rail — start_session routing, pending
 * message delivery, resume on wake — treats it like any other device.
 */

import { mutation, query } from "./functions";
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { verifyApiToken } from "./apiTokens";
import { Id } from "./_generated/dataModel";
import { DEVICE_ONLINE_MS } from "./deviceRouting";
import { scheduleCloudWake, serverOwnsCloudWake } from "./cloudWake";
import { enqueueStartSession } from "./devices";
import { enqueuePendingMessage } from "./pendingMessages";
import { fromConvexAgentType } from "@codecast/shared/contracts";

async function getAuthenticatedUserId(ctx: { db: any }, apiToken?: string): Promise<Id<"users"> | null> {
  const sessionUserId = await getAuthUserId(ctx as any);
  if (sessionUserId) return sessionUserId;
  if (apiToken) {
    const result = await verifyApiToken(ctx, apiToken);
    if (result) return result.userId;
  }
  return null;
}

type WakeableDevice = {
  user_id?: string;
  device_id: string;
  label?: string;
  last_seen: number;
  is_remote?: boolean;
  wake_requested_at?: number;
};

/**
 * Remote devices that are asleep with work waiting: a wake stamp newer than
 * their last heartbeat. Pure, so the heartbeat can call it per beat and the
 * rule is unit-testable. A stamp older than the last beat was answered by that
 * beat (the device came up and the stamp is cleared there as well).
 */
export function wakeDevicesFor(
  devices: WakeableDevice[],
  now: number,
): Array<{ device_id: string; label: string | null }> {
  return devices
    .filter(
      (d) =>
        d.is_remote === true &&
        !serverOwnsCloudWake(d.user_id ?? "", d.device_id) &&
        typeof d.wake_requested_at === "number" &&
        d.wake_requested_at > d.last_seen &&
        now - d.last_seen >= DEVICE_ONLINE_MS,
    )
    .map((d) => ({ device_id: d.device_id, label: d.label ?? null }));
}

/**
 * Work was queued for a conversation. If its owner is a remote device that is
 * offline — a cloud host that powered itself off — retain wake intent until
 * its next heartbeat. Returns whether a wake is pending.
 * Never stamps a local device: nothing can open a closed laptop.
 */
export async function requestRemoteWake(ctx: { db: any; scheduler?: { runAfter(delay: number, fn: any, args: any): Promise<unknown> } }, conversation: any): Promise<boolean> {
  const owner = conversation?.owner_device_id as string | undefined;
  if (!owner) return false;
  const device = await ctx.db
    .query("devices")
    .withIndex("by_user_device", (q: any) => q.eq("user_id", conversation.user_id).eq("device_id", owner))
    .first();
  if (!device?.is_remote) return false;
  const now = Date.now();
  const pending = typeof device.wake_requested_at === "number" && device.wake_requested_at > device.last_seen;
  const retryFailed = device.cloud_wake?.status === "failed" && serverOwnsCloudWake(device.user_id, device.device_id);
  const requestAt = pending && !retryFailed ? device.wake_requested_at : Math.max(now, device.last_seen + 1, (device.wake_requested_at ?? 0) + 1);
  if (requestAt !== device.wake_requested_at) await ctx.db.patch(device._id, { wake_requested_at: requestAt });
  await scheduleCloudWake(ctx, device, requestAt);
  return true;
}

/**
 * The web asked for a session on the cloud host. The browser cannot SSH, so
 * an online LOCAL daemon does the preparation: pick the one seen most recently
 * and hand it a cloud_spawn command. Mirrors moveToRemote, which picks the
 * source daemon the same way.
 */
export async function enqueueCloudSpawn(
  ctx: { db: any },
  userId: Id<"users">,
  opts: { conversationId: Id<"conversations">; cloudDeviceId: string },
): Promise<Id<"daemon_commands">> {
  const now = Date.now();
  const devices = await ctx.db
    .query("devices")
    .withIndex("by_user_id", (q: any) => q.eq("user_id", userId))
    .collect();
  const preparer = devices
    .filter((d: any) => !d.is_remote && now - d.last_seen < DEVICE_ONLINE_MS)
    .sort((a: any, b: any) => b.last_seen - a.last_seen)[0];
  if (!preparer) {
    throw new Error("No online machine can prepare the cloud host — start the codecast daemon on your laptop first");
  }
  return await ctx.db.insert("daemon_commands", {
    user_id: userId,
    command: "cloud_spawn" as const,
    args: JSON.stringify({ conversation_id: opts.conversationId, cloud_device_id: opts.cloudDeviceId }),
    created_at: now,
    target_device_id: preparer.device_id,
  });
}

/**
 * Place a conversation on the cloud host: the worktree the laptop just
 * acquired there becomes its project path, the host's device its owner, and
 * (for a spawn) the ordinary start_session is routed at that device. Forks
 * and web rows that already carry their first messages pass start=false /
 * true respectively; the seed prompt of a CLI spawn rides `prompt` so it is
 * enqueued only once the row can actually receive it.
 */
export const placeConversation = mutation({
  args: {
    api_token: v.optional(v.string()),
    conversation_id: v.id("conversations"),
    device_id: v.string(),
    project_path: v.string(),
    git_root: v.optional(v.string()),
    worktree_name: v.optional(v.string()),
    worktree_branch: v.optional(v.string()),
    worktree_path: v.optional(v.string()),
    start: v.boolean(),
    prompt: v.optional(v.string()),
    model: v.optional(v.string()),
    effort: v.optional(v.string()),
    cc_account: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) throw new Error("Authentication required");
    const conv = await ctx.db.get(args.conversation_id);
    if (!conv || conv.user_id.toString() !== userId.toString()) throw new Error("not your conversation");
    const device = await ctx.db
      .query("devices")
      .withIndex("by_user_device", (q: any) => q.eq("user_id", userId).eq("device_id", args.device_id))
      .first();
    if (!device) throw new Error(`Unknown device ${args.device_id}`);

    await ctx.db.patch(args.conversation_id, {
      owner_device_id: args.device_id,
      project_path: args.project_path,
      git_root: args.git_root ?? args.project_path,
      ...(args.worktree_name ? { worktree_name: args.worktree_name } : {}),
      ...(args.worktree_branch ? { worktree_branch: args.worktree_branch } : {}),
      ...(args.worktree_path ? { worktree_path: args.worktree_path, worktree_status: "active" as const } : {}),
      cloud_placement: undefined,
      session_error: undefined,
      updated_at: Date.now(),
    });

    let commandId: Id<"daemon_commands"> | undefined;
    if (args.start) {
      commandId = await enqueueStartSession(ctx, userId, {
        conversationId: args.conversation_id,
        agentType: fromConvexAgentType(conv.agent_type),
        projectPath: args.project_path,
        gitRoot: args.git_root ?? args.project_path,
        sessionId: conv.session_id,
        model: args.model,
        effort: args.effort,
        ccAccount: args.cc_account,
        targetDeviceId: args.device_id,
      });
    }
    const prompt = (args.prompt ?? "").trim();
    if (prompt) {
      const placed = await ctx.db.get(args.conversation_id);
      await enqueuePendingMessage(ctx, placed, userId, { content: prompt });
    }
    return { command_id: commandId, owner_device_id: args.device_id };
  },
});

/**
 * What `cast cloud start <conversation>` (the daemon's child for a web
 * "run in the cloud") needs to know about the row it is placing.
 */
export const placementTarget = query({
  args: { api_token: v.optional(v.string()), conversation_id: v.id("conversations") },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) return null;
    const conv = await ctx.db.get(args.conversation_id);
    if (!conv || conv.user_id.toString() !== userId.toString()) return null;
    return {
      project_path: conv.project_path ?? null,
      git_root: conv.git_root ?? null,
      agent_type: conv.agent_type ?? null,
      owner_device_id: conv.owner_device_id ?? null,
      cloud_placement: (conv as any).cloud_placement ?? null,
      worktree_name: conv.worktree_name ?? null,
      model: conv.model ?? null,
      effort: (conv as any).effort ?? null,
      cc_account: (conv as any).cc_account ?? null,
    };
  },
});

/**
 * The sessions a device runs right now, for `cast hosts ls`: every
 * conversation the device owns that the user has not killed. Worktree names
 * ride along so the host list can show what each worktree is for.
 */
export const hostSessions = query({
  args: { api_token: v.optional(v.string()), device_id: v.string() },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) return [];
    const owned = await ctx.db
      .query("conversations")
      .withIndex("by_owner_device", (q: any) => q.eq("user_id", userId).eq("owner_device_id", args.device_id))
      .collect();
    return owned
      .filter((c: any) => !c.inbox_killed_at && c.status !== "completed")
      .map((c: any) => ({
        conversation_id: c._id,
        short_id: c.short_id ?? c._id.toString().slice(0, 7),
        title: c.title ?? null,
        status: c.status ?? null,
        work_state: c.work_state ?? null,
        project_path: c.project_path ?? null,
        worktree_name: c.worktree_name ?? null,
        worktree_branch: c.worktree_branch ?? null,
        updated_at: c.updated_at ?? null,
      }))
      .sort((a: any, b: any) => (b.updated_at ?? 0) - (a.updated_at ?? 0));
  },
});
