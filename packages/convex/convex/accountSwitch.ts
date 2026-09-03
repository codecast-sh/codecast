// Claude Code account switching + mass-continue for limit-blocked sessions.
//
// The daemon owns the actual swap (the credential lives in the machine's
// keychain) and the teardown ordering (kill blocked processes BEFORE the
// "continue" messages land, or a still-alive process retries on the old
// account's in-memory token). This module owns the SELECTION: which
// conversations are parked on an API-error banner (pending_api_error, stamped
// by messages.ts from the shared classifier in
// @codecast/shared/contracts/apiErrorBanner), which device executes, and the
// "continue" enqueue for the no-swap case (limit window reset).

import { mutation, query, internalMutation } from "./functions";
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { Id, Doc } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { getAuthenticatedUserId, enqueuePendingMessage } from "./pendingMessages";
import { classifyApiErrorBanner, blockedContinueClientId, CONTINUE_BANNER_KINDS, newestSignificantMessage, isBannerTurn } from "./inboxFilters";
import {
  actedBlockedConversations,
  ccAccountsValidator,
  decideAutoSwitch,
  AUTO_SWITCH_CONTINUE_KEY,
  AUTO_CONTINUE_WINDOW_MS,
  isAutoContinueEnabled,
  isBlockedConversation,
  isRemoteAuthBlocked,
  isSubagentConversation,
  isDeviceOnline,
  isValidProfileName,
  resolveDeviceProfile,
  targetAccountEmail,
  shouldSweepStaleFlag,
  LOGIN_FLOW_STALE_MS,
  MINT_FLOW_STALE_MS,
  STALE_FLAG_AFTER_MS,
  tokenBackedProfile,
  activeTokenProfile,
  continueTargetPin,
  continueNeedsRestart,
} from "./ccAccountsShared";
import { deliverSessionNotificationToParties } from "./notifications";

// The freshest online NON-remote device: it holds the keychain profiles and is
// the canonical credential source remotes are pushed from.
async function listOnlineDevices(
  ctx: { db: any },
  userId: Id<"users">,
  now: number,
): Promise<{ online: Doc<"devices">[]; primary: Doc<"devices"> | undefined }> {
  const devices: Doc<"devices">[] = await ctx.db
    .query("devices")
    .withIndex("by_user_id", (q: any) => q.eq("user_id", userId))
    .collect();
  const online = devices.filter((d) => isDeviceOnline(d, now));
  const primary = online
    .filter((d) => !d.is_remote)
    .sort((a, b) => b.last_seen - a.last_seen)[0];
  return { online, primary };
}

// A revive targets the CURRENT incident, not history: pending_api_error flags
// linger on sessions that died mid-banner weeks ago (first live run selected 51
// conversations, 50 of them stale). 48h covers "the fleet hit the limit
// overnight" while excluding the graveyard; the cap bounds the resume stampede
// a mass-revive can trigger (each continue may spawn a `claude --resume`).
const BLOCKED_WINDOW_MS = 48 * 60 * 60 * 1000;
const MAX_REVIVE = 30;

// Blocked conversations split by standing: subagents (workers spawned by/for
// another session) are excluded from the default revive — their parent has
// usually moved on, so resuming them spends the fresh account on work nobody
// is waiting for. `includeSubagents` opts them back in; the cap applies to the
// combined acted set, top-level first.
async function listBlockedConversations(
  ctx: { db: any },
  userId: Id<"users">,
  includeSubagents: boolean,
): Promise<{
  blocked: Doc<"conversations">[];
  topLevelCount: number;
  subagentCount: number;
  totalBlocked: number;
}> {
  const since = Date.now() - BLOCKED_WINDOW_MS;
  const recent = await ctx.db
    .query("conversations")
    .withIndex("by_user_updated", (q: any) => q.eq("user_id", userId).gt("updated_at", since))
    .order("desc")
    .take(1000);
  const all: Doc<"conversations">[] = recent.filter(isBlockedConversation);
  const topLevel = all.filter((c: Doc<"conversations">) => !isSubagentConversation(c));
  const subagents = all.filter(isSubagentConversation);
  const acted = actedBlockedConversations(all, includeSubagents).slice(0, MAX_REVIVE);
  return {
    blocked: acted,
    topLevelCount: topLevel.length,
    subagentCount: subagents.length,
    totalBlocked: all.length,
  };
}

// Send "continue" to every session parked on a usage-limit or dropped
// connection banner — the post-reset nudge, no account change. The
// processes are typically still alive at the prompt, so plain injection
// retries them; dead ones auto-resume via the delivery rail's repair ladder.
// auth-kind banners are excluded by default: continuing a logged-out session
// just re-fails — that set needs requestAccountSwitch.
export const continueAllBlocked = mutation({
  args: {
    api_token: v.optional(v.string()),
    kinds: v.optional(v.array(v.string())),
    // Subagent workers are skipped unless explicitly included (their parent
    // has usually moved on — reviving them is wasted spend).
    include_subagents: v.optional(v.boolean()),
    // Report what WOULD be continued without enqueueing anything — the CLI
    // shows this and asks before a mass action.
    dry_run: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) throw new Error("Authentication failed: invalid token or session");

    // limit + connection + fatal by default: all un-park with a plain continue
    // (the limit window rolled / the dead turn retries). auth-blocked sessions
    // need a switch (plain continue re-fails) and error-kind (statusful
    // 429/5xx, self-retrying) never enters the selection at all.
    const kinds = new Set(args.kinds ?? CONTINUE_BANNER_KINDS);
    const { blocked: candidates, topLevelCount, subagentCount, totalBlocked } =
      await listBlockedConversations(ctx, userId, args.include_subagents === true);
    const blocked = candidates.filter((c) => kinds.has(c.pending_api_error_kind ?? "error"));
    if (args.dry_run) {
      return {
        continued: 0,
        would_continue: blocked.length,
        top_level: topLevelCount,
        subagents: subagentCount,
        total_blocked: totalBlocked,
      };
    }

    // The no-switch revive: a plain continue for every session a message can
    // reach, a kill + resume (with its account pin corrected) for the ones it
    // cannot — a session pinned to another account's setup-token would only
    // re-fail on that account.
    const now = Date.now();
    const { online, primary } = await listOnlineDevices(ctx, userId, now);
    const res = await insertSwitchCommands(ctx, userId, {
      profile: undefined,
      blocked,
      online,
      primary,
      continueBlocked: true,
      now,
    });
    return {
      continued: res.messaged + res.restarted,
      restarted: res.restarted,
      subagents: subagentCount,
      total_blocked: totalBlocked,
    };
  },
});

// Ask the daemon fleet to switch the active CC account to a saved profile and
// revive every blocked session on the new account. One switch_account command
// per involved device: each carries that device's blocked conversations; the
// daemon swaps (non-remote only — remotes run on a credential PUSHED from the
// primary, never their own), kills those processes, then enqueues the
// continues. With no `profile` this degrades to revive-only (kill + continue).
export const requestAccountSwitch = mutation({
  args: {
    api_token: v.optional(v.string()),
    profile: v.optional(v.string()),
    // The target account's identity. Profile NAMES are machine-local aliases,
    // so a cross-device switch passes the email and each executing device
    // resolves its own name; `profile` remains for device-pinned callers
    // (Settings) and is resolved to an email via the executing device's
    // inventory when possible.
    email: v.optional(v.string()),
    // false = pure swap, touch no sessions (the Settings page's switch). The
    // default (true) is the incident flow: kill + continue the blocked set.
    continue_blocked: v.optional(v.boolean()),
    // Pin the executing device (Settings shows per-device profiles). Defaults
    // to the primary; revives still fan out to blocked sessions' owners.
    device_id: v.optional(v.string()),
    // Subagent workers are skipped unless explicitly included (their parent
    // has usually moved on — reviving them is wasted spend).
    include_subagents: v.optional(v.boolean()),
    // Report the selection without inserting any daemon command — the CLI
    // shows this and asks before a mass revive.
    dry_run: v.optional(v.boolean()),
    // conversation id -> client_id, from a caller that already painted the
    // "continue" locally (the web's revive buttons paint every acted session
    // on the click). Forwarded to the daemon so its enqueue carries the same
    // id and the echo replaces the painted bubble.
    continue_client_ids: v.optional(v.record(v.string(), v.string())),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) throw new Error("Authentication failed: invalid token or session");

    const now = Date.now();
    const reviveWanted = args.continue_blocked !== false;
    const { blocked, topLevelCount, subagentCount, totalBlocked } = reviveWanted
      ? await listBlockedConversations(ctx, userId, args.include_subagents === true)
      : { blocked: [], topLevelCount: 0, subagentCount: 0, totalBlocked: 0 };
    if (args.dry_run) {
      return {
        devices: 0,
        conversations: blocked.length,
        top_level: topLevelCount,
        subagents: subagentCount,
        total_blocked: totalBlocked,
        unreachable: 0,
        command_ids: [],
        dry_run: true,
      };
    }
    const { online, primary: freshestPrimary } = await listOnlineDevices(ctx, userId, now);
    const onlineById = new Map(online.map((d: any) => [d.device_id, d]));
    const primary = args.device_id ? onlineById.get(args.device_id) : freshestPrimary;

    if (!primary && (args.profile || args.email)) {
      throw new Error(
        args.device_id
          ? "That device's daemon is offline"
          : "No online daemon on a primary (non-remote) device to execute the switch",
      );
    }

    const res = await insertSwitchCommands(ctx, userId, {
      profile: args.profile,
      email: args.email,
      blocked,
      online,
      primary,
      continueBlocked: args.continue_blocked !== false,
      now,
      continueClientIds: args.continue_client_ids,
    });
    // A switch that no device could execute is a failure, not a quiet no-op:
    // tell the caller which machines lack the account instead of letting the
    // sessions drift back to blocked after an optimistic success toast.
    if ((args.profile || args.email) && res.devices === 0) {
      throw new Error(
        `No online device has the account ${args.email ?? `"${args.profile}"`} saved` +
          (res.unswitchableDevices.length > 0
            ? ` (missing on ${res.unswitchableDevices.join(", ")})`
            : "") +
          " — log into it there once and save it: cast accounts save <name>",
      );
    }

    return {
      devices: res.devices,
      conversations: res.routed,
      // No-switch revives split: sessions a message reaches vs. sessions
      // killed + resumed first (signed out, or pinned to another account).
      restarted: res.restarted,
      messaged: res.messaged,
      subagents: subagentCount,
      total_blocked: totalBlocked,
      unreachable: blocked.length - res.routed - res.unswitchable,
      // Sessions owned by machines that don't have the target account saved —
      // no command was sent for them; the account must be saved there first.
      unswitchable: res.unswitchable,
      unswitchable_devices: res.unswitchableDevices,
      command_ids: res.commandIds,
    };
  },
});

// The switch/revive execution plan shared by the manual mutation and the
// auto-switch loop: route each blocked conversation to its online owner device
// (primary as fallback — it can reclaim sessions whose owner died, same rule
// the command executor applies) and insert one switch_account daemon command
// per involved device.
async function insertSwitchCommands(
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
    await enqueuePendingMessage(ctx, conv, userId, {
      content: "continue",
      client_id: opts.continueClientIds?.[conv._id] ?? blockedContinueClientId(conv._id, opts.now),
    });
    messaged++;
  };

  const groups = new Map<string, Doc<"conversations">[]>();
  for (const conv of opts.blocked) {
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
  const hasRemoteGroup = [...groups.keys()].some((id) => deviceFor(id)?.is_remote === true);
  if (
    switchRequested &&
    opts.primary &&
    !groups.has(opts.primary.device_id) &&
    (opts.blocked.length === 0 || hasRemoteGroup)
  ) {
    groups.set(opts.primary.device_id, []);
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
    const isRemote = device?.is_remote === true;
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
    // A switch restarts every session (the keychain swap invalidates the
    // token each process holds). A plain continue on the current account
    // restarts only the sessions a message cannot reach: signed-out ones,
    // and ones pinned to another account's setup-token — the rest get the
    // message a hand-typed continue would send.
    const restart = switchRequested
      ? convs
      : convs.filter((c) => continueNeedsRestart(c, device, opts.now));
    if (!switchRequested && opts.continueBlocked) {
      for (const c of convs) if (!restart.includes(c)) await sendContinue(c);
    }
    // The pin the restarted sessions resume under. Per-session tokens on
    // this device: the target account's token (the switch target, or the
    // machine's current login for a plain continue) — or no pin when that
    // account has no token, because a session left pinned to the exhausted
    // account would re-source it on resume and undo the revive. The daemon
    // reads the pin from the row at resume, so it is corrected here, before
    // the kill command exists.
    if (!isRemote) {
      const pin = switchRequested
        ? device?.cc_session_tokens === true
          ? tokenBackedProfile(device.cc_accounts, { profile: localProfile }, opts.now)
          : undefined
        : continueTargetPin(device, opts.now);
      for (const c of restart) {
        if ((c.cc_account ?? undefined) !== pin) await ctx.db.patch(c._id, { cc_account: pin });
      }
    }
    if (restart.length === 0 && !(switchRequested && !isRemote)) continue;
    restarted += restart.length;
    commandIds.push(
      await ctx.db.insert("daemon_commands", {
        user_id: userId,
        command: "switch_account" as const,
        args: JSON.stringify({
          // Remotes never swap locally — their credential arrives via the
          // primary's push. They only recycle their blocked sessions.
          profile: isRemote ? undefined : localProfile,
          conversation_ids: restart.map((c) => c._id),
          session_ids: Object.fromEntries(restart.map((c) => [c._id, c.session_id])),
          continue_blocked: opts.continueBlocked,
          ...(opts.continueClientIds
            ? {
                client_ids: Object.fromEntries(
                  restart
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
  }
  return { devices: commandIds.length, routed, restarted, messaged, unswitchable, unswitchableDevices, commandIds };
}

// The recovery nudge for remote Macs: they run a COPY of the primary's
// credential and cannot /login themselves, so when that copy goes stale their
// sessions park on an auth banner ("Login expired") until a fresh push lands.
// The primary daemon calls this right after pushing a CHANGED credential —
// the causal event that makes recovery possible (CC re-reads the credential
// store on its next turn, so a plain "continue" completes it). Selection
// stays narrow on purpose: auth-kind banners only, conversations owned by
// remote devices only, inside the recent-incident window, subagents excluded.
export const reviveAuthBlockedOnRemotes = mutation({
  args: {
    api_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) throw new Error("Authentication failed: invalid token or session");

    const devices: Doc<"devices">[] = await ctx.db
      .query("devices")
      .withIndex("by_user_id", (q: any) => q.eq("user_id", userId))
      .collect();
    const remoteIds = new Set(devices.filter((d) => d.is_remote === true).map((d) => d.device_id));
    if (remoteIds.size === 0) return { continued: 0 };

    const { blocked } = await listBlockedConversations(ctx, userId, false);
    const targets = blocked.filter((c) => isRemoteAuthBlocked(c, remoteIds));
    const bucket = Math.floor(Date.now() / 60_000);
    for (const conv of targets) {
      await enqueuePendingMessage(ctx, conv, userId, {
        content: "continue",
        client_id: `remote-auth-revive-${conv._id}-${bucket}`,
      });
    }
    return { continued: targets.length };
  },
});

// ---------------------------------------------------------------------------
// Blocked-incident notification: one aggregated bell/push per park burst
// ---------------------------------------------------------------------------

// Same debounce idea as the auto-switch check: a fleet parks over ~a minute,
// and one notification covering the burst beats one per session.
const BLOCKED_NOTIFY_DEBOUNCE_MS = 60 * 1000;
// A fresh casualty inside the cooldown stays silent (the banner/pill already
// show it); past the cooldown a new park re-announces the incident.
const BLOCKED_NOTIFY_COOLDOWN_MS = 30 * 60 * 1000;

/** The single hook the message paths call when a conversation freshly parks on
 * a blocked-kind banner (auth/limit/connection/fatal — never self-retrying "error").
 * Fans out to both reactions: the auto-switch check (limit and auth parks —
 * the check itself gates auth on the opt-in flag) and the debounced incident
 * notification (all blocked kinds). Both are idempotent and self-gating, so
 * over-scheduling is harmless. */
export async function onFreshApiErrorPark(
  ctx: { scheduler: { runAfter: (ms: number, fn: any, args: any) => Promise<any> } },
  userId: Id<"users">,
  kind: string,
): Promise<void> {
  if (kind === "limit" || kind === "auth") await scheduleAutoSwitchCheck(ctx, userId);
  await ctx.scheduler.runAfter(BLOCKED_NOTIFY_DEBOUNCE_MS, internal.accountSwitch.blockedNotifyCheck, {
    user_id: userId,
  });
}

// The debounced check: recount the blocked set at fire time and notify once
// per incident. Dedupe state lives on the user row (one write per incident):
// a park older than last_park_ts is already covered; a newer one inside the
// cooldown rides the existing banner; past the cooldown it announces again.
// The notification anchors on the newest blocked conversation and uses the
// session-STATE delivery (supersede, not stack), so the bell holds at most
// one "blocked" row and each new episode still raises a fresh push.
export const blockedNotifyCheck = internalMutation({
  args: { user_id: v.id("users") },
  handler: async (ctx, args) => {
    const { blocked, totalBlocked, subagentCount } = await listBlockedConversations(
      ctx,
      args.user_id,
      true,
    );
    if (blocked.length === 0) return { notified: false, reason: "nothing_blocked" };
    const user = await ctx.db.get(args.user_id);
    if (!user) return { notified: false, reason: "no_user" };

    const now = Date.now();
    const newestPark = Math.max(...blocked.map((c) => c.updated_at ?? 0));
    const state = user.blocked_notify_state;
    if (state && newestPark <= state.last_park_ts) return { notified: false, reason: "covered" };
    if (state && now - state.last_notified_at < BLOCKED_NOTIFY_COOLDOWN_MS) {
      return { notified: false, reason: "cooldown" };
    }

    const authCount = blocked.filter((c) => c.pending_api_error_kind === "auth").length;
    const connCount = blocked.filter((c) => c.pending_api_error_kind === "connection").length;
    const fatalCount = blocked.filter((c) => c.pending_api_error_kind === "fatal").length;
    const limitCount = blocked.length - authCount - connCount - fatalCount;
    // Same headline the banner leads with.
    const on =
      limitCount > 0 ? "usage limits" : connCount > 0 ? "dropped connections" : fatalCount > 0 ? "api errors" : "login";
    const title = `${totalBlocked} session${totalBlocked === 1 ? "" : "s"} blocked on ${on}`;
    const parts = [
      limitCount > 0 ? `${limitCount} hit a usage limit` : null,
      connCount > 0 ? `${connCount} dropped mid-response` : null,
      fatalCount > 0 ? `${fatalCount} failed on an api error` : null,
      authCount > 0 ? `${authCount} signed out` : null,
    ].filter(Boolean);
    const hint = authCount > 0 ? "sign in to revive them" : "revive them from the inbox";
    const message =
      parts.join(" · ") +
      (subagentCount > 0 ? ` (${subagentCount} subagent${subagentCount === 1 ? "" : "s"})` : "") +
      ` — ${hint}.`;

    const anchor = [...blocked].sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0))[0];
    // Stamp BEFORE delivering so a racing duplicate check can't double-push.
    await ctx.db.patch(user._id, {
      blocked_notify_state: { last_notified_at: now, last_park_ts: newestPark },
    });
    const delivered = await deliverSessionNotificationToParties(
      ctx,
      anchor,
      "session_error",
      title,
      message,
    );
    return { notified: delivered };
  },
});

// ---------------------------------------------------------------------------
// Browser sign-in flow: the banner's "Sign in as <email>" CTA
// ---------------------------------------------------------------------------

// The web CTA: ask the primary daemon to run `claude auth login` (which opens
// the machine's browser on the OAuth page, pre-filled with the expired
// account's email). The device row's cc_login_flow field is the UI's state
// channel: this stamps it "pending"; the daemon's completeLoginFlow report
// flips it to confirmed/rejected.
export const requestLoginFlow = mutation({
  args: {
    api_token: v.optional(v.string()),
    device_id: v.optional(v.string()),
    // Relaunch over a live pending flow (the browser tab never opened or got
    // closed) — skips the pending gate here and tells the daemon to supersede
    // its running flow instead of joining it.
    force: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) throw new Error("Authentication failed: invalid token or session");

    const now = Date.now();
    const { online, primary: freshestPrimary } = await listOnlineDevices(ctx, userId, now);
    const target = args.device_id
      ? online.find((d) => d.device_id === args.device_id)
      : freshestPrimary;
    if (!target) {
      throw new Error(
        args.device_id
          ? "That device's daemon is offline"
          : "No online daemon on a primary (non-remote) machine to run the sign-in",
      );
    }
    if (target.is_remote) {
      throw new Error(
        "Remote devices run a pushed copy of the primary's credential — sign in on the primary machine",
      );
    }

    // A fresh pending flow is already mid-OAuth in the browser — don't launch
    // a second one over it. (A stale pending row means the daemon died
    // mid-flow; starting over is exactly right.)
    const existing = target.cc_login_flow;
    if (!args.force && existing?.status === "pending" && now - existing.started_at < LOGIN_FLOW_STALE_MS) {
      return { device_id: target.device_id, email: existing.email, already_pending: true };
    }

    const email = target.cc_accounts?.active_email;
    await ctx.db.patch(target._id, {
      cc_login_flow: { status: "pending" as const, email, started_at: now },
    });
    const commandId = await ctx.db.insert("daemon_commands", {
      user_id: userId,
      command: "start_login" as const,
      args: JSON.stringify({ email, ...(args.force ? { force: true } : {}) }),
      created_at: now,
      target_device_id: target.device_id,
    });
    return { command_id: commandId, device_id: target.device_id, email };
  },
});

// The daemon's outcome report. Confirmed additionally kicks off the recovery
// the user was promised: kill + continue every auth-blocked session owned by
// non-remote devices (the exact no-profile switch_account machinery the
// banner's "continue on current account" uses). Remote-owned sessions are
// deliberately excluded — their recovery is the credential push rail (the
// daemon pushes the fresh blob, and reviveAuthBlockedOnRemotes nudges them
// once it lands), and acting here would race a continue against a credential
// that hasn't arrived yet.
export const completeLoginFlow = mutation({
  args: {
    api_token: v.optional(v.string()),
    device_id: v.string(),
    status: v.union(v.literal("confirmed"), v.literal("rejected")),
    email: v.optional(v.string()),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) throw new Error("Authentication failed: invalid token or session");
    const device = await ctx.db
      .query("devices")
      .withIndex("by_user_device", (q) => q.eq("user_id", userId).eq("device_id", args.device_id))
      .first();
    if (!device) return { revived: 0 };

    const now = Date.now();
    let revived = 0;
    if (args.status === "confirmed") {
      const allDevices: Doc<"devices">[] = await ctx.db
        .query("devices")
        .withIndex("by_user_id", (q: any) => q.eq("user_id", userId))
        .collect();
      const remoteIds = new Set(
        allDevices.filter((d) => d.is_remote === true).map((d) => d.device_id),
      );
      const online = allDevices.filter((d) => isDeviceOnline(d, now));
      const { blocked } = await listBlockedConversations(ctx, userId, false);
      const authBlocked = blocked.filter(
        (c) =>
          c.pending_api_error_kind === "auth" &&
          !(c.owner_device_id && remoteIds.has(c.owner_device_id)),
      );
      const res = await insertSwitchCommands(ctx, userId, {
        profile: undefined,
        blocked: authBlocked,
        online,
        primary: device,
        continueBlocked: true,
        now,
      });
      revived = res.routed;
    }

    const prior = device.cc_login_flow;
    await ctx.db.patch(device._id, {
      cc_login_flow: {
        status: args.status,
        email: args.email ?? prior?.email,
        ...(args.reason ? { reason: args.reason } : {}),
        started_at: prior?.started_at ?? now,
        finished_at: now,
        ...(args.status === "confirmed" ? { revived } : {}),
      },
    });
    return { revived };
  },
});

// The user's permanent "don't ever restart these" decision: clear the banner
// flag on the given conversations so they leave the blocked set for good (a
// session only re-enters by hitting a NEW banner). The web applies the same
// clear optimistically; this persists it.
export const acknowledgeBlocked = mutation({
  args: {
    api_token: v.optional(v.string()),
    conversation_ids: v.array(v.id("conversations")),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) throw new Error("Authentication failed: invalid token or session");
    let acknowledged = 0;
    for (const convId of args.conversation_ids.slice(0, 200)) {
      const conv = await ctx.db.get(convId);
      if (!conv || conv.user_id.toString() !== userId.toString()) continue;
      if (conv.pending_api_error !== true) continue;
      await ctx.db.patch(convId, { pending_api_error: false, pending_api_error_kind: undefined, pending_api_error_at: undefined });
      acknowledged++;
    }
    return { acknowledged };
  },
});

// Snapshot the device's CURRENTLY logged-in account as a named profile —
// the web Settings flow for enrolling an account without touching a terminal
// (the user /logins once, then clicks save). Executes daemon-side (the
// credential lives in that machine's keychain); the saved profile appears in
// the UI when the daemon's next heartbeat reports it.
export const saveAccountProfile = mutation({
  args: {
    api_token: v.optional(v.string()),
    name: v.string(),
    device_id: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) throw new Error("Authentication failed: invalid token or session");
    if (!isValidProfileName(args.name)) {
      throw new Error("Profile names: letters/digits/dot/dash/underscore, max 41 chars");
    }

    const { online, primary: freshestPrimary } = await listOnlineDevices(ctx, userId, Date.now());
    const target = args.device_id
      ? online.find((d: any) => d.device_id === args.device_id)
      : freshestPrimary;
    if (!target) {
      throw new Error(args.device_id ? "That device's daemon is offline" : "No online daemon to save the profile");
    }
    if (target.is_remote) {
      throw new Error("Remote devices run a pushed copy of the primary's credential — save profiles on the primary machine");
    }

    const commandId = await ctx.db.insert("daemon_commands", {
      user_id: userId,
      command: "switch_account" as const,
      args: JSON.stringify({ save_as: args.name }),
      created_at: Date.now(),
      target_device_id: target.device_id,
    });
    return { command_id: commandId, device_id: target.device_id };
  },
});

// Forget a saved profile on a device — the web Settings remove button. The
// snapshot lives in that machine's keychain, so the actual deletion executes
// daemon-side; this eagerly drops the profile from the device's reported
// inventory so every client updates instantly. The heartbeat republishes the
// machine's real inventory each beat, so a failed daemon-side delete
// resurrects the row on its own. Removing the profile that covers the ACTIVE
// login is rejected here too (the daemon would refuse anyway — its auto-enroll
// re-saves the active login — but command errors never reach the web).
export const removeAccountProfile = mutation({
  args: {
    api_token: v.optional(v.string()),
    name: v.string(),
    device_id: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) throw new Error("Authentication failed: invalid token or session");
    if (!isValidProfileName(args.name)) {
      throw new Error("Profile names: letters/digits/dot/dash/underscore, max 41 chars");
    }

    const { online } = await listOnlineDevices(ctx, userId, Date.now());
    const target = online.find((d) => d.device_id === args.device_id);
    if (!target) throw new Error("That device's daemon is offline");
    const accounts = target.cc_accounts;
    const profile = accounts?.profiles.find((p) => p.name === args.name);
    if (!accounts || !profile) throw new Error(`No saved profile "${args.name}" on that device`);
    if (profile.email && profile.email === accounts.active_email) {
      throw new Error(
        `"${args.name}" is that machine's active login — switch to another account first`,
      );
    }

    const commandId = await ctx.db.insert("daemon_commands", {
      user_id: userId,
      command: "switch_account" as const,
      args: JSON.stringify({ remove: args.name }),
      created_at: Date.now(),
      target_device_id: target.device_id,
    });
    await ctx.db.patch(target._id, {
      cc_accounts: {
        ...accounts,
        profiles: accounts.profiles.filter((p) => p.name !== args.name),
      },
    });
    return { command_id: commandId, device_id: target.device_id };
  },
});

// Direct push of a device's account inventory, bypassing the heartbeat cycle:
// the CLI calls this right after `cast accounts save`/`use` so the Settings
// page reflects the change the moment the command returns instead of on the
// next beat. Same payload the heartbeat carries (names/emails/tiers, never
// tokens). Only patches an EXISTING device row — the heartbeat remains the
// sole creator, so a stray publish can't fabricate device presence.
export const publishDeviceAccounts = mutation({
  args: {
    api_token: v.optional(v.string()),
    device_id: v.string(),
    cc_accounts: ccAccountsValidator,
  },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) throw new Error("Authentication failed: invalid token or session");
    const device = await ctx.db
      .query("devices")
      .withIndex("by_user_device", (q) => q.eq("user_id", userId).eq("device_id", args.device_id))
      .first();
    if (!device) return { published: false };
    await ctx.db.patch(device._id, { cc_accounts: args.cc_accounts });
    return { published: true };
  },
});

// ---------------------------------------------------------------------------
// Auto-switch: unattended switch & continue for limit-parked sessions
// ---------------------------------------------------------------------------

// Give a switch time to settle before acting again: the kill + resume +
// "continue" round trip takes a couple of minutes, and a premature second
// action would burn another account on sessions that were about to recover.
const AUTO_SWITCH_COOLDOWN_MS = 3 * 60 * 1000;
// Debounce between a limit banner landing and the check: lets a fleet-wide
// park burst coalesce into one decision instead of one per session.
const AUTO_SWITCH_DEBOUNCE_MS = 45 * 1000;
const MAX_ATTEMPT_HISTORY = 12;

/** Schedule an auto-switch check for this user. Called from the message paths
 * that stamp a limit-kind banner — the event that makes a check worth running.
 * The check is idempotent and self-gating (no-ops without the device flag), so
 * over-scheduling is harmless. */
export async function scheduleAutoSwitchCheck(
  ctx: { scheduler: { runAfter: (ms: number, fn: any, args: any) => Promise<any> } },
  userId: Id<"users">,
): Promise<void> {
  await ctx.scheduler.runAfter(AUTO_SWITCH_DEBOUNCE_MS, internal.accountSwitch.autoSwitchCheck, {
    user_id: userId,
  });
}

// The recovery toggles live on the device row because both behaviors are
// machine-global — it's this machine's login that rotates through profiles
// (auto-switch) or waits for its own window to reset (auto-continue). Remotes
// mirror the primary's account, so neither applies to them.
async function loadPrimaryForToggle(
  ctx: { db: any },
  userId: Id<"users">,
  deviceId: string,
): Promise<Doc<"devices">> {
  const device = await ctx.db
    .query("devices")
    .withIndex("by_user_device", (q: any) => q.eq("user_id", userId).eq("device_id", deviceId))
    .first();
  if (!device) throw new Error("Unknown device");
  if (device.is_remote) {
    throw new Error("Auto-switch runs on the primary machine — remotes mirror its account");
  }
  return device;
}

// The primary machine's recovery flags, for the CLI (`cast usage`): what
// happens to a session on this machine when its account hits a limit. Token
// auth so a daemon-side caller can ask without a browser session.
export const recoveryStatus = query({
  args: { api_token: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) return null;
    const { primary } = await listOnlineDevices(ctx, userId, Date.now());
    if (!primary) return null;
    return {
      device_id: primary.device_id,
      auto_switch: primary.cc_auto_switch === true,
      auto_continue: isAutoContinueEnabled(primary),
      session_tokens: primary.cc_session_tokens === true,
    };
  },
});

// The web toggle for account rotation.
export const setAutoSwitchAccounts = mutation({
  args: {
    api_token: v.optional(v.string()),
    device_id: v.string(),
    enabled: v.boolean(),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) throw new Error("Authentication failed: invalid token or session");
    const device = await loadPrimaryForToggle(ctx, userId, args.device_id);
    await ctx.db.patch(device._id, {
      cc_auto_switch: args.enabled,
      // A fresh toggle starts a fresh incident history either way.
      cc_auto_switch_state: undefined,
    });
    // Turning it on while sessions are already parked should act now, not on
    // the next limit event.
    if (args.enabled) {
      await scheduleAutoSwitchCheck(ctx, userId);
    }
    return { enabled: args.enabled };
  },
});

// ---------------------------------------------------------------------------
// Per-session accounts (setup-tokens)
// ---------------------------------------------------------------------------

// Start a mint on a device: stamp the pending state the web watches and hand
// the daemon a `mint` mode of switch_account (a mode, like save_as/remove, so
// daemons that predate it ignore it — they see no `profile`, no sessions —
// instead of failing an unknown command). The token is always minted for the
// machine's CURRENT login: that is the account the browser is signed into.
async function enqueueMintFlow(
  ctx: { db: any },
  userId: Id<"users">,
  target: Doc<"devices">,
  opts: { force?: boolean; now: number },
): Promise<{ device_id: string; profile?: string; email?: string; already_pending?: boolean; command_id?: Id<"daemon_commands"> }> {
  const existing = target.cc_mint_flow;
  if (!opts.force && existing?.status === "pending" && opts.now - existing.started_at < MINT_FLOW_STALE_MS) {
    return { device_id: target.device_id, profile: existing.profile, email: existing.email, already_pending: true };
  }
  const email = target.cc_accounts?.active_email;
  const profile = email ? resolveDeviceProfile(target.cc_accounts, { email }) : undefined;
  if (!profile) {
    throw new Error(
      "The machine's current login isn't saved as a profile yet — the daemon saves it within ~30 seconds; try again then",
    );
  }
  await ctx.db.patch(target._id, {
    cc_mint_flow: { status: "pending" as const, profile, email, started_at: opts.now },
  });
  const commandId = await ctx.db.insert("daemon_commands", {
    user_id: userId,
    command: "switch_account" as const,
    args: JSON.stringify({ mint: profile, ...(opts.force ? { force: true } : {}) }),
    created_at: opts.now,
    target_device_id: target.device_id,
  });
  return { command_id: commandId, device_id: target.device_id, profile, email };
}

// The web toggle. Turning it on mints for the current login right away when
// it has no token yet (the daemon's own auto-mint would catch it on the next
// beat; acting now is what the click promised).
export const setSessionTokens = mutation({
  args: {
    api_token: v.optional(v.string()),
    device_id: v.string(),
    enabled: v.boolean(),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) throw new Error("Authentication failed: invalid token or session");
    const device = await loadPrimaryForToggle(ctx, userId, args.device_id);
    await ctx.db.patch(device._id, { cc_session_tokens: args.enabled });
    let mint: Awaited<ReturnType<typeof enqueueMintFlow>> | null = null;
    const now = Date.now();
    if (args.enabled && isDeviceOnline(device, now) && !activeTokenProfile(device.cc_accounts, now)) {
      try {
        mint = await enqueueMintFlow(ctx, userId, device, { now });
      } catch {
        // No saved profile for the login yet — the daemon auto-mints once it is.
      }
    }
    return { enabled: args.enabled, mint };
  },
});

// The web's "mint now" / "try again" button.
export const requestMintToken = mutation({
  args: {
    api_token: v.optional(v.string()),
    device_id: v.optional(v.string()),
    force: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) throw new Error("Authentication failed: invalid token or session");
    const now = Date.now();
    const { online, primary: freshestPrimary } = await listOnlineDevices(ctx, userId, now);
    const target = args.device_id ? online.find((d) => d.device_id === args.device_id) : freshestPrimary;
    if (!target) {
      throw new Error(args.device_id ? "That device's daemon is offline" : "No online daemon on a primary (non-remote) machine");
    }
    if (target.is_remote) {
      throw new Error("Remote devices run a pushed copy of the primary's credential — mint on the primary machine");
    }
    return await enqueueMintFlow(ctx, userId, target, { force: args.force === true, now });
  },
});

// The daemon's status report for a mint (pending for its own auto-mints,
// then confirmed/rejected). The token itself never leaves the machine; its
// metadata arrives on the next heartbeat's cc_accounts.
export const reportMintFlow = mutation({
  args: {
    api_token: v.optional(v.string()),
    device_id: v.string(),
    status: v.union(v.literal("pending"), v.literal("confirmed"), v.literal("rejected")),
    profile: v.string(),
    email: v.optional(v.string()),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) throw new Error("Authentication failed: invalid token or session");
    const device = await ctx.db
      .query("devices")
      .withIndex("by_user_device", (q) => q.eq("user_id", userId).eq("device_id", args.device_id))
      .first();
    if (!device) return;
    const now = Date.now();
    const prior = device.cc_mint_flow;
    await ctx.db.patch(device._id, {
      cc_mint_flow: {
        status: args.status,
        profile: args.profile,
        email: args.email ?? prior?.email,
        ...(args.reason ? { reason: args.reason } : {}),
        started_at: args.status === "pending" ? now : (prior?.started_at ?? now),
        ...(args.status !== "pending" ? { finished_at: now } : {}),
      },
    });
  },
});

// The web toggle for same-account resume at window reset (default on — see
// isAutoContinueEnabled). Shares the auto-switch bookkeeping and check.
export const setAutoContinueAccounts = mutation({
  args: {
    api_token: v.optional(v.string()),
    device_id: v.string(),
    enabled: v.boolean(),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) throw new Error("Authentication failed: invalid token or session");
    const device = await loadPrimaryForToggle(ctx, userId, args.device_id);
    await ctx.db.patch(device._id, {
      cc_auto_continue: args.enabled,
      cc_auto_switch_state: undefined,
    });
    if (args.enabled) {
      await scheduleAutoSwitchCheck(ctx, userId);
    }
    return { enabled: args.enabled };
  },
});

/**
 * The auto-switch decision. Runs debounced after a limit banner lands (and
 * self-schedules a re-check at the earliest known limit reset when every
 * account is spent). Preference order:
 *   1. no switch — the active account's 5h window rolled since the newest
 *      park, so a plain "continue" un-parks for free;
 *   2. switch — the saved profile with the most usage headroom that hasn't
 *      already parked sessions this window;
 *   3. exhausted — record it for the UI and re-check at the earliest reset.
 * Every action reuses the manual flow's machinery (the same daemon
 * switch_account command / continue enqueue), so auto and manual behave
 * identically at the execution layer.
 */
export const autoSwitchCheck = internalMutation({
  args: { user_id: v.id("users") },
  handler: async (ctx, args) => {
    const now = Date.now();
    const { online, primary } = await listOnlineDevices(ctx, args.user_id, now);
    if (!primary) return { acted: "off" };
    const allowSwitch = primary.cc_auto_switch === true;
    if (!allowSwitch && !isAutoContinueEnabled(primary)) return { acted: "off" };

    const state = primary.cc_auto_switch_state ?? {};
    const { blocked } = await listBlockedConversations(ctx, args.user_id, false);
    // Continue-only mode acts on the current incident alone: a park older than
    // a full session window has already sat through a reset the user could
    // have used — resuming it now spends the fresh window on abandoned work.
    // (With auto-switch on the user opted into the wider 48h revive.)
    const limitBlocked = blocked.filter(
      (c) =>
        c.pending_api_error_kind === "limit" &&
        (allowSwitch || (c.updated_at ?? 0) >= now - AUTO_CONTINUE_WINDOW_MS),
    );
    // Auth parks ("Login expired") mean the active login is dead — waiting
    // can't heal them, so they ride ONLY the opt-in switch path: rotating the
    // machine's login is exactly what the cc_auto_switch flag consents to.
    // Without the flag they keep the manual path (incident notification).
    const authBlocked = allowSwitch
      ? blocked.filter((c) => c.pending_api_error_kind === "auth")
      : [];
    const targets = [...limitBlocked, ...authBlocked];
    if (targets.length === 0) {
      if (state.exhausted_at) {
        await ctx.db.patch(primary._id, {
          cc_auto_switch_state: { ...state, exhausted_at: undefined },
        });
      }
      return { acted: "nothing_blocked" };
    }
    if (state.last_action_at && now - state.last_action_at < AUTO_SWITCH_COOLDOWN_MS) {
      // A recent action is still settling — but don't just drop this check: a
      // session that re-parks DURING the cooldown stamps its banner now and
      // never again, so book a follow-up right after the cooldown expires
      // (deduped via next_check_at, cleared whenever an action is taken).
      const retryAt = state.last_action_at + AUTO_SWITCH_COOLDOWN_MS + 5_000;
      if (!state.next_check_at || state.next_check_at <= now || retryAt < state.next_check_at) {
        await ctx.scheduler.runAt(retryAt, internal.accountSwitch.autoSwitchCheck, {
          user_id: args.user_id,
        });
        await ctx.db.patch(primary._id, {
          cc_auto_switch_state: { ...state, next_check_at: retryAt },
        });
      }
      return { acted: "cooldown" };
    }

    const attempts = state.attempts ?? [];
    const recordAction = async (action: string, profileKey: string) => {
      await ctx.db.patch(primary._id, {
        cc_auto_switch_state: {
          ...state,
          last_action_at: now,
          last_action: action,
          attempts: [...attempts, { profile: profileKey, at: now }].slice(-MAX_ATTEMPT_HISTORY),
          exhausted_at: undefined,
          next_check_at: undefined,
        },
      });
    };

    const decision = decideAutoSwitch({
      now,
      parkedAt: Math.max(...targets.map((c) => c.updated_at ?? 0)),
      activeEmail: primary.cc_accounts?.active_email,
      activeSince: primary.cc_accounts?.active_since,
      profiles: primary.cc_accounts?.profiles ?? [],
      attempts,
      allowSwitch,
      // An auth park is proof the active login is dead — "continue" can't help
      // even the limit-parked sessions until the machine has a live account.
      activeDead: authBlocked.length > 0,
    });

    if (decision.action === "wait") {
      // The active account just changed and its meter hasn't been read since.
      // The daemon probes right after a switch; look again once that lands.
      // Not an action: no cooldown, no attempt, exhausted_at untouched.
      if (!state.next_check_at || state.next_check_at <= now || decision.retry_at < state.next_check_at) {
        await ctx.scheduler.runAt(decision.retry_at, internal.accountSwitch.autoSwitchCheck, {
          user_id: args.user_id,
        });
        await ctx.db.patch(primary._id, {
          cc_auto_switch_state: { ...state, next_check_at: decision.retry_at },
        });
      }
      return { acted: "wait", next_check_at: decision.retry_at };
    }

    if (decision.action === "continue") {
      // Same no-switch revive the banner uses: a message where one can
      // reach the session, a restart (pin corrected) where it cannot.
      const bucket = Math.floor(now / 60_000);
      const res = await insertSwitchCommands(ctx, args.user_id, {
        profile: undefined,
        blocked: limitBlocked,
        online,
        primary,
        continueBlocked: true,
        now,
        continueClientIds: Object.fromEntries(
          limitBlocked.map((conv) => [conv._id, `auto-switch-continue-${conv._id}-${bucket}`]),
        ),
      });
      await recordAction("continue", AUTO_SWITCH_CONTINUE_KEY);
      return { acted: "continue", conversations: limitBlocked.length, restarted: res.restarted };
    }

    if (decision.action === "switch") {
      await insertSwitchCommands(ctx, args.user_id, {
        profile: decision.profile,
        blocked: targets,
        online,
        primary,
        continueBlocked: true,
        now,
      });
      await recordAction(`switch:${decision.profile}`, decision.profile);
      console.log(
        `autoSwitchCheck: switching to "${decision.profile}" for ${limitBlocked.length} limit-parked + ${authBlocked.length} auth-parked conversation(s)`,
      );
      return { acted: "switch", profile: decision.profile, conversations: targets.length };
    }

    // Every account is spent. Mark it for the UI and wake up at the earliest
    // limit reset the decision found. Dedupe self-scheduling: only book a
    // wake-up if none is pending or ours lands earlier (a window reset we just
    // learned about). Continue-only mode never looked at the other accounts,
    // so it must not stamp "every account is spent" — it is merely waiting
    // for the active window to reset.
    const nextState = {
      ...state,
      exhausted_at: allowSwitch ? state.exhausted_at ?? now : state.exhausted_at,
      next_check_at: state.next_check_at,
    };
    if (
      !state.next_check_at ||
      state.next_check_at <= now ||
      decision.retry_at < state.next_check_at
    ) {
      await ctx.scheduler.runAt(decision.retry_at, internal.accountSwitch.autoSwitchCheck, {
        user_id: args.user_id,
      });
      nextState.next_check_at = decision.retry_at;
    }
    await ctx.db.patch(primary._id, { cc_auto_switch_state: nextState });
    return { acted: "exhausted", next_check_at: nextState.next_check_at };
  },
});

// Hourly hygiene: clear pending_api_error once it's past the revive window —
// the banner/badge then always means "current incident", and abandoned
// workers stop accumulating as phantom blocked sessions. The conversation's
// message history still holds the banner turn for rendering; only the
// denormalized flag is reset. Bounded batch per run; the hourly cadence
// drains any realistic backlog within a day.
export const sweepStaleApiErrorFlags = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - STALE_FLAG_AFTER_MS;
    const stale = await ctx.db
      .query("conversations")
      .withIndex("by_pending_api_error", (q) =>
        q.eq("pending_api_error", true).lt("updated_at", cutoff),
      )
      .take(500);
    let swept = 0;
    for (const conv of stale) {
      // Re-verify with the shared predicate (guards against future index drift).
      if (!shouldSweepStaleFlag(conv, Date.now())) continue;
      await ctx.db.patch(conv._id, {
        pending_api_error: false,
        pending_api_error_kind: undefined,
        pending_api_error_at: undefined,
      });
      swept++;
    }
    if (swept > 0) console.log(`sweepStaleApiErrorFlags: cleared ${swept} stale flag(s)`);
    return { swept };
  },
});

// Backfill for classifier upgrades: when a new banner form is added to
// apiErrorBanner.ts (e.g. "Login expired · Please run /login"), sessions
// already parked on that banner were never stamped — the flag is written at
// message-insert time. Re-classify the newest message of each recent
// conversation and stamp the ones the upgraded classifier now recognizes, so
// they join the blocked set (badge + banner + revive) without waiting for a
// fresh banner. Run via:
//   npx convex run accountSwitch:restampApiErrorFlags '{"user_id":"..."}'
export const restampApiErrorFlags = internalMutation({
  args: { user_id: v.id("users") },
  handler: async (ctx, args) => {
    const since = Date.now() - BLOCKED_WINDOW_MS;
    const recent = await ctx.db
      .query("conversations")
      .withIndex("by_user_updated", (q) => q.eq("user_id", args.user_id).gt("updated_at", since))
      .order("desc")
      .take(1000);
    let stamped = 0;
    for (const conv of recent) {
      // Already-flagged rows are re-checked too: a kind split (e.g. statusless
      // connection drops moving out of "error") leaves them stamped with the
      // old kind, outside the blocked set, until re-classified here.
      // Newest banner-or-turn, not newest row: a trailing system notice
      // ("Remote Control disconnected") must not hide the banner behind it.
      const tail = await ctx.db
        .query("messages")
        .withIndex("by_conversation_timestamp", (q) => q.eq("conversation_id", conv._id))
        .order("desc")
        .take(8);
      const newest = newestSignificantMessage(tail);
      if (!newest || !isBannerTurn(newest)) continue;
      const kind = classifyApiErrorBanner(newest.content);
      if (!kind) continue;
      if (conv.pending_api_error === true && conv.pending_api_error_kind === kind && conv.pending_api_error_at != null) continue;
      await ctx.db.patch(conv._id, { pending_api_error: true, pending_api_error_kind: kind, pending_api_error_at: newest.timestamp });
      stamped++;
    }
    if (stamped > 0) console.log(`restampApiErrorFlags: stamped ${stamped} conversation(s)`);
    return { scanned: recent.length, stamped };
  },
});

// Operator escape hatch: void every still-pending switch_account command. A
// daemon that dies mid-execution leaves its command unacked, and a restarted
// daemon re-polls pending commands — for a mass revive that replay is exactly
// the stampede the dry-run guard exists to prevent. Run via:
//   npx convex run accountSwitch:clearPendingSwitchCommands
export const clearPendingSwitchCommands = internalMutation({
  args: { user_id: v.id("users") },
  handler: async (ctx, args) => {
    // by_user_pending bounds the read to this user's unexecuted commands — a
    // bare .filter() over daemon_commands scans the full history and times out.
    const pending = await ctx.db
      .query("daemon_commands")
      .withIndex("by_user_pending", (q) =>
        q.eq("user_id", args.user_id).eq("executed_at", undefined),
      )
      .collect();
    let cleared = 0;
    for (const cmd of pending) {
      if (cmd.command !== "switch_account") continue;
      await ctx.db.patch(cmd._id, { executed_at: Date.now(), result: "cancelled_by_operator" });
      cleared++;
    }
    return { cleared };
  },
});

// The web switcher's data: per device, the active account and saved profile
// names the daemon reported on its heartbeat. Online devices are the live set;
// a recently-seen offline PRIMARY is included too (marked `online: false`) so
// the auto-switch flag — a server-side setting the daemon never executes the
// toggling of — stays reachable while the daemon restarts or is down.
const OFFLINE_PRIMARY_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

export const listAccountProfiles = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    const now = Date.now();
    const devices = await ctx.db
      .query("devices")
      .withIndex("by_user_id", (q) => q.eq("user_id", userId))
      .collect();
    // Old daemons report only the machine-wide codex_usage snapshot; shape it
    // as a single-profile inventory so the web renders one code path. The
    // legacy field names match the new usage shape except plan_type, which
    // lives at the profile level (subscription) in the inventory.
    const legacyCodexAccounts = (
      cu: any,
    ):
      | { active_email?: string; profiles: Array<{ name: string; email?: string; subscription?: string; usage?: any }> }
      | undefined => {
      if (!cu || typeof cu !== "object") return undefined;
      const { plan_type, ...usage } = cu;
      return {
        profiles: [
          {
            name: "codex",
            ...(typeof plan_type === "string" ? { subscription: plan_type } : {}),
            usage,
          },
        ],
      };
    };
    return {
      devices: devices
        .filter(
          (d) =>
            (isDeviceOnline(d, now) && (d.cc_accounts || d.codex_accounts || d.codex_usage)) ||
            (!d.is_remote && !!d.cc_accounts && now - d.last_seen < OFFLINE_PRIMARY_GRACE_MS),
        )
        .map((d) => ({
          device_id: d.device_id,
          label: d.label,
          is_remote: d.is_remote === true,
          online: isDeviceOnline(d, now),
          active_email: d.cc_accounts?.active_email,
          login_flow: d.cc_login_flow,
          session_tokens: d.cc_session_tokens === true,
          mint_flow: d.cc_mint_flow,
          profiles: d.cc_accounts?.profiles ?? [],
          codex_accounts: d.codex_accounts ?? legacyCodexAccounts(d.codex_usage),
          auto_switch: d.cc_auto_switch === true,
          auto_continue: isAutoContinueEnabled(d),
          auto_switch_state: d.cc_auto_switch_state
            ? {
                last_action_at: d.cc_auto_switch_state.last_action_at,
                last_action: d.cc_auto_switch_state.last_action,
                exhausted_at: d.cc_auto_switch_state.exhausted_at,
              }
            : undefined,
        })),
    };
  },
});
