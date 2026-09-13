// The Lock Screen Live Activity: one merged strip per phone showing every live
// session's work state, pushed from here through APNs.
//
// Why a server-side merge: each daemon reports only its own sessions, and the
// phone shows ONE activity (several would fight for Lock Screen space and hit
// iOS' concurrency limit exactly when four agents are running). So this module
// folds the user's live sessions into one content state — the same
// classifyWorkState verdict the inbox buckets by, through
// notifications.deriveConversationVerdict, so the phone can never file a
// session differently from the web — and pushes it whenever the picture
// changes. The wire shape and the merge itself are the shared contract
// (@codecast/shared/contracts/liveActivity).
//
// How a picture reaches the phone is one decision (resolveLiveActivityPush,
// pure and tested): START through the push-to-start token when nothing runs
// and something should; UPDATE through the activity's own token, coalesced to
// one per interval unless a status changed; END when the strip goes quiet,
// with a linger before the system removes it; WAIT out the start grace while
// the device has not yet reported the activity id. Every write site that can
// change the picture calls scheduleLiveActivityRefresh (lib/liveActivityRefresh),
// and a self-rescheduling sweep catches what no write announces: a linger
// running out, a heartbeat that stopped.
//
// The push-to-start token (iOS 17.2+) is what lets the strip appear with the
// app closed. Older phones get the strip only while the app is open: the app
// starts the activity itself from currentState and reports its token, after
// which pushes drive it like any other.

import { mutation, query, internalMutation, internalAction } from "./functions";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { getAuthUserId } from "@convex-dev/auth/server";
import { listLiveManagedSessions } from "./lib/liveSessions";
import { coalesceLiveActivityRefresh, scheduleLiveActivityRefresh } from "./lib/liveActivityRefresh";
import { deriveConversationVerdict, auqQuestionPreview, notifPreview } from "./notifications";
import { needsInputKind, HEARTBEAT_ALIVE_MS } from "./inboxFilters";
import { isAgentSpawnedConversation } from "./ccAccountsShared";
import { APNS_BUNDLE_ID, apnsTokenIsDead, sendApns, type ApnsEnvironment } from "./apns";
import {
  LIVE_ACTIVITY_ATTRIBUTES_TYPE,
  LIVE_ACTIVITY_DETAIL_LIMIT,
  LIVE_ACTIVITY_DISMISS_AFTER_MS,
  LIVE_ACTIVITY_FAILED_LINGER_MS,
  LIVE_ACTIVITY_PUSH_INTERVAL_MS,
  LIVE_ACTIVITY_STALE_MS,
  LIVE_ACTIVITY_START_GRACE_MS,
  LIVE_ACTIVITY_SWEEP_INTERVAL_MS,
  clipLiveActivityText,
  deriveLiveActivityState,
  isLiveActivityQuiet,
  liveActivityStateKey,
  liveActivityStatusKey,
  liveActivityStatusOf,
  nextLiveActivityExpiry,
  type LiveActivityContentState,
  type LiveActivitySessionInput,
} from "@codecast/shared/contracts";

export { scheduleLiveActivityRefresh } from "./lib/liveActivityRefresh";

const ENVIRONMENT = v.union(v.literal("production"), v.literal("sandbox"));

// ── The device's side ────────────────────────────────────────────────────────

async function rowFor(ctx: any, userId: Id<"users">): Promise<Doc<"live_activities"> | null> {
  return ctx.db
    .query("live_activities")
    .withIndex("by_user", (q: any) => q.eq("user_id", userId))
    .first();
}

async function upsertRow(
  ctx: any,
  userId: Id<"users">,
  patch: Partial<Doc<"live_activities">>,
): Promise<Doc<"live_activities">> {
  const now = Date.now();
  const row = await rowFor(ctx, userId);
  if (row) {
    await ctx.db.patch(row._id, { ...patch, updated_at: now });
    return (await ctx.db.get(row._id))!;
  }
  const id = await ctx.db.insert("live_activities", {
    user_id: userId,
    environment: patch.environment ?? "production",
    ...patch,
    updated_at: now,
  });
  return (await ctx.db.get(id))!;
}

// ActivityKit handed the app a push-to-start token. Registered on every launch
// (the token can rotate), and a fresh registration asks for the current
// picture at once so a phone that just installed the app sees what is running.
export const registerPushToStartToken = mutation({
  args: { token: v.string(), environment: ENVIRONMENT },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    const token = args.token.toLowerCase();
    const existing = await rowFor(ctx, userId);
    const changed = existing?.push_to_start_token !== token || existing?.environment !== args.environment;
    await upsertRow(ctx, userId, {
      push_to_start_token: token,
      push_to_start_token_at: Date.now(),
      environment: args.environment,
    });
    if (changed) await scheduleLiveActivityRefresh(ctx, userId, { urgent: true });
    return { ok: true };
  },
});

// An activity exists on the device (after our start push, or one the app began
// itself) and this is its id and update token. Binding it is what lets updates
// and the end address it; the immediate refresh brings the picture current.
export const reportActivity = mutation({
  args: { activity_id: v.string(), token: v.string(), environment: ENVIRONMENT },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    await upsertRow(ctx, userId, {
      activity_id: args.activity_id,
      activity_token: args.token.toLowerCase(),
      environment: args.environment,
      start_sent_at: undefined,
      dismissed_status_key: undefined,
    });
    await scheduleLiveActivityRefresh(ctx, userId, { urgent: true });
    return { ok: true };
  },
});

// The activity ended on the device: the system dismissed it after our end push,
// or the person swiped it away. Only the bound activity clears the binding,
// so a late report about an old activity never unbinds a newer one. A swipe
// (the strip was not quiet) remembers the picture it dismissed: no start goes
// out for that same picture.
export const reportActivityEnded = mutation({
  args: { activity_id: v.string() },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    const row = await rowFor(ctx, userId);
    if (!row || row.activity_id !== args.activity_id) return { ok: true, cleared: false };
    await ctx.db.patch(row._id, {
      activity_id: undefined,
      activity_token: undefined,
      start_sent_at: undefined,
      dismissed_status_key: row.last_status_key,
      last_state_key: undefined,
      updated_at: Date.now(),
    });
    return { ok: true, cleared: true };
  },
});

// The current picture, for the app: the pre-17.2 local start, the in-app
// mirror of the strip, and a debugging eye on what the server would push.
export const currentState = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    const user = await ctx.db.get(userId);
    const enabled = user?.notification_preferences?.live_activity !== false;
    const now = Date.now();
    const sessions = enabled ? await collectLiveActivitySessions(ctx, userId, now) : [];
    const state = deriveLiveActivityState(sessions, now);
    const row = await rowFor(ctx, userId);
    const quiet = isLiveActivityQuiet(state);
    const startPending = !!row?.start_sent_at && now - row.start_sent_at < LIVE_ACTIVITY_START_GRACE_MS;
    const dismissed = !!row?.dismissed_status_key && row.dismissed_status_key === liveActivityStatusKey(state);
    return {
      enabled,
      state,
      quiet,
      activity_id: row?.activity_id ?? null,
      has_push_to_start: !!row?.push_to_start_token,
      // The app may start the activity itself: something is live, nothing is
      // bound or in flight, and the person did not just swipe this picture away.
      may_start: enabled && !quiet && !row?.activity_id && !startPending && !dismissed,
    };
  },
});

// ── The sessions on the strip ────────────────────────────────────────────────

function basename(path: string | undefined | null): string | null {
  if (!path) return null;
  const parts = path.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || null;
}

function firstLine(text: string | undefined | null): string | null {
  const line = (text ?? "").split("\n").find((l) => l.trim().length > 0);
  return line ? line.trim() : null;
}

// Rows the strip never shows, mirroring the needs-input push's etiquette: the
// user's own live sessions, not the machinery under them. Workers of a fleet
// are represented by their lead; a schedule run parks idle after every turn by
// design; a hidden row was filed away by the person.
function isStripCandidate(conv: any): boolean {
  if (!conv || !conv.message_count) return false;
  if (conv.inbox_killed_at || conv.inbox_stashed_at || conv.inbox_dismissed_at) return false;
  if (conv.is_subagent || conv.is_workflow_sub || conv.parent_conversation_id || conv.worktree_name) return false;
  if (isAgentSpawnedConversation(conv) || conv.agent_task_id) return false;
  return true;
}

// What one session says about itself on the strip. The pinned state's first
// line (`cast state`) names the work in the agent's own words and is the best
// title when it exists; the generated title is the fallback. The detail is the
// ask when waiting, the error when failed, otherwise the row's subtitle.
export function liveActivitySessionOf(
  conv: any,
  verdict: {
    state: any;
    agentStatus: string | undefined;
    activity: { isUnresponsive: boolean };
    awaitingInput: boolean;
    lastMsg: any;
  },
  statusChangedAt: number,
): LiveActivitySessionInput | null {
  const kind =
    verdict.state === "needs_input"
      ? needsInputKind({
          awaitingInput: verdict.awaitingInput,
          agentStatus: verdict.agentStatus,
          isUnresponsive: verdict.activity.isUnresponsive,
        })
      : null;
  const dead = kind === "stopped" || kind === "unresponsive";
  const broken = conv.pending_api_error === true || !!conv.session_error;
  const status = broken ? "failed" : liveActivityStatusOf(verdict.state, { failed: dead });
  if (!status) return null;

  const title =
    firstLine(conv.thread_state) ??
    conv.title?.trim() ??
    basename(conv.project_path) ??
    "Session";
  let detail: string | null = null;
  if (status === "waiting") {
    detail =
      auqQuestionPreview(verdict.lastMsg) ??
      (verdict.lastMsg?.role === "assistant" ? notifPreview(verdict.lastMsg.content, LIVE_ACTIVITY_DETAIL_LIMIT) : null) ??
      conv.idle_summary ??
      "Waiting for your input";
  } else if (status === "failed") {
    detail = conv.session_error
      ? clipLiveActivityText(String(conv.session_error), LIVE_ACTIVITY_DETAIL_LIMIT)
      : conv.pending_api_error
        ? "Parked on an API error"
        : "The agent stopped";
  } else if (status === "done") {
    detail = conv.idle_summary ?? null;
  } else {
    detail = conv.subtitle ?? null;
  }
  return {
    id: conv._id.toString(),
    title,
    detail,
    agent: conv.agent_type ?? "claude",
    project: basename(conv.project_path),
    status,
    startedAt: conv._creationTime,
    updatedAt: statusChangedAt,
  };
}

// Every session that belongs on the user's strip right now. Managed rows are
// read back far enough to catch a failure still inside its linger; the
// derivation drops what has expired.
export async function collectLiveActivitySessions(
  ctx: any,
  userId: Id<"users">,
  now: number,
): Promise<LiveActivitySessionInput[]> {
  const managed = await listLiveManagedSessions(ctx, userId, {
    now,
    aliveMs: LIVE_ACTIVITY_FAILED_LINGER_MS + HEARTBEAT_ALIVE_MS,
  });
  const out: LiveActivitySessionInput[] = [];
  const seen = new Set<string>();
  for (const session of managed) {
    if (!session.conversation_id) continue;
    const key = session.conversation_id.toString();
    if (seen.has(key)) continue;
    seen.add(key);
    const conv = await ctx.db.get(session.conversation_id);
    if (!isStripCandidate(conv)) continue;
    const verdict = await deriveConversationVerdict(ctx, conv, session, now);
    const row = liveActivitySessionOf(conv, verdict, session.agent_status_updated_at ?? conv.updated_at);
    if (row) out.push(row);
  }
  return out;
}

// ── The push decision ────────────────────────────────────────────────────────

export type LiveActivityDecision =
  | { action: "none" }
  | { action: "start" }
  | { action: "update"; urgent: boolean }
  | { action: "end" }
  | { action: "wait"; at: number };

export interface LiveActivityConditions {
  now: number;
  quiet: boolean;
  stateKey: string;
  statusKey: string;
  hasStartToken: boolean;
  activityBound: boolean;
  startSentAt: number | null;
  lastPushAt: number | null;
  lastStateKey: string | null;
  lastStatusKey: string | null;
  dismissedStatusKey: string | null;
}

// Pure. Tested directly; performLiveActivityRefresh only executes it.
export function resolveLiveActivityPush(c: LiveActivityConditions): LiveActivityDecision {
  const startPending = c.startSentAt !== null && c.now - c.startSentAt < LIVE_ACTIVITY_START_GRACE_MS;
  if (c.quiet) {
    if (c.activityBound) return { action: "end" };
    // A start went out and the id has not landed yet: nothing to end until it
    // does (the device's report re-runs this), so wait out the grace.
    if (startPending) return { action: "wait", at: c.startSentAt! + LIVE_ACTIVITY_START_GRACE_MS };
    return { action: "none" };
  }
  if (c.activityBound) {
    if (c.lastStateKey === c.stateKey) return { action: "none" };
    const urgent = c.lastStatusKey !== null && c.lastStatusKey !== c.statusKey;
    const ready = (c.lastPushAt ?? 0) + LIVE_ACTIVITY_PUSH_INTERVAL_MS;
    if (!urgent && c.now < ready) return { action: "wait", at: ready };
    return { action: "update", urgent };
  }
  if (startPending) return { action: "wait", at: c.startSentAt! + LIVE_ACTIVITY_START_GRACE_MS };
  if (!c.hasStartToken) return { action: "none" };
  // The person swiped this exact picture away. A new event earns a new strip.
  if (c.dismissedStatusKey !== null && c.dismissedStatusKey === c.statusKey) return { action: "none" };
  return { action: "start" };
}

// ── The refresh ──────────────────────────────────────────────────────────────

export async function performLiveActivityRefresh(
  ctx: any,
  userId: Id<"users">,
  due?: number,
): Promise<{ action: string; reason?: string }> {
  const row = await rowFor(ctx, userId);
  if (!row) return { action: "none", reason: "no_row" };
  if (due !== undefined && row.refresh_due_at !== due) return { action: "none", reason: "superseded" };
  if (row.refresh_due_at !== undefined) await ctx.db.patch(row._id, { refresh_due_at: undefined });

  const now = Date.now();
  const user = await ctx.db.get(userId);
  const enabled = !!user && user.notification_preferences?.live_activity !== false;
  const sessions = enabled ? await collectLiveActivitySessions(ctx, userId, now) : [];
  const state = deriveLiveActivityState(sessions, now);
  const quiet = isLiveActivityQuiet(state);
  const stateKey = liveActivityStateKey(state);
  const statusKey = liveActivityStatusKey(state);
  const activityBound = !!row.activity_id && !!row.activity_token;

  const decision = resolveLiveActivityPush({
    now,
    quiet,
    stateKey,
    statusKey,
    hasStartToken: !!row.push_to_start_token,
    activityBound,
    startSentAt: row.start_sent_at ?? null,
    lastPushAt: row.last_push_at ?? null,
    lastStateKey: row.last_state_key ?? null,
    lastStatusKey: row.last_status_key ?? null,
    dismissedStatusKey: row.dismissed_status_key ?? null,
  });

  // Captured before the patches below: a row read is a snapshot in Convex,
  // but the tests' in-memory db mutates in place, and the send must name the
  // credential the decision was made with either way.
  const startToken = row.push_to_start_token;
  const activityToken = row.activity_token;
  const activityId = row.activity_id;

  switch (decision.action) {
    case "start": {
      await ctx.db.patch(row._id, {
        start_sent_at: now,
        last_push_at: now,
        last_state_key: stateKey,
        last_status_key: statusKey,
        dismissed_status_key: undefined,
        updated_at: now,
      });
      await ctx.scheduler.runAfter(0, internal.liveActivity.push, {
        user_id: userId,
        event: "start",
        token: startToken!,
        environment: row.environment,
        content_state: state,
        alert: { title: state.headline, body: state.detail ?? strapline(state) },
        urgent: true,
        now,
      });
      break;
    }
    case "update": {
      await ctx.db.patch(row._id, {
        last_push_at: now,
        last_state_key: stateKey,
        last_status_key: statusKey,
        updated_at: now,
      });
      await ctx.scheduler.runAfter(0, internal.liveActivity.push, {
        user_id: userId,
        event: "update",
        token: activityToken!,
        activity_id: activityId!,
        environment: row.environment,
        content_state: state,
        urgent: decision.urgent,
        now,
      });
      break;
    }
    case "end": {
      await ctx.db.patch(row._id, {
        activity_id: undefined,
        activity_token: undefined,
        start_sent_at: undefined,
        last_push_at: now,
        last_state_key: undefined,
        last_status_key: undefined,
        updated_at: now,
      });
      await ctx.scheduler.runAfter(0, internal.liveActivity.push, {
        user_id: userId,
        event: "end",
        token: activityToken!,
        activity_id: activityId!,
        environment: row.environment,
        content_state: state,
        urgent: true,
        now,
      });
      break;
    }
    case "wait": {
      await coalesceLiveActivityRefresh(ctx, userId, { delayMs: decision.at - now });
      return { action: "wait" };
    }
    case "none":
      break;
  }

  // While anything is on the strip (or a start is in flight), keep a sweep
  // coming: the next linger expiry if one is sooner, else the interval. The
  // scheduler yields to a pending fire that is already sooner.
  const running = !quiet || decision.action === "start" || (row.start_sent_at && !activityBound);
  if (running) {
    const expiry = nextLiveActivityExpiry(sessions, now);
    const at = Math.min(expiry ?? Infinity, now + LIVE_ACTIVITY_SWEEP_INTERVAL_MS);
    await coalesceLiveActivityRefresh(ctx, userId, { delayMs: at - now });
  }
  return { action: decision.action };
}

// The alert body when the strip has no detail: iOS requires an alert on a
// push-to-start, and a banner that just repeats the headline reads as a bug.
function strapline(state: LiveActivityContentState): string {
  if (state.waiting > 0) return "An agent needs you";
  if (state.live > 1) return `${state.live} sessions on your Lock Screen`;
  return "Now on your Lock Screen";
}

export const requestRefresh = internalMutation({
  args: { user_id: v.id("users"), urgent: v.optional(v.boolean()), delayMs: v.optional(v.number()) },
  handler: (ctx, args): Promise<boolean> => coalesceLiveActivityRefresh(ctx, args.user_id, args),
});

export const refresh = internalMutation({
  args: { user_id: v.id("users"), due: v.optional(v.number()) },
  handler: (ctx, args) => performLiveActivityRefresh(ctx, args.user_id, args.due),
});

// ── The APNs send ────────────────────────────────────────────────────────────

const LIVE_ACTIVITY_TOPIC = `${APNS_BUNDLE_ID}.push-type.liveactivity`;

export interface LiveActivityPushArgs {
  event: "start" | "update" | "end";
  content_state: LiveActivityContentState;
  alert?: { title: string; body: string };
  urgent: boolean;
  now: number;
}

// Apple's Live Activity payload. `attributes-type` names the Swift struct and
// `attributes` its non-state fields (none); both only on a start. `stale-date`
// always, so a dead server greys the strip out instead of lying. The end
// carries the final picture and a dismissal date so "All clear" lingers.
export function buildLiveActivityPayload(args: LiveActivityPushArgs): Record<string, unknown> {
  const seconds = Math.floor(args.now / 1000);
  const aps: Record<string, unknown> = {
    timestamp: seconds,
    event: args.event,
    "content-state": args.content_state,
    "stale-date": Math.floor((args.now + LIVE_ACTIVITY_STALE_MS) / 1000),
    "relevance-score": args.content_state.waiting > 0 ? 100 : args.content_state.live > 0 ? 50 : 10,
  };
  if (args.event === "start") {
    aps["attributes-type"] = LIVE_ACTIVITY_ATTRIBUTES_TYPE;
    aps.attributes = {};
    aps.alert = args.alert ?? { title: args.content_state.headline, body: strapline(args.content_state) };
  }
  if (args.event === "end") {
    aps["dismissal-date"] = Math.floor((args.now + LIVE_ACTIVITY_DISMISS_AFTER_MS) / 1000);
  }
  return { aps };
}

export const push = internalAction({
  args: {
    user_id: v.id("users"),
    event: v.union(v.literal("start"), v.literal("update"), v.literal("end")),
    token: v.string(),
    activity_id: v.optional(v.string()),
    environment: ENVIRONMENT,
    content_state: v.any(),
    alert: v.optional(v.object({ title: v.string(), body: v.string() })),
    urgent: v.boolean(),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    const res = await sendApns(ctx, {
      token: args.token,
      topic: LIVE_ACTIVITY_TOPIC,
      pushType: "liveactivity",
      // A start must go at 10 (Apple ignores power-considerate starts); a
      // routine update rides at 5 so a quiet phone is not woken for it.
      priority: args.urgent || args.event !== "update" ? 10 : 5,
      environment: args.environment as ApnsEnvironment,
      payload: buildLiveActivityPayload(args),
    });
    if (res.ok) return res;
    if (apnsTokenIsDead(res)) {
      await ctx.runMutation(internal.liveActivity.clearDeadToken, {
        user_id: args.user_id,
        event: args.event,
        token: args.token,
        activity_id: args.activity_id,
      });
    }
    console.error(`APNs live activity ${args.event} failed:`, res.status, res.reason);
    return res;
  },
});

// The token APNs declared dead — cleared only if the row still carries THAT
// token, so a re-registration that raced the failure is never wiped. A dead
// activity token also drops the binding, so the next change starts afresh.
export const clearDeadToken = internalMutation({
  args: {
    user_id: v.id("users"),
    event: v.union(v.literal("start"), v.literal("update"), v.literal("end")),
    token: v.string(),
    activity_id: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const row = await rowFor(ctx, args.user_id);
    if (!row) return;
    if (args.event === "start") {
      if (row.push_to_start_token === args.token) {
        await ctx.db.patch(row._id, {
          push_to_start_token: undefined,
          start_sent_at: undefined,
          last_state_key: undefined,
          last_status_key: undefined,
          updated_at: Date.now(),
        });
      }
      return;
    }
    if (row.activity_token === args.token) {
      await ctx.db.patch(row._id, {
        activity_id: undefined,
        activity_token: undefined,
        last_state_key: undefined,
        last_status_key: undefined,
        updated_at: Date.now(),
      });
    }
  },
});

// Config probe: a start push to a bogus token. APNs validates the provider JWT
// and the topic before the token, so `BadDeviceToken` proves the key and the
// liveactivity topic are accepted; `TopicDisallowed` means the app id has no
// Live Activity entitlement on this key. Never touches a real device.
export const probeLiveActivityConfig = internalAction({
  args: { environment: v.optional(ENVIRONMENT) },
  handler: async (ctx, args) => {
    const now = Date.now();
    const state = deriveLiveActivityState([], now);
    const res = await sendApns(ctx, {
      token: "00".repeat(32),
      topic: LIVE_ACTIVITY_TOPIC,
      pushType: "liveactivity",
      priority: 10,
      environment: args.environment,
      payload: buildLiveActivityPayload({ event: "start", content_state: state, urgent: true, now }),
    });
    return {
      ...res,
      verdict:
        res.reason === "BadDeviceToken"
          ? "KEY + TOPIC OK (auth accepted, token rejected as expected)"
          : res.reason,
    };
  },
});
