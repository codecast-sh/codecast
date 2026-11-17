import { mutation } from "./functions";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { cleanReservationPurpose } from "@codecast/shared/contracts";
import { ownDevice } from "./devices";
import { getAuthenticatedUserId } from "./permissions";

/**
 * Keep one of the caller's machines for one job (purpose), or open it again
 * (empty purpose). A reserved machine is skipped by every automatic placement
 * and takes work only by name: a --device pick, a move, a line slot. Sessions
 * already running there stay. Settings → Machines writes it through the
 * setDeviceReservation dispatch, the CLI through `cast devices reserve`.
 */
export async function performSetDeviceReservation(ctx: any, userId: Id<"users">, deviceId: string, purpose: string) {
  const device = await ownDevice(ctx, userId, deviceId);
  if (!device) throw new Error("Unknown device");
  const reserved_for = cleanReservationPurpose(purpose);
  await ctx.db.patch(device._id, { reserved_for: reserved_for ?? undefined });
  return { reserved_for };
}

export const setDeviceReservation = mutation({
  args: { api_token: v.optional(v.string()), device_id: v.string(), purpose: v.string() },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) throw new Error("Authentication required");
    return performSetDeviceReservation(ctx, userId, args.device_id, args.purpose);
  },
});
