import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { DEVICE_ONLINE_MS } from "./deviceRouting";
import {
  CLOUD_SPAWN_RUN_MS,
  COMMAND_TTL_MS,
  cloudPlacementNeeded,
  cloudSpawnLive,
  enqueueCloudSpawn,
  liveCloudSpawnFor,
  parkOnCloudHost,
  reissueStrandedCloudSpawns,
  resolveCloudDevice,
  supersedeCloudSpawns,
} from "./cloudPlacement";

const ME = "users_me" as any;
const BOT = "users_bot" as any;
const OTHER = "users_other" as any;
const now = () => Date.now();
const online = () => now() - 10_000;
const asleep = () => now() - DEVICE_ONLINE_MS - 60_000;

const host = () => ({ _id: "dev_host", user_id: ME, device_id: "host", label: "Linux - ip-172-31-40-243", platform: "linux", is_remote: true, last_seen: asleep(), local_project_roots: ["/home/ubuntu/work/app"] });
const laptop = (over: Record<string, any> = {}) => ({ _id: "dev_laptop", user_id: ME, device_id: "laptop", label: "macOS - MacBook", platform: "darwin", is_remote: false, last_seen: online(), local_project_roots: ["/Users/me/src/app"], ...over });
const oldLaptop = (over: Record<string, any> = {}) => ({ _id: "dev_old", user_id: ME, device_id: "old-laptop", label: "macOS - Old", platform: "darwin", is_remote: false, last_seen: online() - 5_000, local_project_roots: [], ...over });

function fixture(opts: { devices?: any[]; conversations?: any[]; commands?: any[]; users?: any[] } = {}) {
  return makeFakeDb({
    users: opts.users ?? [{ _id: ME }, { _id: BOT, is_bot: true }, { _id: OTHER }],
    devices: opts.devices ?? [host(), laptop()],
    conversations: opts.conversations ?? [],
    daemon_commands: opts.commands ?? [],
  });
}
const blankRow = (over: Record<string, any> = {}) => ({ _id: "conv_1", user_id: ME, session_id: "sess-1", project_path: "/Users/me/src/app", git_root: "/Users/me/src/app", message_count: 0, status: "active", ...over });
const spawnArgs = (c: any) => JSON.parse(c.args);
const spawns = (db: any) => db._tables.daemon_commands.filter((c: any) => c.command === "cloud_spawn");

describe("resolveCloudDevice — the caller's own wake-on-use host", () => {
  test("returns the host and rejects another user's device, a laptop, and a bot owner", async () => {
    const db = fixture({ devices: [host(), laptop(), { ...host(), _id: "dev_x", user_id: OTHER, device_id: "other-host" }, { ...host(), _id: "dev_b", user_id: BOT, device_id: "bot-host" }] });
    expect((await resolveCloudDevice({ db }, ME, "host")).device_id).toBe("host");
    await expect(resolveCloudDevice({ db }, ME, "other-host")).rejects.toThrow("Not a cloud host you own");
    await expect(resolveCloudDevice({ db }, ME, "laptop")).rejects.toThrow("Not a cloud host you own");
    await expect(resolveCloudDevice({ db }, BOT, "bot-host")).rejects.toThrow("Not a cloud host you own");
  });
});

describe("cloudPlacementNeeded — the chokepoint's upgrade rule", () => {
  const base = () => ({ callerUserId: ME, runnerUserId: ME, conv: blankRow(), targetDeviceId: "host", paths: ["/Users/me/src/app"] });

  test.each(["linux", "darwin"])("caller=runner + own %s remote + a laptop path → the host", async (platform) => {
    const db = fixture({ devices: [{ ...host(), platform, local_project_roots: [platform === "darwin" ? "/Users/codecast/work/app" : "/home/ubuntu/work/app"] }, laptop()] });
    expect((await cloudPlacementNeeded({ db }, base()))?.device_id).toBe("host");
  });

  test("caller ≠ runner (an agent box), a bot runner, or no caller → null", async () => {
    const db = fixture();
    expect(await cloudPlacementNeeded({ db }, { ...base(), callerUserId: OTHER })).toBeNull();
    expect(await cloudPlacementNeeded({ db }, { ...base(), callerUserId: undefined })).toBeNull();
    const botDb = fixture({ devices: [{ ...host(), user_id: BOT }, { ...laptop(), user_id: BOT }] });
    expect(await cloudPlacementNeeded({ db: botDb }, { ...base(), callerUserId: BOT, runnerUserId: BOT })).toBeNull();
  });

  test("a row already pending or already holding a worktree → null", async () => {
    const db = fixture();
    expect(await cloudPlacementNeeded({ db }, { ...base(), conv: blankRow({ cloud_placement: "pending" }) })).toBeNull();
    expect(await cloudPlacementNeeded({ db }, { ...base(), conv: blankRow({ worktree_path: "/home/ubuntu/work/app/.codecast/worktrees/x" }) })).toBeNull();
  });

  test("a host-native path, an ambiguous path, or a foreign id → null", async () => {
    const db = fixture();
    expect(await cloudPlacementNeeded({ db }, { ...base(), paths: ["/home/ubuntu/work/app/.codecast/worktrees/x"] })).toBeNull();
    expect(await cloudPlacementNeeded({ db }, { ...base(), paths: ["/opt/thing"] })).toBeNull();
    expect(await cloudPlacementNeeded({ db }, { ...base(), targetDeviceId: "nope" })).toBeNull();
    const macDb = fixture({ devices: [{ ...host(), platform: "darwin", local_project_roots: ["/Users/codecast/work/app"] }, laptop()] });
    expect(await cloudPlacementNeeded({ db: macDb }, { ...base(), paths: ["/Users/codecast/work/app/.codecast/worktrees/x"] })).toBeNull();
  });

  test("a runner with no local device → null (nothing could prepare)", async () => {
    const db = fixture({ devices: [host()] });
    expect(await cloudPlacementNeeded({ db }, base())).toBeNull();
  });
});

describe("enqueueCloudSpawn — which laptop prepares", () => {
  test("prefers the online local whose roots cover the path over a more recent one without", async () => {
    const db = fixture({ devices: [host(), laptop({ last_seen: online() - 20_000 }), oldLaptop({ last_seen: online() })] });
    const r = await enqueueCloudSpawn({ db }, ME, { conversationId: "conv_1" as any, cloudDeviceId: "host", projectPath: "/Users/me/src/app", token: "t1" });
    expect(r.preparerOnline).toBe(true);
    const cmd = await db.get(r.commandId);
    expect(cmd.target_device_id).toBe("laptop");
    expect(spawnArgs(cmd)).toEqual({ conversation_id: "conv_1", cloud_device_id: "host", placement_token: "t1" });
  });

  test("with no checkout holder the most recent online local wins; offline falls to the most recent local", async () => {
    const db = fixture({ devices: [host(), laptop({ last_seen: online() - 20_000, local_project_roots: [] }), oldLaptop({ last_seen: online() })] });
    const r = await enqueueCloudSpawn({ db }, ME, { conversationId: "conv_1" as any, cloudDeviceId: "host", projectPath: "/Users/me/src/other" });
    expect((await db.get(r.commandId)).target_device_id).toBe("old-laptop");
    const offline = fixture({ devices: [host(), laptop({ last_seen: asleep() - 1000 }), oldLaptop({ last_seen: asleep() })] });
    const r2 = await enqueueCloudSpawn({ db: offline }, ME, { conversationId: "conv_1" as any, cloudDeviceId: "host" });
    expect(r2.preparerOnline).toBe(false);
    expect((await offline.get(r2.commandId)).target_device_id).toBe("old-laptop");
  });

  test("the re-issue's nominated laptop ranks below an online checkout holder and above a more recent online local", async () => {
    // `laptop` holds the checkout and is online; `old-laptop` (no roots) just came back.
    const holder = fixture({ devices: [host(), laptop(), oldLaptop({ last_seen: online() + 1_000 })] });
    const r1 = await enqueueCloudSpawn({ db: holder }, ME, { conversationId: "conv_1" as any, cloudDeviceId: "host", projectPath: "/Users/me/src/app", preparerDeviceId: "old-laptop" });
    expect(r1.preparer.device_id).toBe("laptop");
    // Nobody holds the checkout: the nominated laptop beats the more recent one.
    const nobody = fixture({ devices: [host(), laptop({ local_project_roots: [], last_seen: online() + 1_000 }), oldLaptop()] });
    const r2 = await enqueueCloudSpawn({ db: nobody }, ME, { conversationId: "conv_1" as any, cloudDeviceId: "host", projectPath: "/Users/me/src/app", preparerDeviceId: "old-laptop" });
    expect(r2.preparer.device_id).toBe("old-laptop");
    // A nominated laptop that is not online is not preferred over one that is.
    const offlineNominee = fixture({ devices: [host(), laptop({ local_project_roots: [] }), oldLaptop({ last_seen: asleep() })] });
    const r3 = await enqueueCloudSpawn({ db: offlineNominee }, ME, { conversationId: "conv_1" as any, cloudDeviceId: "host", projectPath: "/Users/me/src/app", preparerDeviceId: "old-laptop" });
    expect(r3.preparer.device_id).toBe("laptop");
  });

  test("throws only when the user has no local device at all", async () => {
    const db = fixture({ devices: [host()] });
    await expect(enqueueCloudSpawn({ db }, ME, { conversationId: "conv_1" as any, cloudDeviceId: "host" })).rejects.toThrow("No laptop can prepare the cloud host");
  });
});

describe("parkOnCloudHost — park, idempotency, retry", () => {
  test("patches owner/pending/token, releases the prior owner, inserts one cloud_spawn carrying the token", async () => {
    const db = fixture({ conversations: [blankRow({ owner_device_id: "laptop" })] });
    const conv = await db.get("conv_1");
    const id = await parkOnCloudHost({ db }, ME, conv, "host", { projectPath: "/Users/me/src/app" });
    expect(id).not.toBeNull();
    const row = await db.get("conv_1");
    expect(row).toMatchObject({ owner_device_id: "host", cloud_placement: "pending" });
    expect(typeof row.cloud_placement_token).toBe("string");
    expect(row.session_error).toBeUndefined();
    const spawn = spawns(db);
    expect(spawn).toHaveLength(1);
    expect(spawnArgs(spawn[0]).placement_token).toBe(row.cloud_placement_token);
    expect(spawn[0].target_device_id).toBe("laptop");
    const release = db._tables.daemon_commands.find((c: any) => c.command === "release_session");
    expect(release).toMatchObject({ target_device_id: "laptop", user_id: ME });
  });

  test("a second park with a live cloud_spawn is a no-op; an expired one re-enqueues with a NEW token and clears the error", async () => {
    const db = fixture({ conversations: [blankRow()] });
    await parkOnCloudHost({ db }, ME, await db.get("conv_1"), "host");
    // Snapshot: the fake db's get() hands back the live row.
    const first = { ...(await db.get("conv_1")) };
    expect(await parkOnCloudHost({ db }, ME, first, "host")).toBeNull();
    expect(spawns(db)).toHaveLength(1);
    // The daemon ran it and failed: executed_at set, session_error on the row.
    await db.patch(spawns(db)[0]._id, { executed_at: now(), error: "cloud host preparation failed (exit 1)" });
    await db.patch("conv_1", { session_error: "cloud host preparation failed (exit 1)" });
    const again = await parkOnCloudHost({ db }, ME, await db.get("conv_1"), "host");
    expect(again).not.toBeNull();
    const row = await db.get("conv_1");
    expect(row.cloud_placement_token).not.toBe(first.cloud_placement_token);
    expect(row.session_error).toBeUndefined();
    expect(spawns(db)).toHaveLength(2);
    expect(spawnArgs(spawns(db)[1]).placement_token).toBe(row.cloud_placement_token);
  });

  test("a command past the poll TTL no longer counts as live", async () => {
    const db = fixture({ conversations: [blankRow()] });
    await parkOnCloudHost({ db }, ME, await db.get("conv_1"), "host");
    await db.patch(spawns(db)[0]._id, { created_at: now() - COMMAND_TTL_MS - 1 });
    expect(await liveCloudSpawnFor({ db }, ME, "conv_1" as any)).toBeNull();
    expect(await parkOnCloudHost({ db }, ME, await db.get("conv_1"), "host")).not.toBeNull();
    expect(spawns(db)).toHaveLength(2);
    // The stale one was superseded rather than left to be claimed later.
    expect(spawns(db)[0]).toMatchObject({ error: "superseded" });
  });

  test("a pathless park is tokenless with no cloud_spawn (nothing to prepare); the prior owner is still released", async () => {
    const db = fixture({ conversations: [blankRow({ owner_device_id: "laptop", project_path: undefined, git_root: undefined, session_error: "old" })] });
    expect(await parkOnCloudHost({ db }, ME, await db.get("conv_1"), "host")).toBeNull();
    const row = await db.get("conv_1");
    expect(row).toMatchObject({ owner_device_id: "host", cloud_placement: "pending" });
    expect(row.cloud_placement_token).toBeUndefined();
    expect(row.session_error).toBeUndefined();
    expect(spawns(db)).toHaveLength(0);
    expect(db._tables.daemon_commands.map((c: any) => c.command)).toEqual(["release_session"]);
    // The catch-up leaves it alone; the folder pick (another park) asks a laptop.
    expect(await reissueStrandedCloudSpawns({ db }, ME, "laptop")).toBe(0);
    expect(await parkOnCloudHost({ db }, ME, await db.get("conv_1"), "host", { projectPath: "/Users/me/src/app" })).not.toBeNull();
    expect(typeof (await db.get("conv_1")).cloud_placement_token).toBe("string");
    expect(spawns(db)).toHaveLength(1);
  });

  test("a workspace change re-parks past a live cloud_spawn (the toggle moved): superseded, fresh token, new mode in the args; isolated drops a stale claim", async () => {
    const db = fixture({ conversations: [blankRow()] });
    await parkOnCloudHost({ db }, ME, await db.get("conv_1"), "host", { workspace: "isolated" });
    const first = { ...(await db.get("conv_1")) };
    expect(await parkOnCloudHost({ db }, ME, { ...first }, "host", { workspace: "isolated" })).toBeNull();
    expect(await parkOnCloudHost({ db }, ME, { ...first }, "host", { workspace: "shared" })).not.toBeNull();
    const row = await db.get("conv_1");
    expect(row.cloud_workspace).toBe("shared");
    expect(row.cloud_placement_token).not.toBe(first.cloud_placement_token);
    expect(spawns(db)).toHaveLength(2);
    expect(spawns(db)[0]).toMatchObject({ error: "superseded" });
    expect(spawnArgs(spawns(db)[1]).workspace).toBe("shared");
    // Back to isolated: the claim a shared attempt stamped is dropped with the mode.
    await db.patch("conv_1", { cloud_checkout_path: "/home/ubuntu/work/app" });
    expect(await parkOnCloudHost({ db }, ME, await db.get("conv_1"), "host", { workspace: "isolated" })).not.toBeNull();
    expect((await db.get("conv_1")).cloud_workspace).toBe("isolated");
    expect((await db.get("conv_1")).cloud_checkout_path).toBeUndefined();
    expect(spawnArgs(spawns(db)[2]).workspace).toBe("isolated");
  });

  test("force re-parks past a live cloud_spawn (the folder changed): superseded, fresh token", async () => {
    const db = fixture({ conversations: [blankRow()] });
    await parkOnCloudHost({ db }, ME, await db.get("conv_1"), "host");
    const first = { ...(await db.get("conv_1")) };
    expect(await parkOnCloudHost({ db }, ME, first, "host", { projectPath: "/Users/me/src/other", force: true })).not.toBeNull();
    const row = await db.get("conv_1");
    expect(row.cloud_placement_token).not.toBe(first.cloud_placement_token);
    expect(spawns(db).map((c: any) => c.error)).toEqual(["superseded", undefined]);
    expect(spawnArgs(spawns(db)[1]).placement_token).toBe(row.cloud_placement_token);
  });

  test("a claimed cloud_spawn stays live for the child's full run, past the poll TTL and its expired_ttl stamp", async () => {
    const t = now();
    const base = { command: "cloud_spawn", args: JSON.stringify({ conversation_id: "conv_1" }) };
    expect(cloudSpawnLive({ ...base, created_at: t - 1000 }, t)).toBe(true);
    expect(cloudSpawnLive({ ...base, created_at: t - COMMAND_TTL_MS - 1 }, t)).toBe(false);
    // Claimed 10 minutes ago, still pending (the heartbeat has not swept yet).
    expect(cloudSpawnLive({ ...base, created_at: t - 10 * 60_000, claimed_at: t - 10 * 60_000 }, t)).toBe(true);
    // Swept by the heartbeat: expired_ttl with no result means the child is still running.
    expect(cloudSpawnLive({ ...base, created_at: t - 10 * 60_000, claimed_at: t - 10 * 60_000, executed_at: t - 5 * 60_000, error: "expired_ttl" }, t)).toBe(true);
    // The child reported: done, whichever way.
    expect(cloudSpawnLive({ ...base, created_at: t - 10 * 60_000, claimed_at: t - 10 * 60_000, executed_at: t - 60_000, result: "{\"placed\":true}" }, t)).toBe(false);
    expect(cloudSpawnLive({ ...base, created_at: t - 10 * 60_000, claimed_at: t - 10 * 60_000, executed_at: t - 60_000, error: "cloud host preparation failed (exit 1)" }, t)).toBe(false);
    expect(cloudSpawnLive({ ...base, created_at: t - 10 * 60_000, claimed_at: t - 10 * 60_000, executed_at: t - 60_000, error: "superseded" }, t)).toBe(false);
    // Past the run ceiling the claim no longer counts.
    expect(cloudSpawnLive({ ...base, created_at: t - CLOUD_SPAWN_RUN_MS - 60_000, claimed_at: t - CLOUD_SPAWN_RUN_MS - 1, executed_at: t - 20 * 60_000, error: "expired_ttl" }, t)).toBe(false);
    expect(cloudSpawnLive({ command: "start_session", claimed_at: t }, t)).toBe(false);

    // Through the row: a second park while the swept child runs is a no-op — no second child.
    const db = fixture({ conversations: [blankRow()] });
    await parkOnCloudHost({ db }, ME, await db.get("conv_1"), "host");
    const cmd = spawns(db)[0];
    await db.patch(cmd._id, { created_at: t - 10 * 60_000, claimed_at: t - 10 * 60_000, claimed_by: "boot", executed_at: t - 5 * 60_000, error: "expired_ttl" });
    expect((await liveCloudSpawnFor({ db }, ME, "conv_1" as any))?._id).toBe(cmd._id);
    expect(await parkOnCloudHost({ db }, ME, { ...(await db.get("conv_1")) }, "host")).toBeNull();
    expect(spawns(db)).toHaveLength(1);
    expect(await reissueStrandedCloudSpawns({ db }, ME, "laptop")).toBe(0);
  });

  test("no online laptop → still parks, targets the most-recent laptop, and says it is waiting", async () => {
    const db = fixture({ devices: [host(), laptop({ last_seen: asleep() })], conversations: [blankRow()] });
    await parkOnCloudHost({ db }, ME, await db.get("conv_1"), "host");
    const row = await db.get("conv_1");
    expect(row.cloud_placement).toBe("pending");
    expect(row.session_error).toBe("Waiting for MacBook to come online to prepare the cloud host");
    expect(spawns(db)[0].target_device_id).toBe("laptop");
  });

  test("no laptop at all → throws and leaves the row alone", async () => {
    const db = fixture({ devices: [host()], conversations: [blankRow()] });
    await expect(parkOnCloudHost({ db }, ME, await db.get("conv_1"), "host")).rejects.toThrow("No laptop can prepare");
    expect((await db.get("conv_1")).cloud_placement).toBeUndefined();
  });

  test("supersedeCloudSpawns retires every live cloud_spawn for the row only", async () => {
    const db = fixture({ conversations: [blankRow(), blankRow({ _id: "conv_2" })] });
    await parkOnCloudHost({ db }, ME, await db.get("conv_1"), "host");
    await parkOnCloudHost({ db }, ME, await db.get("conv_2"), "host");
    expect(await supersedeCloudSpawns({ db }, ME, "conv_1" as any)).toBe(1);
    expect(spawns(db).map((c: any) => c.error)).toEqual(["superseded", undefined]);
  });
});

describe("reissueStrandedCloudSpawns — a laptop's offline→online catch-up", () => {
  test("re-issues for a pending row with no live command and skips killed/completed/placed/tokenless rows and rows with a live command", async () => {
    const db = fixture({
      conversations: [
        blankRow({ _id: "stranded", owner_device_id: "host", cloud_placement: "pending", cloud_placement_token: "tok-1", session_error: "Waiting for MacBook to come online to prepare the cloud host" }),
        blankRow({ _id: "live", owner_device_id: "host", cloud_placement: "pending", cloud_placement_token: "tok-2" }),
        blankRow({ _id: "killed", owner_device_id: "host", cloud_placement: "pending", cloud_placement_token: "tok-3", inbox_killed_at: 1 }),
        blankRow({ _id: "done", owner_device_id: "host", cloud_placement: "pending", cloud_placement_token: "tok-4", status: "completed" }),
        blankRow({ _id: "placed", owner_device_id: "host", worktree_path: "/home/ubuntu/work/app/.codecast/worktrees/x" }),
        blankRow({ _id: "refused", owner_device_id: "host", cloud_placement: "pending" }),
        blankRow({ _id: "laptop-row", owner_device_id: "laptop" }),
      ],
      commands: [{ _id: "cmd_live", user_id: ME, command: "cloud_spawn", args: JSON.stringify({ conversation_id: "live", cloud_device_id: "host", placement_token: "tok-2" }), created_at: now() - 1000, target_device_id: "laptop" }],
    });
    expect(await reissueStrandedCloudSpawns({ db }, ME, "laptop")).toBe(1);
    const issued = spawns(db).filter((c: any) => c._id !== "cmd_live");
    expect(issued).toHaveLength(1);
    expect(issued[0].target_device_id).toBe("laptop");
    expect(spawnArgs(issued[0])).toEqual({ conversation_id: "stranded", cloud_device_id: "host", placement_token: "tok-1" });
    expect((await db.get("stranded")).session_error).toBeUndefined();
    // Idempotent: the fresh command is now live.
    expect(await reissueStrandedCloudSpawns({ db }, ME, "laptop")).toBe(0);
  });
});
