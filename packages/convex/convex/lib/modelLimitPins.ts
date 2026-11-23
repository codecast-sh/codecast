// A park on one model's week ("You've hit your Fable limit") when most of the
// fleet runs another model. Moving the fleet for it is wrong: one Fable session
// hopped an Opus fleet across three accounts every few minutes (2026-11-21:
// studiomgmt → personal226 → symmetrylabs → studiomgmt), because six of seven
// accounts report no Fable meter and each looked open. Model-scoped weeks are
// per account, though, so the parked session alone can move: it is pinned to
// an account whose meter PROVES room on that model and restarted there, and
// the fleet stays where it is (2026-11-22: six accounts at Fable 100%,
// adanovagreen at 22%, and auto-switch did nothing).
//
// The pin is a per-session account (`cc_account`, the profile's launch
// credential sourced at process start), so it needs a restart and a profile
// with a launch credential on the session's machine. A session on a pushed
// login (a remote host) cannot be pinned and keeps waiting.

import type { Doc, Id } from "../_generated/dataModel";
import { newestSignificantMessage, isBannerTurn } from "../inboxFilters";
import { blockedAt, profileHasToken, runsPushedLogin, fleetAccount } from "../ccAccountsShared";
import { poolUsageOverlay } from "../accountPool";
import { fallbackProfiles, fleetRunsFamily, modelLimitFamily, type CcUsage } from "@codecast/shared/contracts";
import { hasModelRoom, modelRoomPercent, type ModelPin } from "./modelRoom";

/** An account a session was pinned to and parked on again is not tried again for that model this week. */
const TRIED_TTL_MS = 7 * 24 * 60 * 60 * 1000;

type PinProfile = {
  name: string;
  email?: string;
  usage?: CcUsage | null;
  login_expired_at?: number | null;
  access_refused_at?: number | null;
  setup_token?: { expires_at: number };
  token?: { expires_at: number };
  reserved_for?: string | null;
};

/** Where a session parked on `family`'s week can go: a profile on its machine
 *  that is not the account it parked on, has not been tried for this session
 *  this week, can launch a pinned session, and proves room on `family`. Most
 *  room first. */
export function modelPinTarget<P extends PinProfile>(
  profiles: readonly P[],
  family: string,
  parkedOnEmail: string | undefined,
  tried: readonly string[],
  now: number,
): P | undefined {
  const fits = fallbackProfiles(profiles, parkedOnEmail, now, [family]).filter(
    (p) => !tried.includes(p.name) && profileHasToken(p, now) && hasModelRoom(p.usage, family, now),
  );
  return fits.sort((a, b) => modelRoomPercent(a.usage, family, now)! - modelRoomPercent(b.usage, family, now)!)[0];
}

/** Splits parks into the ones a fleet decision acts on and the ones parked on
 *  one model's week that `fleet` (fleetModels) does not mostly run. */
export async function splitModelLimitParks<C extends Pick<Doc<"conversations">, "_id">>(
  ctx: { db: any },
  parks: C[],
  fleet: readonly string[],
): Promise<{ fleet: C[]; minority: Array<{ conv: C; family: string }> }> {
  const out = { fleet: [] as C[], minority: [] as Array<{ conv: C; family: string }> };
  for (const c of parks) {
    const tail: Doc<"messages">[] = await ctx.db
      .query("messages")
      .withIndex("by_conversation_timestamp", (q: any) => q.eq("conversation_id", c._id))
      .order("desc")
      .take(8);
    const newest = newestSignificantMessage(tail);
    const family = newest && isBannerTurn(newest) ? modelLimitFamily(newest.content) : undefined;
    if (!family || fleetRunsFamily(fleet, family)) out.fleet.push(c);
    else out.minority.push({ conv: c, family });
  }
  return out;
}

/**
 * Moves each minority-model park onto an account with proven room on its
 * model, alone: patches its pin and restarts it there (switch_account with no
 * profile: the daemon kills it, resumes it under the pin pinForResume keeps,
 * and sends the continue). The fleet's account, the switch cooldown and the
 * attempts memory are untouched. A park already pinned for this incident is
 * left to its restart. A pin a person chose (`--account`) is never moved.
 * Returns the conversations it moved.
 */
export async function pinModelLimitParks(
  ctx: { db: any },
  userId: Id<"users">,
  opts: {
    parks: Array<{ conv: Doc<"conversations">; family: string }>;
    online: Doc<"devices">[];
    primary: Doc<"devices">;
    now: number;
  },
): Promise<Array<{ conversation_id: Id<"conversations">; profile: string; family: string }>> {
  const { now } = opts;
  const moved: Array<{ conversation_id: Id<"conversations">; profile: string; family: string }> = [];
  const byDevice = new Map<string, Doc<"conversations">[]>();
  const profilesByDevice = new Map<string, PinProfile[]>();
  for (const { conv, family } of opts.parks) {
    const held = conv.cc_account_model_pin as ModelPin | undefined;
    if (held && held.profile === conv.cc_account && held.at >= blockedAt(conv)) continue;
    if (conv.cc_account && conv.cc_account_auto !== true) continue;
    const ownerId = conv.owner_device_id ?? opts.primary.device_id;
    const device = opts.online.find((d) => d.device_id === ownerId) ?? (ownerId === opts.primary.device_id ? opts.primary : undefined);
    if (!device?.cc_accounts || runsPushedLogin(device)) continue;
    let profiles = profilesByDevice.get(device.device_id);
    if (!profiles) {
      profiles = (await poolUsageOverlay(ctx as any, userId, device.cc_accounts.profiles)) as PinProfile[];
      profilesByDevice.set(device.device_id, profiles);
    }
    const parkedOn = conv.cc_account
      ? profiles.find((p) => p.name === conv.cc_account)?.email
      : fleetAccount(device.cc_accounts, now).email;
    const tried = (held?.family === family ? held.tried ?? [] : []).filter((t) => now - t.at < TRIED_TTL_MS);
    const target = modelPinTarget(profiles, family, parkedOn, tried.map((t) => t.profile), now);
    if (!target) continue;
    const pin: ModelPin = { family, profile: target.name, at: now, tried: [...tried, { profile: target.name, at: now }] };
    await ctx.db.patch(conv._id, { cc_account: target.name, cc_account_auto: true, cc_account_model_pin: pin });
    byDevice.set(device.device_id, [...(byDevice.get(device.device_id) ?? []), conv]);
    moved.push({ conversation_id: conv._id, profile: target.name, family });
  }
  for (const [deviceId, convs] of byDevice) {
    await ctx.db.insert("daemon_commands", {
      user_id: userId,
      command: "switch_account" as const,
      args: JSON.stringify({
        conversation_ids: convs.map((c) => c._id),
        session_ids: Object.fromEntries(convs.map((c) => [c._id, c.session_id])),
        continue_blocked: true,
      }),
      created_at: now,
      target_device_id: deviceId,
    });
  }
  return moved;
}
