// The server's half of a person's "New session defaults"
// (@codecast/shared/contracts newSessionDefaults): the device a start with no
// machine named goes to. `cast spawn` reads it inside its mutation and
// `cast trigger add --spawn` asks through the query below.
import { query } from "./functions";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { THIS_DEVICE, deviceServesPath, platformCanOpenPath } from "@codecast/shared/contracts";
import { DEVICE_ONLINE_MS } from "./deviceRouting";
import { getAuthenticatedUserId } from "./sessionMigrations";

/**
 * The person's saved default device when it can take the work now: one of
 * their own machines, online, and able to open the folder. Anything else
 * (no default, "This device", offline, removed, wrong platform) is null and
 * the caller's usual routing decides; a default never blocks a start.
 */
export async function defaultDeviceFor(ctx: { db: any }, userId: Id<"users">, paths: string[], opts: { needsCheckout?: boolean } = {}): Promise<string | null> {
  const now = Date.now();
  const state = await ctx.db.query("client_state").withIndex("by_user_id", (q: any) => q.eq("user_id", userId)).first();
  const wanted = state?.ui?.default_device;
  if (typeof wanted !== "string" || !wanted || wanted === THIS_DEVICE) return null;
  const devices = await ctx.db.query("devices").withIndex("by_user_id", (q: any) => q.eq("user_id", userId)).collect();
  const d = devices.find((x: any) => x.device_id === wanted);
  if (!d || now - d.last_seen >= DEVICE_ONLINE_MS) return null;
  const opens = deviceServesPath(d, paths) || (!opts.needsCheckout && paths.every((p) => platformCanOpenPath(d.platform, p)));
  if (paths.length && !opens) return null;
  return wanted;
}

/**
 * `cast trigger add --spawn` with no --device: the machine to bind the
 * trigger to, or null for "this machine". The run's daemon starts in the
 * folder as given, so the default must already hold it.
 */
export const defaultDevice = query({
  args: { api_token: v.optional(v.string()), project_path: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) return null;
    return defaultDeviceFor(ctx, userId, args.project_path ? [args.project_path] : [], { needsCheckout: true });
  },
});
