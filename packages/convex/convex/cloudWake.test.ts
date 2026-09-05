import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getFunctionName } from "convex/server";
import { makeFakeDb } from "./testDb";
import { requestRemoteWake, wakeDevicesFor } from "./cloud";
import { DEVICE_ONLINE_MS } from "./deviceRouting";
import { CloudWakeAwsError } from "./cloudWakeAws";
import { claimCloudWake, cloudWakeFailure, finishCloudWake, getCloudWakeHostForConversation, performCloudWake, reconcileCloudWakes, recoverPendingCloudWake, scheduleCloudWake } from "./cloudWake";

const host = { ownerUserId: "user1", deviceId: "box", instanceId: "i-084309c56a91e15ff", region: "us-west-2" };
const keys = ["CAST_CLOUD_WAKE_HOSTS", "CAST_CLOUD_WAKE_AWS_ACCESS_KEY_ID", "CAST_CLOUD_WAKE_AWS_SECRET_ACCESS_KEY", "CAST_CLOUD_WAKE_AWS_SESSION_TOKEN"];
let saved: Array<string | undefined>;
beforeEach(() => {
  saved = keys.map((key) => process.env[key]);
  keys.forEach((key) => delete process.env[key]);
  process.env.CAST_CLOUD_WAKE_HOSTS = JSON.stringify([host]);
});
afterEach(() => keys.forEach((key, i) => saved[i] === undefined ? delete process.env[key] : process.env[key] = saved[i]));

function fixture(overrides: Record<string, any> = {}) {
  const requestAt = Date.now() - 1000;
  const device = { _id: "dev1", user_id: host.ownerUserId, device_id: host.deviceId,
    is_remote: true, last_seen: requestAt - DEVICE_ONLINE_MS, wake_requested_at: requestAt, ...overrides };
  const db = makeFakeDb({ devices: [device] });
  const scheduled: Array<{ delay: number; fn: string; args: any }> = [];
  const ctx = { db, scheduler: { runAfter: async (delay: number, fn: any, args: any) => { scheduled.push({ delay, fn: getFunctionName(fn), args }); } } };
  const args = { ownerUserId: host.ownerUserId, deviceId: host.deviceId, requestAt };
  const row = () => db.get(device._id);
  const prepare = async () => { await scheduleCloudWake(ctx, await row(), requestAt); return claimCloudWake(ctx, args); };
  return { ctx, device, scheduled, args, row, prepare };
}

describe("cloud wake authorization", () => {
  test("exact owner/device and registered remote required", async () => {
    const f = fixture();
    expect(await getCloudWakeHostForConversation(f.ctx, { user_id: "user1", owner_device_id: "box" })).toEqual(host);
    for (const conv of [{ user_id: "other", owner_device_id: "box" }, { user_id: "user1", owner_device_id: "other" }, {}]) {
      expect(await getCloudWakeHostForConversation(f.ctx, conv)).toBeUndefined();
    }
    expect(await claimCloudWake(f.ctx, { ...f.args, ownerUserId: "other" })).toEqual({ claimed: false, reason: "NotAllowlisted" });
    expect(await claimCloudWake(f.ctx, { ...f.args, deviceId: "other" })).toEqual({ claimed: false, reason: "NotAllowlisted" });
    await f.ctx.db.patch("dev1", { is_remote: false });
    expect(await getCloudWakeHostForConversation(f.ctx, { user_id: "user1", owner_device_id: "box" })).toBeUndefined();
    expect(await claimCloudWake(f.ctx, f.args)).toEqual({ claimed: false, reason: "NotRemote" });
    expect(await scheduleCloudWake(f.ctx, await f.row(), f.args.requestAt)).toBe(false);
    expect(f.scheduled).toHaveLength(0);
  });

  test("configured hosts never ask a laptop; removing config restores legacy wake", async () => {
    const f = fixture();
    const local = { ...f.device, user_id: "other", device_id: "legacy-box" };
    expect(wakeDevicesFor([f.device, local], Date.now())).toEqual([{ device_id: "legacy-box", label: null }]);
    delete process.env.CAST_CLOUD_WAKE_HOSTS;
    expect(wakeDevicesFor([f.device], Date.now())).toEqual([{ device_id: "box", label: null }]);
    expect(await scheduleCloudWake(f.ctx, f.device, f.args.requestAt)).toBe(false);
    expect(await claimCloudWake(f.ctx, f.args)).toEqual({ claimed: false, reason: "NotAllowlisted" });
  });

  test("invalid config never permits AWS claim", async () => {
    const f = fixture();
    process.env.CAST_CLOUD_WAKE_HOSTS = "not-json";
    expect(await claimCloudWake(f.ctx, f.args)).toEqual({ claimed: false, reason: "NotAllowlisted" });
    expect(wakeDevicesFor([f.device], Date.now())).toEqual([{ device_id: "box", label: null }]);
    expect(f.ctx.db._patched).toHaveLength(0);
  });
});

describe("durable cloud wake queue", () => {
  test("pending-message wake intent schedules once, including just-stopped hosts", async () => {
    const f = fixture({ last_seen: Date.now(), wake_requested_at: undefined });
    const conv = { user_id: "user1", owner_device_id: "box" };
    await requestRemoteWake(f.ctx, conv);
    await requestRemoteWake(f.ctx, conv);
    const row = await f.row();
    expect(row.wake_requested_at).toBeGreaterThan(row.last_seen);
    expect(f.scheduled).toHaveLength(1);
    expect(f.scheduled[0].delay).toBeGreaterThan(DEVICE_ONLINE_MS - 1000);
    expect(f.scheduled[0].fn).toBe("cloudWake:wake");
    expect(f.scheduled[0].args.requestAt).toBe(row.cloud_wake.request_at);
  });

  test("one claim at a time; expired leases recover and old completions cannot overwrite", async () => {
    const f = fixture();
    const first = await f.prepare();
    expect(first.claimed).toBe(true);
    expect(await claimCloudWake(f.ctx, f.args)).toEqual({ claimed: false, reason: "NotDue" });
    await f.ctx.db.patch("dev1", { cloud_wake: { ...(await f.row()).cloud_wake, lease_until: Date.now() - 1 } });
    const next = await claimCloudWake(f.ctx, f.args);
    if (!first.claimed || !next.claimed) throw new Error("Expected two serialized claims");
    expect(next.token).not.toBe(first.token);
    expect(await finishCloudWake(f.ctx, { ...f.args, token: first.token, error: "UnauthorizedOperation" })).toBe(false);
    expect(await finishCloudWake(f.ctx, { ...f.args, token: next.token, requestId: "aws-request" })).toBe(true);
    expect((await f.row()).cloud_wake).toMatchObject({ attempt: 2, status: "starting", aws_request_id: "aws-request" });
    expect((await f.row()).cloud_wake.lease_token).toBeUndefined();
    expect(f.scheduled).toHaveLength(2);
  });

  test("heartbeat cancels queued AWS work and in-flight retries", async () => {
    const f = fixture();
    const first = await f.prepare();
    if (!first.claimed) throw new Error("Expected claim");
    await f.ctx.db.patch("dev1", { last_seen: Date.now(), wake_requested_at: undefined });
    await finishCloudWake(f.ctx, { ...f.args, token: first.token });
    expect((await f.row()).cloud_wake.status).toBe("awake");
    expect(f.scheduled).toHaveLength(1);
    expect(await claimCloudWake(f.ctx, f.args)).toEqual({ claimed: false, reason: "Answered" });
  });

  test("stale request cannot claim a newer wake", async () => {
    const f = fixture();
    await f.prepare();
    const requestAt = f.args.requestAt + 2;
    await f.ctx.db.patch("dev1", { wake_requested_at: requestAt });
    await scheduleCloudWake(f.ctx, await f.row(), requestAt);
    expect(await claimCloudWake(f.ctx, f.args)).toEqual({ claimed: false, reason: "StaleRequest" });
    expect((await f.row()).cloud_wake.request_at).toBe(requestAt);
  });

  test("transient errors retry, permanent errors stop, new work can retry a failed request", async () => {
    const f = fixture();
    const claim = await f.prepare();
    if (!claim.claimed) throw new Error("Expected claim");
    await finishCloudWake(f.ctx, { ...f.args, token: claim.token, ...cloudWakeFailure(new CloudWakeAwsError("RequestLimitExceeded", 503)) });
    expect((await f.row()).cloud_wake.status).toBe("pending");
    expect(f.scheduled.at(-1)!.delay).toBeGreaterThan(29_000);
    await f.ctx.db.patch("dev1", { cloud_wake: { ...(await f.row()).cloud_wake, next_attempt_at: Date.now() - 1 } });
    const second = await claimCloudWake(f.ctx, f.args);
    if (!second.claimed) throw new Error("Expected retry");
    await finishCloudWake(f.ctx, { ...f.args, token: second.token, ...cloudWakeFailure(new CloudWakeAwsError("UnauthorizedOperation", 403)) });
    expect((await f.row()).cloud_wake.status).toBe("failed");
    expect(f.scheduled).toHaveLength(2);
    await requestRemoteWake(f.ctx, { user_id: "user1", owner_device_id: "box" });
    expect((await f.row()).cloud_wake).toMatchObject({ attempt: 0, status: "pending" });
    expect((await f.row()).wake_requested_at).toBeGreaterThan(f.args.requestAt);
  });

  test("attempt ceiling also bounds crash loops and missing heartbeats", async () => {
    const f = fixture();
    await f.prepare();
    await f.ctx.db.patch("dev1", { cloud_wake: { ...(await f.row()).cloud_wake, attempt: 5, lease_until: 0 } });
    expect(await claimCloudWake(f.ctx, f.args)).toEqual({ claimed: false, reason: "Exhausted" });
    expect((await f.row()).cloud_wake).toMatchObject({ status: "failed", last_error: "NoHeartbeat" });
    expect(await claimCloudWake(f.ctx, f.args)).toEqual({ claimed: false, reason: "Terminal" });
  });

  test("backstop recreates lost schedules but not live leases or failed attempts", async () => {
    const f = fixture();
    await reconcileCloudWakes(f.ctx);
    expect(f.scheduled).toHaveLength(1);
    await reconcileCloudWakes(f.ctx);
    expect(f.scheduled).toHaveLength(2);
    await claimCloudWake(f.ctx, f.args);
    await reconcileCloudWakes(f.ctx);
    expect(f.scheduled).toHaveLength(2);
    await f.ctx.db.patch("dev1", { cloud_wake: { ...(await f.row()).cloud_wake, lease_until: Date.now() - 1 } });
    await reconcileCloudWakes(f.ctx);
    expect(f.scheduled).toHaveLength(3);
    await f.ctx.db.patch("dev1", { wake_requested_at: undefined, last_seen: Date.now() });
    await reconcileCloudWakes(f.ctx);
    expect((await f.row()).cloud_wake.status).toBe("awake");
  });

  test("recovers undelivered work after a final heartbeat clears its wake stamp", async () => {
    const f = fixture();
    const requestAt = Date.now() - 300_000;
    await f.ctx.db.patch("dev1", { last_seen: requestAt - 300_000, wake_requested_at: requestAt });
    await scheduleCloudWake(f.ctx, await f.row(), requestAt);
    await f.ctx.db.patch("dev1", { last_seen: requestAt + 60_000, wake_requested_at: undefined });
    expect(await claimCloudWake(f.ctx, { ...f.args, requestAt })).toEqual({ claimed: false, reason: "Answered" });
    f.ctx.db._tables.conversations = [{ _id: "conv", user_id: "user1", owner_device_id: "box", has_pending_messages: true }];
    f.ctx.db._tables.pending_messages = [{ _id: "pending", conversation_id: "conv", status: "pending" }];
    await reconcileCloudWakes(f.ctx);
    expect(f.scheduled.at(-1)!.fn).toBe("cloudWake:recoverPending");
    expect(await recoverPendingCloudWake(f.ctx, f.args)).toBe(true);
    const next = await f.row();
    expect(next.wake_requested_at).toBeGreaterThan(next.last_seen);
    expect(next.cloud_wake).toMatchObject({ attempt: 0, status: "pending" });
    expect((await claimCloudWake(f.ctx, { ...f.args, requestAt: next.wake_requested_at })).claimed).toBe(true);
    expect(await recoverPendingCloudWake(f.ctx, f.args)).toBe(false);
  });

  test.each(["delivered", "injected", "failed", "undeliverable", "cancelled"])("does not reconstruct wake intent from %s messages", async (status) => {
    const f = fixture({ wake_requested_at: undefined });
    f.ctx.db._tables.conversations = [{ _id: "conv", user_id: "user1", owner_device_id: "box", has_pending_messages: true }];
    f.ctx.db._tables.pending_messages = [{ _id: "pending", conversation_id: "conv", status }];
    expect(await recoverPendingCloudWake(f.ctx, f.args)).toBe(false);
    expect(f.scheduled).toHaveLength(0);
  });

  test("recovery rejects wrong owners, local or online devices, and killed conversations", async () => {
    const f = fixture({ wake_requested_at: undefined });
    f.ctx.db._tables.conversations = [{ _id: "conv", user_id: "user1", owner_device_id: "box", has_pending_messages: true, inbox_killed_at: 1 }];
    f.ctx.db._tables.pending_messages = [{ _id: "pending", conversation_id: "conv", status: "pending" }];
    expect(await recoverPendingCloudWake(f.ctx, f.args)).toBe(false);
    expect(await recoverPendingCloudWake(f.ctx, { ...f.args, ownerUserId: "other" })).toBe(false);
    f.ctx.db._tables.conversations[0].inbox_killed_at = undefined;
    await f.ctx.db.patch("dev1", { is_remote: false });
    expect(await recoverPendingCloudWake(f.ctx, f.args)).toBe(false);
    await f.ctx.db.patch("dev1", { is_remote: true, last_seen: Date.now() });
    expect(await recoverPendingCloudWake(f.ctx, f.args)).toBe(false);
    expect(f.scheduled).toHaveLength(0);
  });

  test("recovery scans bounded pages and never restarts a failed outstanding wake", async () => {
    const f = fixture({ wake_requested_at: undefined });
    f.ctx.db._tables.conversations = Array.from({ length: 51 }, (_, i) => ({ _id: `conv-${i}`, user_id: "user1", owner_device_id: "box", has_pending_messages: i === 50 }));
    f.ctx.db._tables.pending_messages = [{ _id: "pending", conversation_id: "conv-50", status: "pending" }];
    expect(await recoverPendingCloudWake(f.ctx, f.args)).toBe(false);
    expect(f.scheduled.at(-1)!.fn).toBe("cloudWake:recoverPending");
    expect(await recoverPendingCloudWake(f.ctx, f.scheduled.at(-1)!.args)).toBe(true);
    const row = await f.row();
    await f.ctx.db.patch("dev1", { cloud_wake: { ...row.cloud_wake, status: "failed" } });
    const count = f.scheduled.length;
    expect(await recoverPendingCloudWake(f.ctx, f.args)).toBe(false);
    await reconcileCloudWakes(f.ctx);
    expect(f.scheduled).toHaveLength(count);
  });
});

describe("AWS action integration", () => {
  test("authorized queue calls AWS and awaits remote heartbeat, not just EC2 success", async () => {
    const f = fixture();
    await scheduleCloudWake(f.ctx, f.device, f.args.requestAt);
    process.env.CAST_CLOUD_WAKE_AWS_ACCESS_KEY_ID = "dedicated-test-key";
    process.env.CAST_CLOUD_WAKE_AWS_SECRET_ACCESS_KEY = "dedicated-test-secret";
    const calls: any[] = [];
    const ctx = { runMutation: async (fn: any, args: any) => getFunctionName(fn) === "cloudWake:claim" ? claimCloudWake(f.ctx, args) : finishCloudWake(f.ctx, args) };
    const start = async (target: any, credentials: any) => { calls.push({ target, credentials }); return { status: "starting" as const, requestId: "request-123" }; };
    await performCloudWake(ctx, f.args, start);
    await performCloudWake(ctx, f.args, start);
    expect(calls).toHaveLength(1);
    expect(calls[0].target).toEqual(host);
    expect((await f.row()).cloud_wake.status).toBe("starting");
    expect(JSON.stringify((await f.row()).cloud_wake)).not.toContain("dedicated-test");
    await f.ctx.db.patch("dev1", { last_seen: Date.now(), wake_requested_at: undefined });
    await reconcileCloudWakes(f.ctx);
    expect((await f.row()).cloud_wake.status).toBe("awake");
  });

  test("missing credentials fails closed; unauthorized owner never calls AWS", async () => {
    const f = fixture();
    await scheduleCloudWake(f.ctx, f.device, f.args.requestAt);
    let calls = 0;
    const ctx = { runMutation: async (fn: any, args: any) => getFunctionName(fn) === "cloudWake:claim" ? claimCloudWake(f.ctx, args) : finishCloudWake(f.ctx, args) };
    const start = async () => { calls++; return { status: "starting" as const }; };
    expect(await performCloudWake(ctx, { ...f.args, ownerUserId: "unapproved" }, start)).toEqual({ claimed: false, reason: "NotAllowlisted" });
    await performCloudWake(ctx, f.args, start);
    expect(calls).toBe(0);
    expect((await f.row()).cloud_wake).toMatchObject({ status: "failed", last_error: "MissingCredentials" });
  });

  test("unknown failures never persist raw exception details", () => {
    expect(cloudWakeFailure(new Error("secret-text"))).toEqual({ error: "WakeFailed", retryable: false });
    expect(cloudWakeFailure(new CloudWakeAwsError("NetworkError"))).toEqual({ error: "NetworkError", retryable: true });
  });
});
