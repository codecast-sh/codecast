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
import { getAuthenticatedUserId, enqueuePendingMessage } from "./pendingMessages";
import {
  ccAccountsValidator,
  isBlockedConversation,
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

// Send "continue" to every session parked on a usage-limit (or transient
// provider-error) banner — the post-reset nudge, no account change. The
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

    // limit-only by default: auth-blocked sessions need a switch (plain
    // continue re-fails) and error-kind never enters the selection at all.
    const kinds = new Set(args.kinds ?? ["limit"]);
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

    // Route each blocked conversation to its owner device when that owner is
    // online; otherwise fall back to the primary (which can reclaim sessions
    // whose owner died — same rule the command executor applies).
    const groups = new Map<string, Doc<"conversations">[]>();
    for (const conv of blocked) {
      const owner =
        conv.owner_device_id && onlineById.has(conv.owner_device_id)
          ? conv.owner_device_id
          : primary?.device_id;
      if (!owner) continue;
      const list = groups.get(owner) ?? [];
      list.push(conv);
      groups.set(owner, list);
    }
    // The swap itself must run even when nothing is blocked.
    if (args.profile && primary && !groups.has(primary.device_id)) {
      groups.set(primary.device_id, []);
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
            profile: isRemote ? undefined : args.profile,
            conversation_ids: convs.map((c) => c._id),
            session_ids: Object.fromEntries(convs.map((c) => [c._id, c.session_id])),
            continue_blocked: args.continue_blocked !== false,
          }),
          created_at: now,
          target_device_id: deviceId,
        }),
      );
    }

    return {
      devices: groups.size,
      conversations: routed,
      subagents: subagentCount,
      total_blocked: totalBlocked,
      unreachable: blocked.length - routed,
      command_ids: commandIds,
    };
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
        })),
    };
  },
});
