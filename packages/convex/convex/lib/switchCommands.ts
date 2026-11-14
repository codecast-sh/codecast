// The switch/revive execution plan: which device restarts which blocked
// session on which account. Split out of accountSwitch.ts, which re-exports
// insertSwitchCommands for its callers.

import { Id, Doc } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import { enqueuePendingMessage } from "../pendingMessages";
import { blockedContinueClientId } from "../inboxFilters";
import {
  resolveDeviceProfile,
  targetAccountEmail,
  tokenBackedProfile,
  continueTargetPin,
  continueNeedsRestart,
  runsPushedLogin,
  runsOwnFleet,
} from "../ccAccountsShared";
import { fleetHostFollowsSwitch } from "../ccSwitchAhead";
import { withSafetyBlock } from "@codecast/shared/contracts";

export async function hasUndeliveredContinue(ctx: { db: any }, conversationId: Id<"conversations">): Promise<boolean> {
  for (const status of ["pending", "injected"] as const) {
    const rows = await ctx.db
      .query("pending_messages")
      .withIndex("by_conversation_status", (q: any) => q.eq("conversation_id", conversationId).eq("status", status))
      .take(50);
    if (rows.some((m: any) => m.content === "continue")) return true;
  }
  return false;
}

// Claude Code re-reads the fleet store on its own interval. A continue that
// arrives before that re-read resumes on the account the fleet just left.
// The daemon waits this long (FLEET_REREAD_WAIT_MS in daemon.ts) and then
// spaces the resumes. Its count is recorded before the enqueue, and that
// enqueue dies with the handler's fire-and-forget, so the server sends the
// same continues under the same client id. Whichever insert lands first wins;
// the other is the client-id dedupe.
const FLEET_REREAD_WAIT_MS = 40_000;

// The switch/revive execution plan shared by the manual mutation and the
// auto-switch loop: route each blocked conversation to its online owner device
// (primary as fallback — it can reclaim sessions whose owner died, same rule
// the command executor applies) and insert one switch_account daemon command
// per involved device.
export async function insertSwitchCommands(
  ctx: { db: any },
  userId: Id<"users">,
  opts: {
    // Machine-local profile name (device-pinned callers: Settings, auto-switch
    // deciding from the primary's inventory). Resolved to an identity below.
    profile?: string;
    // The account's identity — the cross-device form. Each executing device
    // resolves it against its OWN inventory; names never travel.
    email?: string;
    blocked: Doc<"conversations">[];
    online: Doc<"devices">[];
    primary: Doc<"devices"> | undefined;
    continueBlocked: boolean;
    now: number;
    // A person's switch moves every cloud host that keeps its own fleet and
    // has the account saved, not only the hosts that currently own a parked
    // session. Otherwise the hosts with nothing parked stay on the account
    // the loop last picked and hop again.
    switchFleetHosts?: boolean;
    // conversation id -> the client_id the CALLER already painted its optimistic
    // "continue" bubble with (the web's revive buttons). Handed to the daemon so
    // its post-kill enqueue carries the same id and the server echo replaces that
    // bubble instead of doubling it. Absent for server-initiated revives (the
    // login-flow confirm, the auto-switch loop) — the daemon mints its own.
    continueClientIds?: Record<string, string>;
  },
): Promise<{
  devices: number;
  routed: number;
  // Of the routed: killed + resumed by a daemon command vs. sent a plain
  // continue (no-switch revives only; a switch restarts everything).
  restarted: number;
  messaged: number;
  unswitchable: number;
  unswitchableDevices: string[];
  commandIds: Id<"daemon_commands">[];
}> {
  const onlineById = new Map(opts.online.map((d) => [d.device_id, d]));
  const deviceFor = (deviceId: string): Doc<"devices"> | undefined =>
    onlineById.get(deviceId) ??
    (opts.primary?.device_id === deviceId ? opts.primary : undefined);
  const switchRequested = !!(opts.profile || opts.email);
  // The identity behind the request: an explicit email, or the email the
  // primary's inventory records for the named profile (absent on old daemons —
  // resolution then degrades to exact-name matching per device).
  const targetEmail = targetAccountEmail(opts.primary?.cc_accounts, {
    profile: opts.profile,
    email: opts.email,
  });

  // The plain "continue" for a session that needs no restart: the same
  // enqueue a hand-typed continue in its composer would make, under the
  // caller's painted client id when it sent one (the server echo then
  // replaces that bubble) or the shared minute-bucketed id otherwise (a
  // racing CLI run and a double-click collapse into one send).
  let messaged = 0;
  const sendContinue = async (conv: Doc<"conversations">) => {
    // An automatic continue still waiting to land already asks for the retry.
    // Queuing another each paced tick built a backlog (one row a minute while a
    // daemon read the session as busy) that drained as a refused turn every
    // second once it went idle (ct-51376). Auto-switch paints its own client
    // id per minute; that must not bypass this check or the same backlog
    // comes back through the limit path.
    if (await hasUndeliveredContinue(ctx, conv._id)) return;
    await enqueuePendingMessage(ctx, conv, userId, {
      content: "continue",
      client_id: opts.continueClientIds?.[conv._id] ?? blockedContinueClientId(conv._id, opts.now),
    });
    messaged++;
  };

  const groups = new Map<string, Doc<"conversations">[]>();
  for (const conv of opts.blocked) {
    if (withSafetyBlock(conv).pending_api_error_kind === "safety") continue;
    const owner =
      conv.owner_device_id && onlineById.has(conv.owner_device_id)
        ? conv.owner_device_id
        : opts.primary?.device_id;
    if (!owner) {
      // No daemon to execute a restart. A plain continue still has a home —
      // the delivery rail holds it until a daemon comes back — so the
      // no-switch revive queues it rather than dropping the session.
      if (!switchRequested && opts.continueBlocked) await sendContinue(conv);
      continue;
    }
    const list = groups.get(owner) ?? [];
    list.push(conv);
    groups.set(owner, list);
  }
  // Accounts are device-specific: a switch runs on the devices that own the
  // blocked sessions, not on the primary as a matter of course. The primary
  // joins without blocked work of its own in exactly two cases: a pure swap
  // (nothing blocked — the Settings flow), and a fleet with remote-owned
  // sessions (remotes never swap locally; their credential is the primary's
  // push, so the primary must perform the swap for their revive to matter).
  const hasRemoteGroup = [...groups.keys()].some((id) => runsPushedLogin(deviceFor(id)));
  if (
    switchRequested &&
    opts.primary &&
    !groups.has(opts.primary.device_id) &&
    (opts.blocked.length === 0 || hasRemoteGroup)
  ) {
    groups.set(opts.primary.device_id, []);
  }
  if (opts.switchFleetHosts && switchRequested) {
    for (const device of opts.online) {
      if (groups.has(device.device_id) || !runsOwnFleet(device)) continue;
      if (!fleetHostFollowsSwitch(device, { profile: opts.profile, email: targetEmail })) continue;
      groups.set(device.device_id, []);
    }
  }

  // A remote runs whatever account the primary pushes, so its sessions can
  // only continue "on the new account" if the primary itself can swap to it.
  const primaryCanSwitch =
    !switchRequested ||
    !!resolveDeviceProfile(opts.primary?.cc_accounts, {
      profile: opts.profile,
      email: targetEmail,
    });

  const commandIds: Id<"daemon_commands">[] = [];
  let routed = 0;
  let restarted = 0;
  let unswitchable = 0;
  const unswitchableDevices: string[] = [];
  for (const [deviceId, convs] of groups) {
    const device = deviceFor(deviceId);
    // A host on a fleet store of its own (line-pool copies) switches under
    // its own name for the account, like any local machine.
    const isRemote = runsPushedLogin(device);
    if (switchRequested && isRemote && !primaryCanSwitch) {
      unswitchable += convs.length;
      unswitchableDevices.push(device?.label ?? deviceId.slice(0, 8));
      continue;
    }
    // Each non-remote device swaps under its OWN name for the account. A
    // device that doesn't have the account saved cannot execute the switch —
    // sending a foreign profile name would make its daemon fail before the
    // kill and the continue, silently, after the UI reported success. Skip it
    // and report, so the fix ("save the account on that machine") is visible.
    let localProfile: string | undefined;
    if (switchRequested && !isRemote) {
      localProfile = resolveDeviceProfile(device?.cc_accounts, {
        profile: opts.profile,
        email: targetEmail,
      });
      if (!localProfile) {
        unswitchable += convs.length;
        unswitchableDevices.push(device?.label ?? deviceId.slice(0, 8));
        continue;
      }
    }
    routed += convs.length;
    // A switch restarts every targeted blocked session because its process is
    // bound to the old credential. A plain continue on the current account
    // restarts only the sessions a message cannot reach: signed-out ones, and
    // ones pinned to another account's setup-token — the rest get the message
    // a hand-typed continue would send.
    // On the fleet store a switch moves every session that follows the store,
    // so only the ones bound at launch (signed out, or pinned) restart; the
    // rest follow the store. Their continue waits out the re-read, then goes
    // out from the daemon and, on the same client id, from the server.
    const followsStore = switchRequested && !isRemote && device?.cc_accounts?.fleet_store === true;
    const restart = switchRequested && !followsStore
      ? convs
      : convs.filter((c) => continueNeedsRestart(c, device, opts.now));
    const follow = followsStore ? convs.filter((c) => !restart.includes(c)) : [];
    if (!switchRequested && opts.continueBlocked) {
      for (const c of convs) if (!restart.includes(c)) await sendContinue(c);
    }
    // The pin the restarted sessions resume under: the target account's token
    // (the switch target, or the machine's current login for a plain continue)
    // — or no pin when that account has no token, because a session left pinned
    // to the exhausted account would re-source it on resume and undo the revive.
    // The daemon reads the pin from the row at resume, so it is corrected here,
    // before the kill command exists.
    if (!isRemote) {
      const pin = switchRequested && !followsStore
        ? tokenBackedProfile(device?.cc_accounts, { profile: localProfile }, opts.now)
        : continueTargetPin(device, opts.now);
      for (const c of restart) {
        if ((c.cc_account ?? undefined) !== pin) await ctx.db.patch(c._id, { cc_account: pin, cc_account_auto: true });
      }
    }
    if (restart.length === 0 && !(switchRequested && !isRemote)) continue;
    restarted += restart.length;
    messaged += follow.length;
    commandIds.push(
      await ctx.db.insert("daemon_commands", {
        user_id: userId,
        command: "switch_account" as const,
        args: JSON.stringify({
          // Remotes never swap locally — their credential arrives via the
          // primary's push. They only recycle their blocked sessions.
          profile: isRemote ? undefined : localProfile,
          conversation_ids: restart.map((c) => c._id),
          ...(follow.length > 0 && opts.continueBlocked ? { follow_ids: follow.map((c) => c._id) } : {}),
          session_ids: Object.fromEntries(restart.map((c) => [c._id, c.session_id])),
          continue_blocked: opts.continueBlocked,
          ...(opts.continueClientIds
            ? {
                client_ids: Object.fromEntries(
                  [...restart, ...follow]
                    .map((c) => [c._id, opts.continueClientIds![c._id]] as const)
                    .filter(([, clientId]) => !!clientId),
                ),
              }
            : {}),
        }),
        created_at: opts.now,
        target_device_id: deviceId,
      }),
    );
    // The daemon reports `continued` before it enqueues, then does the enqueue
    // after this handler has already returned. When that loop never lands, the
    // sessions stay parked on the account they were switched to. This chain
    // sends the same client id the daemon would, paced the same way.
    const paced = opts.continueBlocked ? [...restart, ...follow] : [];
    const commandId = commandIds[commandIds.length - 1];
    // Callers that drive this with a fake db (the recovery tests) pass no
    // scheduler. A present runAfter is the production mutation ctx.
    const runAfter = (ctx as { scheduler?: { runAfter?: (delayMs: number, fn: any, args: any) => Promise<unknown> } }).scheduler?.runAfter;
    if (paced.length > 0 && runAfter && switchRequested) {
      await runAfter(
        follow.length > 0 ? FLEET_REREAD_WAIT_MS : 0,
        internal.accountSwitch.enqueueSwitchContinue,
        {
          user_id: userId,
          command_id: commandId,
          conversation_ids: paced.map((c) => c._id),
          index: 0,
          ...(opts.continueClientIds ? { client_ids: opts.continueClientIds } : {}),
        },
      );
    }
  }
  return { devices: commandIds.length, routed, restarted, messaged, unswitchable, unswitchableDevices, commandIds };
}
