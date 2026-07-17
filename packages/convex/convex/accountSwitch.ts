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
import { classifyApiErrorBanner } from "./inboxFilters";
import {
  ccAccountsValidator,
  decideAutoSwitch,
  AUTO_SWITCH_CONTINUE_KEY,
  isBlockedConversation,
  isRemoteAuthBlocked,
  isSubagentConversation,
  isDeviceOnline,
  isValidProfileName,
  shouldSweepStaleFlag,
  STALE_FLAG_AFTER_MS,
} from "./ccAccountsShared";

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
  const all = recent.filter(isBlockedConversation);
  const topLevel = all.filter((c: Doc<"conversations">) => !isSubagentConversation(c));
  const subagents = all.filter(isSubagentConversation);
  const acted = (includeSubagents ? [...topLevel, ...subagents] : topLevel).slice(0, MAX_REVIVE);
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

    // limit + connection by default: both un-park with a plain continue (the
    // limit window rolled / the dropped turn resumes). auth-blocked sessions
    // need a switch (plain continue re-fails) and error-kind (statusful
    // 529/500, self-retrying) never enters the selection at all.
    const kinds = new Set(args.kinds ?? ["limit", "connection"]);
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

    // client_id is minute-bucketed: a double-click can't double-queue, but a
    // deliberate retry a minute later still can.
    const bucket = Math.floor(Date.now() / 60_000);
    for (const conv of blocked) {
      await enqueuePendingMessage(ctx, conv, userId, {
        content: "continue",
        client_id: `continue-blocked-${conv._id}-${bucket}`,
      });
    }
    return { continued: blocked.length, subagents: subagentCount, total_blocked: totalBlocked };
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

    if (!primary && args.profile) {
      throw new Error(
        args.device_id
          ? "That device's daemon is offline"
          : "No online daemon on a primary (non-remote) device to execute the switch",
      );
    }

    const res = await insertSwitchCommands(ctx, userId, {
      profile: args.profile,
      blocked,
      online,
      primary,
      continueBlocked: args.continue_blocked !== false,
      now,
    });

    return {
      devices: res.devices,
      conversations: res.routed,
      subagents: subagentCount,
      total_blocked: totalBlocked,
      unreachable: blocked.length - res.routed,
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
    profile?: string;
    blocked: Doc<"conversations">[];
    online: Doc<"devices">[];
    primary: Doc<"devices"> | undefined;
    continueBlocked: boolean;
    now: number;
  },
): Promise<{ devices: number; routed: number; commandIds: Id<"daemon_commands">[] }> {
  const onlineById = new Map(opts.online.map((d) => [d.device_id, d]));
  const groups = new Map<string, Doc<"conversations">[]>();
  for (const conv of opts.blocked) {
    const owner =
      conv.owner_device_id && onlineById.has(conv.owner_device_id)
        ? conv.owner_device_id
        : opts.primary?.device_id;
    if (!owner) continue;
    const list = groups.get(owner) ?? [];
    list.push(conv);
    groups.set(owner, list);
  }
  // The swap itself must run even when nothing is blocked.
  if (opts.profile && opts.primary && !groups.has(opts.primary.device_id)) {
    groups.set(opts.primary.device_id, []);
  }

  const commandIds: Id<"daemon_commands">[] = [];
  let routed = 0;
  for (const [deviceId, convs] of groups) {
    const isRemote = onlineById.get(deviceId)?.is_remote === true;
    routed += convs.length;
    commandIds.push(
      await ctx.db.insert("daemon_commands", {
        user_id: userId,
        command: "switch_account" as const,
        args: JSON.stringify({
          // Remotes never swap locally — their credential arrives via the
          // primary's push. They only recycle their blocked sessions.
          profile: isRemote ? undefined : opts.profile,
          conversation_ids: convs.map((c) => c._id),
          session_ids: Object.fromEntries(convs.map((c) => [c._id, c.session_id])),
          continue_blocked: opts.continueBlocked,
        }),
        created_at: opts.now,
        target_device_id: deviceId,
      }),
    );
  }
  return { devices: groups.size, routed, commandIds };
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
      await ctx.db.patch(convId, { pending_api_error: false, pending_api_error_kind: undefined });
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

// The web toggle. Lives on the device row because the switch itself is
// machine-global — it's this machine's login that rotates through profiles.
export const setAutoSwitchAccounts = mutation({
  args: {
    api_token: v.optional(v.string()),
    device_id: v.string(),
    enabled: v.boolean(),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) throw new Error("Authentication failed: invalid token or session");
    const device = await ctx.db
      .query("devices")
      .withIndex("by_user_device", (q) => q.eq("user_id", userId).eq("device_id", args.device_id))
      .first();
    if (!device) throw new Error("Unknown device");
    if (device.is_remote) {
      throw new Error("Auto-switch runs on the primary machine — remotes mirror its account");
    }
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
    if (!primary || primary.cc_auto_switch !== true) return { acted: "off" };

    const state = primary.cc_auto_switch_state ?? {};
    const { blocked } = await listBlockedConversations(ctx, args.user_id, false);
    // Limit-kind only: an auth park means a login expired — switching accounts
    // behind the user's back is an identity change, not a recovery.
    const limitBlocked = blocked.filter((c) => c.pending_api_error_kind === "limit");
    if (limitBlocked.length === 0) {
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
      parkedAt: Math.max(...limitBlocked.map((c) => c.updated_at ?? 0)),
      activeEmail: primary.cc_accounts?.active_email,
      profiles: primary.cc_accounts?.profiles ?? [],
      attempts,
    });

    if (decision.action === "continue") {
      const bucket = Math.floor(now / 60_000);
      for (const conv of limitBlocked) {
        await enqueuePendingMessage(ctx, conv, args.user_id, {
          content: "continue",
          client_id: `auto-switch-continue-${conv._id}-${bucket}`,
        });
      }
      await recordAction("continue", AUTO_SWITCH_CONTINUE_KEY);
      return { acted: "continue", conversations: limitBlocked.length };
    }

    if (decision.action === "switch") {
      await insertSwitchCommands(ctx, args.user_id, {
        profile: decision.profile,
        blocked: limitBlocked,
        online,
        primary,
        continueBlocked: true,
        now,
      });
      await recordAction(`switch:${decision.profile}`, decision.profile);
      console.log(
        `autoSwitchCheck: switching to "${decision.profile}" for ${limitBlocked.length} limit-parked conversation(s)`,
      );
      return { acted: "switch", profile: decision.profile, conversations: limitBlocked.length };
    }

    // Every account is spent. Mark it for the UI and wake up at the earliest
    // limit reset the decision found. Dedupe self-scheduling: only book a
    // wake-up if none is pending or ours lands earlier (a window reset we just
    // learned about).
    const nextState = {
      ...state,
      exhausted_at: state.exhausted_at ?? now,
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
      if (conv.last_message_role !== "assistant") continue;
      const newest = await ctx.db
        .query("messages")
        .withIndex("by_conversation_timestamp", (q) => q.eq("conversation_id", conv._id))
        .order("desc")
        .first();
      if (!newest || newest.role !== "assistant") continue;
      const kind = classifyApiErrorBanner(newest.content);
      if (!kind) continue;
      if (conv.pending_api_error === true && conv.pending_api_error_kind === kind) continue;
      await ctx.db.patch(conv._id, { pending_api_error: true, pending_api_error_kind: kind });
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

// The web switcher's data: per online device, the active account and saved
// profile names the daemon reported on its heartbeat.
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
    return {
      devices: devices
        .filter((d) => isDeviceOnline(d, now) && d.cc_accounts)
        .map((d) => ({
          device_id: d.device_id,
          label: d.label,
          is_remote: d.is_remote === true,
          active_email: d.cc_accounts!.active_email,
          profiles: d.cc_accounts!.profiles,
          auto_switch: d.cc_auto_switch === true,
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
