// A file link in a conversation names a path on the machine the session ran
// on. Opened from a browser on another machine, the Files page asks that
// machine for the one file: a targeted `read_file` command (daemon side:
// cli/src/remoteFileRead.ts), answered on the command row and read back with
// users.getCommandResult. Only the owner's own machines are asked.
//
// daemon_commands rows are kept, so the file's text is scrubbed from the row
// once the browser has had time to read it.

import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { mutation, internalMutation } from "./functions";
import { internal } from "./_generated/api";
import { canAccessConversation } from "./lib/access";
import { runnerDeviceOf } from "./lib/runnerDevice";
import { deviceDisplayName, DAEMON_COMMAND_TTL_MS } from "@codecast/shared/contracts";

export const READ_FILE_SCRUB_MS = DAEMON_COMMAND_TTL_MS * 2;

export const request = mutation({
  args: { conversation_id: v.id("conversations"), path: v.string() },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    const conv = await ctx.db.get(args.conversation_id);
    if (!conv || !(await canAccessConversation(ctx, userId, conv))) return { ok: false as const, reason: "no_machine" as const, machine: null };
    const device = await runnerDeviceOf(ctx, conv);
    if (!device) return { ok: false as const, reason: "no_machine" as const, machine: null };
    const machine = deviceDisplayName(device);
    if (device.user_id !== userId) return { ok: false as const, reason: "not_yours" as const, machine };
    if (!args.path.startsWith("/")) return { ok: false as const, reason: "bad_path" as const, machine };
    const command_id = await ctx.db.insert("daemon_commands", {
      user_id: userId,
      command: "read_file",
      args: JSON.stringify({ path: args.path }),
      created_at: Date.now(),
      target_device_id: device.device_id,
    });
    await ctx.scheduler.runAfter(READ_FILE_SCRUB_MS, internal.remoteFiles.scrub, { command_id });
    return { ok: true as const, command_id, device_id: device.device_id, machine };
  },
});

export const scrub = internalMutation({
  args: { command_id: v.id("daemon_commands") },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.command_id);
    if (row?.command === "read_file" && row.result) await ctx.db.patch(args.command_id, { result: undefined });
  },
});
