import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "./functions";
import { internal } from "./_generated/api";
import { DEVICE_ONLINE_MS } from "./deviceRouting";
import { CloudWakeAwsError, findCloudWakeHost, parseCloudWakeAllowlist, startCloudInstance } from "./cloudWakeAws";

type WakeCtx = { db: any; scheduler?: { runAfter(delay: number, fn: any, args: any): Promise<unknown> } };
type WakeRequest = { ownerUserId: string; deviceId: string; requestAt: number };
const MAX_ATTEMPTS = 5;
const LEASE_MS = 45_000;
const CHECK_MS = 60_000;
const refs = () => (internal as any).cloudWake;

export function configuredCloudWakeHosts() {
  try {
    return parseCloudWakeAllowlist(process.env.CAST_CLOUD_WAKE_HOSTS);
  } catch {
    console.warn("cloud_wake_invalid_allowlist");
    return [];
  }
}

export function serverOwnsCloudWake(ownerUserId: string, deviceId: string): boolean {
  return !!findCloudWakeHost(configuredCloudWakeHosts(), ownerUserId, deviceId);
}

async function getDevice(ctx: WakeCtx, ownerUserId: string, deviceId: string) {
  return await ctx.db.query("devices").withIndex("by_user_device", (q: any) =>
    q.eq("user_id", ownerUserId).eq("device_id", deviceId)).first();
}

export async function getCloudWakeHostForConversation(ctx: WakeCtx, conversation: any) {
  if (!conversation?.user_id || !conversation?.owner_device_id) return undefined;
  const host = findCloudWakeHost(configuredCloudWakeHosts(), conversation.user_id, conversation.owner_device_id);
  if (!host) return undefined;
  const device = await getDevice(ctx, host.ownerUserId, host.deviceId);
  return device?.is_remote === true ? host : undefined;
}

const requestArgs = { ownerUserId: v.string(), deviceId: v.string(), requestAt: v.number() };
const requestFor = (device: any, requestAt: number): WakeRequest => ({
  ownerUserId: device.user_id, deviceId: device.device_id, requestAt,
});
const answered = (device: any, requestAt: number) =>
  device.last_seen >= requestAt || device.wake_requested_at !== requestAt;

export async function scheduleCloudWake(ctx: WakeCtx, device: any, requestAt: number): Promise<boolean> {
  if (!device.is_remote || !serverOwnsCloudWake(device.user_id, device.device_id)) return false;
  if (device.cloud_wake?.request_at === requestAt) return true;
  if (!ctx.scheduler) throw new Error("Cloud wake requires a scheduler");
  const now = Date.now();
  const next = Math.max(now, device.last_seen + DEVICE_ONLINE_MS);
  await ctx.db.patch(device._id, { cloud_wake: {
    request_at: requestAt, attempt: 0, status: "pending", next_attempt_at: next,
  } });
  await ctx.scheduler.runAfter(next - now, refs().wake, requestFor(device, requestAt));
  return true;
}

export async function claimCloudWake(ctx: WakeCtx, args: WakeRequest) {
  const host = findCloudWakeHost(configuredCloudWakeHosts(), args.ownerUserId, args.deviceId);
  if (!host) return { claimed: false as const, reason: "NotAllowlisted" };
  const device = await getDevice(ctx, args.ownerUserId, args.deviceId);
  if (!device?.is_remote) return { claimed: false as const, reason: "NotRemote" };
  const state = device.cloud_wake;
  if (!state || state.request_at !== args.requestAt) return { claimed: false as const, reason: "StaleRequest" };
  if (answered(device, args.requestAt)) {
    await ctx.db.patch(device._id, { cloud_wake: { ...state, status: "awake", lease_token: undefined, lease_until: undefined } });
    return { claimed: false as const, reason: "Answered" };
  }
  const now = Date.now();
  if (state.status === "failed" || state.status === "awake") return { claimed: false as const, reason: "Terminal" };
  if (state.next_attempt_at > now || (state.lease_until ?? 0) > now) return { claimed: false as const, reason: "NotDue" };
  if (state.attempt >= MAX_ATTEMPTS) {
    await ctx.db.patch(device._id, { cloud_wake: { ...state, status: "failed", last_error: "NoHeartbeat", lease_token: undefined, lease_until: undefined } });
    return { claimed: false as const, reason: "Exhausted" };
  }
  const token = crypto.randomUUID();
  await ctx.db.patch(device._id, { cloud_wake: {
    ...state, status: "starting", attempt: state.attempt + 1, lease_token: token, lease_until: now + LEASE_MS,
  } });
  return { claimed: true as const, host, token };
}

export const claim = internalMutation({ args: requestArgs, handler: claimCloudWake });

type WakeOutcome = WakeRequest & { token: string; error?: string; retryable?: boolean; requestId?: string };
export async function finishCloudWake(ctx: WakeCtx, args: WakeOutcome) {
  const device = await getDevice(ctx, args.ownerUserId, args.deviceId);
  const state = device?.cloud_wake;
  if (!state || state.request_at !== args.requestAt || state.lease_token !== args.token) return false;
  const awake = answered(device, args.requestAt);
  const failed = !!args.error && (!args.retryable || state.attempt >= MAX_ATTEMPTS);
  const next = Date.now() + (args.error ? Math.min(120_000, 30_000 * 2 ** (state.attempt - 1)) : CHECK_MS);
  await ctx.db.patch(device._id, { cloud_wake: {
    ...state, status: awake ? "awake" : failed ? "failed" : args.error ? "pending" : "starting",
    next_attempt_at: next, lease_token: undefined, lease_until: undefined,
    last_error: args.error, aws_request_id: args.requestId ?? state.aws_request_id,
  } });
  if (!awake && !failed) {
    if (!ctx.scheduler) throw new Error("Cloud wake requires a scheduler");
    await ctx.scheduler.runAfter(Math.max(0, next - Date.now()), refs().wake, requestFor(device, args.requestAt));
  }
  return true;
}

export const finish = internalMutation({
  args: { ...requestArgs, token: v.string(), error: v.optional(v.string()), retryable: v.optional(v.boolean()), requestId: v.optional(v.string()) },
  handler: finishCloudWake,
});

export function cloudWakeFailure(error: unknown) {
  const code = error instanceof CloudWakeAwsError ? error.code : "WakeFailed";
  const status = error instanceof CloudWakeAwsError ? error.status : undefined;
  return { error: code, retryable: status === 429 || (status !== undefined && status >= 500) || [
    "NetworkError", "RequestTimeout", "RequestLimitExceeded", "Throttling", "ThrottlingException",
    "IncorrectInstanceState", "InsufficientInstanceCapacity", "InsufficientHostCapacity",
  ].includes(code) };
}

export async function performCloudWake(ctx: any, args: WakeRequest, start = startCloudInstance) {
  const claimed = await ctx.runMutation(refs().claim, args);
  if (!claimed.claimed) return claimed;
  let outcome: { error?: string; retryable?: boolean; requestId?: string };
  try {
    const accessKeyId = process.env.CAST_CLOUD_WAKE_AWS_ACCESS_KEY_ID;
    const secretAccessKey = process.env.CAST_CLOUD_WAKE_AWS_SECRET_ACCESS_KEY;
    if (!accessKeyId || !secretAccessKey) throw new CloudWakeAwsError("MissingCredentials");
    const result = await start(claimed.host, {
      accessKeyId, secretAccessKey, sessionToken: process.env.CAST_CLOUD_WAKE_AWS_SESSION_TOKEN,
    });
    outcome = { requestId: result.requestId };
  } catch (error) {
    outcome = cloudWakeFailure(error);
    console.warn("cloud_wake_failed", { deviceId: args.deviceId, requestAt: args.requestAt, code: outcome.error });
  }
  await ctx.runMutation(refs().finish, { ...args, token: claimed.token, ...outcome });
  return { claimed: true, ...outcome };
}

export const wake = internalAction({ args: requestArgs, handler: (ctx, args) => performCloudWake(ctx, args) });

export async function recoverPendingCloudWake(ctx: WakeCtx, args: { ownerUserId: string; deviceId: string; cursor?: string }) {
  if (!serverOwnsCloudWake(args.ownerUserId, args.deviceId)) return false;
  const device = await getDevice(ctx, args.ownerUserId, args.deviceId);
  const now = Date.now();
  if (!device?.is_remote || now - device.last_seen < DEVICE_ONLINE_MS) return false;
  if (typeof device.wake_requested_at === "number" && device.wake_requested_at > device.last_seen) return false;
  const page = await ctx.db.query("conversations").withIndex("by_owner_device", (q: any) =>
    q.eq("user_id", args.ownerUserId).eq("owner_device_id", args.deviceId))
    .paginate({ cursor: args.cursor ?? null, numItems: 50 });
  for (const conversation of page.page) {
    if (!conversation.has_pending_messages || conversation.inbox_killed_at) continue;
    const pending = await ctx.db.query("pending_messages").withIndex("by_conversation_status", (q: any) =>
      q.eq("conversation_id", conversation._id).eq("status", "pending")).first();
    if (!pending) continue;
    const requestAt = Math.max(now, device.last_seen + 1, (device.cloud_wake?.request_at ?? 0) + 1);
    await ctx.db.patch(device._id, { wake_requested_at: requestAt });
    await scheduleCloudWake(ctx, device, requestAt);
    return true;
  }
  if (!page.isDone) {
    if (!ctx.scheduler) throw new Error("Cloud wake requires a scheduler");
    await ctx.scheduler.runAfter(0, refs().recoverPending, { ...args, cursor: page.continueCursor });
  }
  return false;
}

export const recoverPending = internalMutation({
  args: { ownerUserId: v.string(), deviceId: v.string(), cursor: v.optional(v.string()) },
  handler: recoverPendingCloudWake,
});

export async function reconcileCloudWakes(ctx: WakeCtx) {
  const now = Date.now();
  for (const host of configuredCloudWakeHosts()) {
    const device = await getDevice(ctx, host.ownerUserId, host.deviceId);
    if (!device?.is_remote) continue;
    const state = device.cloud_wake;
    const requestAt = device.wake_requested_at;
    if (now - device.last_seen >= DEVICE_ONLINE_MS && !(typeof requestAt === "number" && requestAt > device.last_seen)) {
      if (!ctx.scheduler) throw new Error("Cloud wake requires a scheduler");
      await ctx.scheduler.runAfter(0, refs().recoverPending, { ownerUserId: host.ownerUserId, deviceId: host.deviceId });
    }
    if (typeof requestAt === "number" && requestAt > device.last_seen && state?.request_at !== requestAt) {
      await scheduleCloudWake(ctx, device, requestAt);
      continue;
    }
    if (state && answered(device, state.request_at)) {
      if (state.status !== "awake") await ctx.db.patch(device._id, { cloud_wake: { ...state, status: "awake", lease_token: undefined, lease_until: undefined } });
      continue;
    }
    if (typeof requestAt !== "number" || requestAt <= device.last_seen) continue;
    if (!state || state.request_at !== requestAt) {
      await scheduleCloudWake(ctx, device, requestAt);
    } else if (state.status !== "failed" && state.status !== "awake" && state.next_attempt_at <= now && (state.lease_until ?? 0) <= now) {
      if (!ctx.scheduler) throw new Error("Cloud wake requires a scheduler");
      await ctx.scheduler.runAfter(0, refs().wake, requestFor(device, requestAt));
    }
  }
}

export const reconcile = internalMutation({ args: {}, handler: reconcileCloudWakes });
export const status = internalQuery({ args: {}, handler: async (ctx) => {
  const rows = [];
  for (const host of configuredCloudWakeHosts()) {
    const device = await getDevice(ctx, host.ownerUserId, host.deviceId);
    rows.push({ ...host, registered: device?.is_remote === true, last_seen: device?.last_seen,
      wake_requested_at: device?.wake_requested_at, wake: device?.cloud_wake });
  }
  return rows;
} });
