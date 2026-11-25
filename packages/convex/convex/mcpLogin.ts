// Sign in to a remote MCP server on one of the viewer's machines, from any
// device (shared/contracts/mcpLogin.ts has the whole round trip). The device
// row's `mcp_login_flow` is the UI's state channel: the web reads it from the
// machine roster (devices.listDevices), these mutations move it, and every
// step names its flow by `started_at`.
import { v } from "convex/values";
import { mutation } from "./functions";
import type { Doc } from "./_generated/dataModel";
import { getAuthenticatedUserId } from "./pendingMessages";
import { LOGIN_FLOW_STALE_MS } from "./ccAccountsShared";

// A busy daemon beats 60-100s apart while it is running the very sign-in, so
// reachability uses the account sign-in's own horizon (findFlowDevice).
const reachable = (device: Doc<"devices">, now: number) => now - device.last_seen < LOGIN_FLOW_STALE_MS;
import { isMcpServerName, mcpLoginCallback, MCP_LOGIN_STALE_MS } from "@codecast/shared/contracts";

const clientValidator = v.union(v.literal("claude"), v.literal("codex"));

async function ownDevice(ctx: { db: any }, apiToken: string | undefined, deviceId: string): Promise<{ userId: string; device: Doc<"devices"> }> {
  const userId = await getAuthenticatedUserId(ctx as any, apiToken);
  if (!userId) throw new Error("Authentication required");
  const device: Doc<"devices"> | null = await ctx.db
    .query("devices")
    .withIndex("by_user_device", (q: any) => q.eq("user_id", userId).eq("device_id", deviceId))
    .first();
  if (!device) throw new Error("That machine is not yours");
  return { userId, device };
}

/** The live flow this write names, or undefined when it ended or was replaced. */
function liveFlow(device: Doc<"devices">, startedAt: number, now: number) {
  const flow = device.mcp_login_flow;
  return flow?.status === "pending" && flow.started_at === startedAt && now - flow.started_at < MCP_LOGIN_STALE_MS ? flow : undefined;
}

async function command(ctx: { db: any }, userId: string, deviceId: string, args: Record<string, unknown>, now: number) {
  return ctx.db.insert("daemon_commands", {
    user_id: userId,
    command: "mcp_login" as const,
    args: JSON.stringify(args),
    created_at: now,
    target_device_id: deviceId,
  });
}

/** Start signing in to `server` with `client`'s CLI on that machine. Replaces any sign-in already running there. */
export const start = mutation({
  args: {
    api_token: v.optional(v.string()),
    device_id: v.string(),
    client: clientValidator,
    server: v.string(),
    // The project a project-scoped server is declared in, as that machine reported it.
    cwd: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { userId, device } = await ownDevice(ctx, args.api_token, args.device_id);
    const now = Date.now();
    if (!reachable(device, now)) throw new Error("That machine is offline");
    if (!isMcpServerName(args.server)) throw new Error("That is not an MCP server name");
    const cwd = args.cwd && args.cwd.startsWith("/") && args.cwd.length < 1024 ? args.cwd : undefined;
    await ctx.db.patch(device._id, {
      mcp_login_flow: { status: "pending" as const, client: args.client, server: args.server, started_at: now },
    });
    const commandId = await command(ctx, userId, device.device_id, { started_at: now, client: args.client, server: args.server, ...(cwd ? { cwd } : {}) }, now);
    // The command id lets the dialog read the machine's verdict
    // (devices.watchedCommandOutcome): a daemon too old for this answers
    // "Unknown command" there and never touches the flow.
    return { started_at: now, command_id: commandId };
  },
});

/** The daemon's report of the authorization URL its CLI printed. */
export const reportUrl = mutation({
  args: { api_token: v.optional(v.string()), device_id: v.string(), started_at: v.number(), url: v.string() },
  handler: async (ctx, args) => {
    const { device } = await ownDevice(ctx, args.api_token, args.device_id);
    const flow = liveFlow(device, args.started_at, Date.now());
    if (!flow || !/^https:\/\//.test(args.url)) return;
    await ctx.db.patch(device._id, { mcp_login_flow: { ...flow, url: args.url.slice(0, 8192) } });
  },
});

/** The daemon's report that the CLI refused a pasted address and is asking again. */
export const reportNotice = mutation({
  args: { api_token: v.optional(v.string()), device_id: v.string(), started_at: v.number(), notice: v.string() },
  handler: async (ctx, args) => {
    const { device } = await ownDevice(ctx, args.api_token, args.device_id);
    const now = Date.now();
    const flow = liveFlow(device, args.started_at, now);
    if (!flow) return;
    await ctx.db.patch(device._id, { mcp_login_flow: { ...flow, notice: args.notice.slice(0, 300), notice_at: now } });
  },
});

/** The address the person's browser landed on, typed into the machine's waiting CLI. */
export const submitCallback = mutation({
  args: { api_token: v.optional(v.string()), device_id: v.string(), started_at: v.number(), callback: v.string() },
  handler: async (ctx, args) => {
    const { userId, device } = await ownDevice(ctx, args.api_token, args.device_id);
    const now = Date.now();
    if (!liveFlow(device, args.started_at, now)) throw new Error("This sign-in has ended. Start again.");
    if (!reachable(device, now)) throw new Error("That machine is offline");
    const checked = mcpLoginCallback(args.callback);
    if ("error" in checked) throw new Error(checked.error);
    await command(ctx, userId, device.device_id, { started_at: args.started_at, callback: checked.url }, now);
  },
});

/** Stop a sign-in: the flow ends now and the machine closes its CLI. */
export const cancel = mutation({
  args: { api_token: v.optional(v.string()), device_id: v.string(), started_at: v.number() },
  handler: async (ctx, args) => {
    const { userId, device } = await ownDevice(ctx, args.api_token, args.device_id);
    const now = Date.now();
    const flow = liveFlow(device, args.started_at, now);
    if (!flow) return;
    await ctx.db.patch(device._id, { mcp_login_flow: { ...flow, status: "rejected" as const, reason: "Cancelled", finished_at: now } });
    await command(ctx, userId, device.device_id, { started_at: args.started_at, cancel: true }, now);
  },
});

/** The daemon's outcome report. */
export const complete = mutation({
  args: {
    api_token: v.optional(v.string()),
    device_id: v.string(),
    started_at: v.number(),
    status: v.union(v.literal("confirmed"), v.literal("rejected")),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { device } = await ownDevice(ctx, args.api_token, args.device_id);
    const now = Date.now();
    const flow = liveFlow(device, args.started_at, now);
    if (!flow) return;
    await ctx.db.patch(device._id, {
      mcp_login_flow: {
        ...flow,
        status: args.status,
        ...(args.reason ? { reason: args.reason.slice(0, 300) } : {}),
        finished_at: now,
      },
    });
  },
});
