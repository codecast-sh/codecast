// The machine a conversation runs on, as its devices row. Leaf module: read by
// devices.ts for the machine a viewer sees and by the route up (agentTasks) to
// tell a role that is away from one that hears.

/** The device row a conversation runs on, or null when it names none (a
 *  hosted session, one not yet claimed by a machine). */
export async function runnerDeviceOf(ctx: { db: any }, conv: { user_id: any; owner_device_id?: string | null }) {
  const deviceId = conv.owner_device_id;
  if (!deviceId) return null;
  return await ctx.db
    .query("devices")
    .withIndex("by_user_device", (q: any) =>
      q.eq("user_id", conv.user_id).eq("device_id", deviceId),
    )
    .first();
}
