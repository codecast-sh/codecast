import { DEVICE_ONLINE_MS } from "../deviceRouting";

/**
 * Owner device id of a conversation plus whether that device is a remote box and
 * currently online. Split out from the query so the scoping rule is testable.
 *
 * The device row is looked up under the conversation's AUTHOR, never the caller.
 * owner_device_id is always claimed by the account that runs the session, so for
 * a session one account runs and another owns, a lookup scoped to the caller
 * finds nothing — and a missing row reads as offline, reporting a live owner as
 * dead. Callers treat that as "unowned" and proceed, which is the opposite of
 * what the guard is for.
 */
export async function resolveOwnerDeviceView(
  ctx: { db: any },
  conv: { user_id: any; owner_device_id?: string | null },
  now: number = Date.now(),
): Promise<{ owner_device_id: string | null; owner_is_remote: boolean; owner_online: boolean }> {
  const owner = conv.owner_device_id ?? null;
  if (!owner) return { owner_device_id: null, owner_is_remote: false, owner_online: false };
  const ownerDevice = await ctx.db
    .query("devices")
    .withIndex("by_user_device", (q: any) =>
      q.eq("user_id", conv.user_id).eq("device_id", owner),
    )
    .first();
  return {
    owner_device_id: owner,
    owner_is_remote: !!ownerDevice?.is_remote,
    owner_online: !!ownerDevice && now - ownerDevice.last_seen < DEVICE_ONLINE_MS,
  };
}
