/** The last transfer outcomes with each machine as the source, for the Machines page pair chips (peer-transport.md). */
export async function peerLinkRowsByDevice(ctx: { db: any }, userId: unknown, deviceIds: string[]) {
  const links = await ctx.db
    .query("peer_links")
    .withIndex("by_user", (q: any) => q.eq("user_id", userId))
    .collect();
  const known = new Set(deviceIds);
  return (deviceId: string) =>
    links
      .filter((l: any) => l.from_device_id === deviceId && known.has(l.to_device_id))
      .sort((x: any, y: any) => x.to_device_id.localeCompare(y.to_device_id))
      .map((l: any) => ({
        to_device_id: l.to_device_id,
        ...(l.last_direct_ok_at !== undefined ? { last_direct_ok_at: l.last_direct_ok_at } : {}),
        ...(l.last_direct_failure ? { last_direct_failure: l.last_direct_failure } : {}),
        ...(l.last_relay_ok_at !== undefined ? { last_relay_ok_at: l.last_relay_ok_at } : {}),
      }));
}
