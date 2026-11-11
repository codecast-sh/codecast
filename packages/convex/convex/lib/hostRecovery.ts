// Recovery for a cloud host on a fleet store of its own (line-pool copies,
// ccAccountsShared.runsOwnFleet): which machine a pass judges, and when the
// heartbeat books a host's switch-ahead check. Used by accountSwitch.ts and
// users.ts.
import type { Doc, Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import { recoveryModeOf, runsOwnFleet } from "../ccAccountsShared";

/**
 * The machine one recovery pass judges and moves. Without a device_id it is
 * the person's laptop, as it always was. With one it is that cloud host, when
 * the host runs on a fleet store of its own (line-pool copies, runsOwnFleet):
 * the host's parks and meters are about its own accounts, which the laptop's
 * pass can neither see nor move. The host pass runs under the person's
 * recovery mode, read from their laptop whether or not it is online, with
 * ask-first taken as auto: putting an account in the line pool is the
 * approval, and nobody sits at a host to answer an ask. Returns the host row
 * carrying that mode, so every rule below reads it as it reads a laptop's.
 */
export async function recoveryFleet(
  ctx: { db: any },
  userId: Id<"users">,
  deviceId: string | undefined,
  online: Doc<"devices">[],
  laptop: Doc<"devices"> | undefined,
): Promise<Doc<"devices"> | undefined> {
  if (!deviceId) return laptop;
  const host = online.find((d) => d.device_id === deviceId && runsOwnFleet(d));
  if (!host) return undefined;
  const person: Doc<"devices"> | undefined = laptop ?? (await ctx.db
    .query("devices")
    .withIndex("by_user_id", (q: any) => q.eq("user_id", userId))
    .collect())
    .filter((d: Doc<"devices">) => !d.is_remote)
    .sort((a: Doc<"devices">, b: Doc<"devices">) => b.last_seen - a.last_seen)[0];
  const on = !!person && recoveryModeOf(person) !== "off";
  return { ...host, cc_auto_switch: on, cc_recovery_ask: false, cc_auto_continue: false };
}

/**
 * Book the switch-ahead check a heartbeat calls for. A local machine on the
 * fleet store asks when its inventory changed (new meters). A cloud host on
 * its own fleet store reads its meters from each account's holder, whose beats
 * it never sees, so it asks on its own beat, at most once a write throttle
 * window (`seenStale`).
 */
export async function scheduleSwitchAhead(
  ctx: { scheduler: { runAfter: (ms: number, fn: any, args: any) => Promise<any> } },
  userId: Id<"users">,
  beat: { deviceId: string; local: boolean; ccAccounts?: { fleet_store?: boolean } | null; previous?: unknown; seenStale: boolean },
): Promise<void> {
  if (!beat.ccAccounts?.fleet_store) return;
  if (beat.local) {
    if (JSON.stringify(beat.ccAccounts) === JSON.stringify(beat.previous)) return;
    await ctx.scheduler.runAfter(0, internal.accountSwitch.switchAheadCheck, { user_id: userId });
  } else if (beat.seenStale) {
    await ctx.scheduler.runAfter(0, internal.accountSwitch.switchAheadCheck, { user_id: userId, device_id: beat.deviceId });
  }
}
