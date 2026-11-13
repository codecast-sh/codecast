import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getFunctionName } from "convex/server";
import { dispatch } from "./dispatch";
import { makeFakeDb } from "./testDb";
import { bindDevice, castMachineUserData, startHeld } from "./castMachines";
import { sha256Hex } from "./lib/awsSigV4";
import { claimCloudWake, performCloudWake, requestRemoteWake } from "./cloudWake";
import { DEVICE_ONLINE_MS } from "./deviceRouting";

const ME = "users_me";
const keys = ["CAST_MACHINES_USERS", "CAST_MACHINES_AWS_ACCESS_KEY_ID", "CAST_MACHINES_AWS_SECRET_ACCESS_KEY", "CAST_CLOUD_WAKE_HOSTS"];
let saved: Array<string | undefined>;
beforeEach(() => {
  saved = keys.map((k) => process.env[k]);
  keys.forEach((k) => delete process.env[k]);
  process.env.CAST_MACHINES_USERS = ME;
});
afterEach(() => keys.forEach((k, i) => saved[i] === undefined ? delete process.env[k] : process.env[k] = saved[i]));

function setup(extra: Record<string, any[]> = {}) {
  const db = makeFakeDb({
    rate_limits: [], directory_team_mappings: [], conversations: [], daemon_commands: [], change_log: [], local_view_heads: [],
    docs: [], plans: [], tasks: [], session_owners: [], pending_messages: [], cast_machines: [], devices: [],
    users: [{ _id: ME }], team_memberships: [], ...extra,
  });
  const scheduled: Array<{ fn: string; args: any }> = [];
  const scheduler = { runAfter: async (_d: number, fn: any, args: any) => { scheduled.push({ fn: getFunctionName(fn), args }); } };
  const ctx = { auth: { getUserIdentity: async () => ({ subject: `${ME}|session` }) }, db, scheduler };
  const create = (args: Record<string, unknown> = {}) => (dispatch as any)._handler(ctx, {
    action: "createSession", args: [{ session_id: "stub-1", agent_type: "codecast", first_message: "hello", first_message_client_id: "c1", ...args }],
  });
  return { db, ctx, scheduled, create };
}

describe("Cast on a cast machine", () => {
  test("a first start makes a pi session, launches the machine and holds the start until it signs in", async () => {
    const { db, scheduled, create } = setup();
    const id = await create();
    expect(await db.get(id)).toMatchObject({ agent_type: "pi", user_id: ME });
    const [machine] = db._tables.cast_machines;
    expect(machine).toMatchObject({ status: "launching", region: "us-west-2", held_conversation_ids: [id] });
    expect(scheduled.map((s) => s.fn)).toContain("castMachines:launch");
    expect(db._tables.daemon_commands).toEqual([]);
    expect(db._tables.pending_messages.map((m: any) => m.content)).toEqual(["hello"]);
  });

  test("sign-in binds the device and starts every held session on it", async () => {
    const { db, ctx, create } = setup();
    const id = await create();
    const voucher = "setup-token-abc";
    await db.patch(db._tables.cast_machines[0]._id, { voucher_hash: await sha256Hex(voucher), status: "booting", instance_id: "i-0123456789abcdef0" });
    await (bindDevice as any)._handler(ctx, { voucher_hash: await sha256Hex(voucher), device_id: "machine-1" });
    expect(db._tables.cast_machines[0]).toMatchObject({ status: "ready", device_id: "machine-1" });
    expect(db._tables.cast_machines[0].voucher_hash).toBeUndefined();
    const machineId = db._tables.cast_machines[0]._id;
    // No heartbeat yet: nothing starts, and it checks again.
    await (startHeld as any)._handler(ctx, { machine_id: machineId, tries: 0 });
    expect(db._tables.daemon_commands).toEqual([]);
    await db.insert("devices", { user_id: ME, device_id: "machine-1", platform: "linux", is_remote: true, last_seen: Date.now() });
    await (startHeld as any)._handler(ctx, { machine_id: machineId, tries: 1 });
    expect(db._tables.cast_machines[0].held_conversation_ids).toEqual([]);
    const [cmd] = db._tables.daemon_commands;
    expect(cmd).toMatchObject({ command: "start_session", target_device_id: "machine-1" });
    expect(JSON.parse(cmd.args)).toMatchObject({ conversation_id: id, agent_type: "pi", project_path: "/home/ubuntu" });
  });

  test("a ready machine gets the start at once", async () => {
    const { db, create } = setup({
      cast_machines: [{ _id: "cm1", user_id: ME, region: "us-west-2", status: "ready", device_id: "machine-1", instance_id: "i-0123456789abcdef0", held_conversation_ids: [], launch_attempts: 1, created_at: 0, updated_at: 0 }],
      devices: [{ _id: "d1", user_id: ME, device_id: "machine-1", platform: "linux", is_remote: true, last_seen: Date.now() }],
    });
    await create();
    expect(db._tables.daemon_commands.map((c: any) => [c.command, c.target_device_id])).toEqual([["start_session", "machine-1"]]);
  });

  test("a person not enabled keeps the hosted engine", async () => {
    process.env.CAST_MACHINES_USERS = "someone_else";
    const { db, create } = setup({ assistant_turns: [], wallets: [], wallet_ledger: [] });
    try { await create(); } catch {}
    expect(db._tables.cast_machines).toEqual([]);
    expect(db._tables.conversations.every((c: any) => c.agent_type !== "pi")).toBe(true);
  });
});

describe("waking a cast machine", () => {
  const machineRow = { _id: "cm1", user_id: ME, region: "us-west-2", status: "ready", device_id: "machine-1", instance_id: "i-0123456789abcdef0", held_conversation_ids: [], launch_attempts: 1, created_at: 0, updated_at: 0 };
  const asleep = () => ({ _id: "d1", user_id: ME, device_id: "machine-1", platform: "linux", is_remote: true, last_seen: Date.now() - DEVICE_ONLINE_MS * 3 });

  test("queued work on an asleep machine schedules a server wake", async () => {
    const { ctx, scheduled } = setup({ cast_machines: [machineRow], devices: [asleep()] });
    expect(await requestRemoteWake(ctx, { user_id: ME, owner_device_id: "machine-1" })).toBe(true);
    expect(scheduled.map((s) => s.fn)).toContain("cloudWake:wake");
  });

  test("the wake uses the cast keys and refuses when the running cap is full", async () => {
    process.env.CAST_MACHINES_AWS_ACCESS_KEY_ID = "AKIATEST";
    process.env.CAST_MACHINES_AWS_SECRET_ACCESS_KEY = "secret";
    const { ctx } = setup({ cast_machines: [machineRow], devices: [asleep()] });
    await requestRemoteWake(ctx, { user_id: ME, owner_device_id: "machine-1" });
    const device = ctx.db._tables.devices[0];
    await ctx.db.patch(device._id, { cloud_wake: { ...device.cloud_wake, next_attempt_at: 0 } });
    const args = { ownerUserId: ME, deviceId: "machine-1", requestAt: device.wake_requested_at };
    const runCtx = { runMutation: async (ref: any, a: any) => getFunctionName(ref).endsWith(":claim") ? claimCloudWake(ctx, a) : null };
    let started: any = null;
    const full = await performCloudWake(runCtx, args, (async (host: any, creds: any) => { started = { host, creds }; return { status: "starting" }; }) as any, async () => false);
    expect(full).toMatchObject({ claimed: true, error: "InsufficientInstanceCapacity", retryable: true });
    expect(started).toBeNull();
  });
});

test("first-boot script refuses values that could break out of it", () => {
  expect(() => castMachineUserData({ site: "https://x.example", proxyKey: "castm_ab'; rm -rf /", setupToken: "t" })).toThrow();
  const script = castMachineUserData({ site: "https://convex.codecast.sh", proxyKey: "castm_abc", setupToken: "tok_123" });
  expect(script).toContain("https://convex.codecast.sh/cli/cast/anthropic");
  expect(script).toContain("cast login tok_123");
});
