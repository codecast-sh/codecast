import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { BROWSER_SYNC_PENDING_CAP, claimSharedCheckout, commandOutcome, pickOnlineLocalDevice, placeConversation, placementFence, reportPlacementFailure, requestBrowserSync, requestRemoteWake, wakeDevicesFor } from "./cloud";
import { resolveOfflineOwnerTakeover } from "./pendingMessages";
import { DEVICE_ONLINE_MS } from "./deviceRouting";

const now = 1_000_000_000;
const online = now - 10_000;
const asleep = now - DEVICE_ONLINE_MS - 60_000;

describe("wakeDevicesFor — which sleeping hosts a local daemon should boot", () => {
  test("a remote that is offline with a stamp newer than its last beat", () => {
    expect(wakeDevicesFor([
      { device_id: "box", label: "Cloud Linux", last_seen: asleep, is_remote: true, wake_requested_at: now - 1000 },
    ], now)).toEqual([{ device_id: "box", label: "Cloud Linux" }]);
  });
  test("an answered stamp (older than the last beat), an online remote, or a local device never wakes", () => {
    expect(wakeDevicesFor([
      { device_id: "box", last_seen: asleep, is_remote: true, wake_requested_at: asleep - 5 },
      { device_id: "awake", last_seen: online, is_remote: true, wake_requested_at: now },
      { device_id: "laptop", last_seen: asleep, is_remote: false, wake_requested_at: now },
    ], now)).toEqual([]);
  });
});

describe("requestRemoteWake — stamping the device when work queues for a sleeping host", () => {
  const user = "user1" as any;
  function db(devices: any[]) {
    return makeFakeDb({ devices, conversations: [] });
  }
  test("stamps an offline remote owner once", async () => {
    const d = db([{ _id: "dev1", user_id: user, device_id: "box", is_remote: true, last_seen: asleep }]);
    const conv = { user_id: user, owner_device_id: "box" };
    expect(await requestRemoteWake({ db: d } as any, conv)).toBe(true);
    const row = await d.get("dev1");
    expect(typeof row.wake_requested_at).toBe("number");
    const stampedAt = row.wake_requested_at;
    expect(await requestRemoteWake({ db: d } as any, conv)).toBe(true);
    expect((await d.get("dev1")).wake_requested_at).toBe(stampedAt);
  });
  test("a row still waiting for a laptop to prepare the host never wakes it", async () => {
    const d = db([{ _id: "dev1", user_id: user, device_id: "box", is_remote: true, last_seen: asleep }]);
    expect(await requestRemoteWake({ db: d } as any, { user_id: user, owner_device_id: "box", cloud_placement: "pending" })).toBe(false);
    expect((await d.get("dev1")).wake_requested_at).toBeUndefined();
  });
  test("a just-stopped remote retains wake intent until its heartbeat expires", async () => {
    const d = db([
      { _id: "dev1", user_id: user, device_id: "box", is_remote: true, last_seen: Date.now() },
      { _id: "dev2", user_id: user, device_id: "laptop", is_remote: false, last_seen: asleep },
    ]);
    expect(await requestRemoteWake({ db: d } as any, { user_id: user, owner_device_id: "box" })).toBe(true);
    expect(await requestRemoteWake({ db: d } as any, { user_id: user, owner_device_id: "laptop" })).toBe(false);
    expect(await requestRemoteWake({ db: d } as any, { user_id: user })).toBe(false);
    const remote = await d.get("dev1");
    expect(wakeDevicesFor([remote], remote.last_seen + DEVICE_ONLINE_MS)).toEqual([{ device_id: "box", label: null }]);
    expect((await d.get("dev2")).wake_requested_at).toBeUndefined();
  });
});

describe("resolveOfflineOwnerTakeover — a sleeping cloud host is not a dead laptop", () => {
  const user = "user1" as any;
  test("a local claimant may take over an offline LOCAL owner, never an offline REMOTE one", async () => {
    const d = makeFakeDb({
      devices: [
        { _id: "a", user_id: user, device_id: "laptop", is_remote: false, last_seen: now },
        { _id: "b", user_id: user, device_id: "old-laptop", is_remote: false, last_seen: asleep },
        { _id: "c", user_id: user, device_id: "box", is_remote: true, last_seen: asleep },
      ],
    });
    expect(await resolveOfflineOwnerTakeover({ db: d } as any, user, "laptop", "old-laptop", now)).toBe(true);
    expect(await resolveOfflineOwnerTakeover({ db: d } as any, user, "laptop", "box", now)).toBe(false);
  });
});

describe("placeConversation — fenced by the park's token", () => {
  const user = "users_1" as any;
  const ctx = (db: any) => ({ db, auth: { getUserIdentity: async () => ({ subject: `${user}|session` }) } });
  function fixture(row: Record<string, any>) {
    return makeFakeDb({
      users: [{ _id: user }],
      devices: [
        { _id: "dev_host", user_id: user, device_id: "box", label: "Linux - ip-1-2-3-4", platform: "linux", is_remote: true, last_seen: online },
        { _id: "dev_laptop", user_id: user, device_id: "laptop", label: "mac", platform: "darwin", is_remote: false, last_seen: online },
      ],
      conversations: [{ _id: "conv_1", user_id: user, session_id: "sess", agent_type: "claude_code", project_path: "/Users/me/app", ...row }],
      daemon_commands: [],
      pending_messages: [],
    });
  }
  const place = (db: any, extra: Record<string, any> = {}) => (placeConversation as any)._handler(ctx(db), {
    conversation_id: "conv_1", device_id: "box", project_path: "/home/ubuntu/work/app/.codecast/worktrees/cloud-1",
    worktree_name: "cloud-1", worktree_branch: "codecast/cloud-1", worktree_path: "/home/ubuntu/work/app/.codecast/worktrees/cloud-1",
    start: false, ...extra,
  });

  test("placementFence: no expectation is unfenced; wrong token superseded; not pending", () => {
    expect(placementFence({ cloud_placement: "pending", cloud_placement_token: "a" }, undefined)).toBeNull();
    expect(placementFence({ cloud_placement: "pending", cloud_placement_token: "a" }, "a")).toBeNull();
    expect(placementFence({ cloud_placement: "pending", cloud_placement_token: "b" }, "a")).toBe("superseded");
    expect(placementFence({ cloud_placement: null, cloud_placement_token: null }, "a")).toBe("not_pending");
    expect(placementFence({}, "a")).toBe("not_pending");
  });

  test("a matching token places, clears pending + token, and starts at the host", async () => {
    const db = fixture({ owner_device_id: "box", cloud_placement: "pending", cloud_placement_token: "tok" });
    const r = await place(db, { expect_token: "tok", start: true });
    expect(r).toMatchObject({ placed: true, owner_device_id: "box" });
    expect(r.command_id).toBeTruthy();
    const row = await db.get("conv_1");
    expect(row).toMatchObject({ owner_device_id: "box", worktree_name: "cloud-1", worktree_status: "active" });
    expect(row.cloud_placement).toBeUndefined();
    expect(row.cloud_placement_token).toBeUndefined();
    const start = db._tables.daemon_commands.find((c: any) => c.command === "start_session");
    expect(start.target_device_id).toBe("box");
  });

  test("a stale token is refused as superseded and the row is untouched", async () => {
    const db = fixture({ owner_device_id: "box", cloud_placement: "pending", cloud_placement_token: "tok-2" });
    const before = { ...(await db.get("conv_1")) };
    expect(await place(db, { expect_token: "tok-1" })).toEqual({ placed: false, reason: "superseded", command_id: null, owner_device_id: "box" });
    expect(await db.get("conv_1")).toEqual(before);
    expect(db._tables.daemon_commands).toEqual([]);
  });

  test("a row no longer pending (re-pointed at the laptop) is refused as not_pending", async () => {
    const db = fixture({ owner_device_id: "laptop" });
    expect(await place(db, { expect_token: "tok" })).toMatchObject({ placed: false, reason: "not_pending", owner_device_id: "laptop" });
    expect((await db.get("conv_1")).owner_device_id).toBe("laptop");
  });

  test("a failed placement is recorded under its own token, and a report from a park that is over is ignored", async () => {
    const report = (db: any, token: string | undefined) => (reportPlacementFailure as any)._handler(ctx(db), {
      conversation_id: "conv_1", ...(token ? { placement_token: token } : {}), error: "cloud host preparation failed (exit 1)",
    });
    const db = fixture({ owner_device_id: "box", cloud_placement: "pending", cloud_placement_token: "tok" });
    expect(await report(db, "tok")).toEqual({ recorded: true });
    const row = await db.get("conv_1");
    expect(row.session_error).toBe("cloud host preparation failed (exit 1)");
    expect(row.cloud_placement_failed_at).toBeGreaterThan(0);

    // The row was re-parked while the child was mid-ssh: its failure belongs
    // to the park that is over, and must not show on the new one.
    const reparked = fixture({ owner_device_id: "box", cloud_placement: "pending", cloud_placement_token: "tok-2" });
    expect(await report(reparked, "tok")).toEqual({ recorded: false, reason: "superseded" });
    expect((await reparked.get("conv_1")).session_error).toBeUndefined();
    // …and one already placed (no longer pending).
    const placed = fixture({ owner_device_id: "box" });
    expect(await report(placed, "tok")).toEqual({ recorded: false, reason: "not_pending" });
    expect((await placed.get("conv_1")).cloud_placement_failed_at).toBeUndefined();
  });

  test("an owner change releases the previous owner; no expectation stays unfenced", async () => {
    const db = fixture({ owner_device_id: "laptop", cloud_placement: "pending" });
    expect(await place(db)).toMatchObject({ placed: true, owner_device_id: "box" });
    const release = db._tables.daemon_commands.find((c: any) => c.command === "release_session");
    expect(release).toMatchObject({ target_device_id: "laptop" });
    expect(JSON.parse(release.args)).toEqual({ conversation_id: "conv_1", session_id: "sess" });
  });
});

describe("shared checkout occupancy — claim, place, create (ct-49428)", () => {
  const user = "users_1" as any;
  const ROOT = "/home/ubuntu/work/app";
  const ctx = (db: any) => ({ db, auth: { getUserIdentity: async () => ({ subject: `${user}|session` }) } });
  const shared = (over: Record<string, any> = {}) => ({
    _id: "conv_holder", user_id: user, session_id: "held", agent_type: "claude_code", short_id: "holder1", title: "the holder",
    owner_device_id: "box", project_path: ROOT, git_root: ROOT, cloud_workspace: "shared", cloud_checkout_path: ROOT, status: "active", ...over,
  });
  function fixture(rows: Record<string, any>[]) {
    return makeFakeDb({
      users: [{ _id: user }],
      devices: [
        { _id: "dev_host", user_id: user, device_id: "box", label: "Linux - ip-1-2-3-4", platform: "linux", is_remote: true, last_seen: online, local_project_roots: [ROOT] },
        { _id: "dev_laptop", user_id: user, device_id: "laptop", label: "mac", platform: "darwin", is_remote: false, last_seen: online, local_project_roots: ["/Users/me/app"] },
      ],
      conversations: rows,
      daemon_commands: [],
      pending_messages: [],
      rate_limits: [],
      directory_team_mappings: [],
      change_log: [],
      local_view_heads: [],
    });
  }
  const claimant = (over: Record<string, any> = {}) => ({
    _id: "conv_new", user_id: user, session_id: "new", agent_type: "claude_code", short_id: "newone1",
    owner_device_id: "box", project_path: "/Users/me/app", git_root: "/Users/me/app", cloud_placement: "pending", ...over,
  });
  const claim = (db: any, extra: Record<string, any> = {}) => (claimSharedCheckout as any)._handler(ctx(db), {
    conversation_id: "conv_new", device_id: "box", project_path: ROOT, git_root: ROOT, ...extra,
  });
  const place = (db: any, extra: Record<string, any> = {}) => (placeConversation as any)._handler(ctx(db), {
    conversation_id: "conv_new", device_id: "box", project_path: ROOT, git_root: ROOT, worktree_branch: "codecast/cloud-abc123",
    cloud_workspace: "shared", start: true, ...extra,
  });

  test("claimSharedCheckout is refused by a placed shared row, a pending one without error, and a legacy moved row", async () => {
    for (const holder of [
      shared(),
      shared({ cloud_placement: "pending", cloud_placement_token: "t" }),
      { _id: "conv_moved", user_id: user, session_id: "moved", short_id: "moved01", title: "moved here", owner_device_id: "box", project_path: ROOT, status: "active" },
    ]) {
      const db = fixture([holder, claimant()]);
      await expect(claim(db)).rejects.toThrow(/is in use by session (holder1|moved01)/);
      const row = await db.get("conv_new");
      expect(row.cloud_workspace).toBeUndefined();
      expect(row.cloud_checkout_path).toBeUndefined();
    }
  });

  test("claimSharedCheckout is allowed when the holder is killed, completed, or pending WITH an error; the claim stamps the row", async () => {
    for (const holder of [shared({ inbox_killed_at: 5 }), shared({ status: "completed" }), shared({ cloud_placement: "pending", session_error: "cast cloud start failed" })]) {
      const db = fixture([holder, claimant({ session_error: "earlier failure" })]);
      expect(await claim(db)).toEqual({ claimed: true });
      const row = await db.get("conv_new");
      expect(row).toMatchObject({ cloud_workspace: "shared", cloud_checkout_path: ROOT, owner_device_id: "box", cloud_placement: "pending" });
      expect(row.session_error).toBeUndefined();
    }
  });

  test("re-claiming the same row is allowed (exclude-self) and a row no longer pending or superseded is refused without a throw", async () => {
    const db = fixture([claimant({ cloud_workspace: "shared", cloud_checkout_path: ROOT, cloud_placement_token: "tok" })]);
    expect(await claim(db, { expect_token: "tok" })).toEqual({ claimed: true });
    expect(await claim(db, { expect_token: "stale" })).toEqual({ claimed: false, reason: "superseded" });
    const placed = fixture([claimant({ cloud_placement: undefined })]);
    expect(await claim(placed)).toEqual({ claimed: false, reason: "not_pending" });
    expect((await placed.get("conv_new")).cloud_checkout_path).toBeUndefined();
  });

  test("placeConversation: a shared placement needs a prior claim on the same path", async () => {
    const db = fixture([claimant()]);
    await expect(place(db)).rejects.toThrow(/place after claimSharedCheckout/);
    const other = fixture([claimant({ cloud_workspace: "shared", cloud_checkout_path: "/home/ubuntu/work/other" })]);
    await expect(place(other)).rejects.toThrow(/claimed \/home\/ubuntu\/work\/other, not \/home\/ubuntu\/work\/app/);
  });

  test("placeConversation: a second live shared row on the same device+path is refused; re-placing the same row and an isolated row beside it are fine", async () => {
    const busy = fixture([shared(), claimant({ cloud_workspace: "shared", cloud_checkout_path: ROOT })]);
    await expect(place(busy)).rejects.toThrow(/is in use by session holder1/);
    expect(busy._tables.daemon_commands).toEqual([]);

    const own = fixture([claimant({ cloud_workspace: "shared", cloud_checkout_path: ROOT })]);
    const r = await place(own);
    expect(r).toMatchObject({ placed: true, owner_device_id: "box" });
    const row = await own.get("conv_new");
    expect(row).toMatchObject({ cloud_workspace: "shared", cloud_checkout_path: ROOT, project_path: ROOT, worktree_branch: "codecast/cloud-abc123" });
    expect(row.worktree_name).toBeUndefined();
    expect(row.cloud_placement).toBeUndefined();
    expect(own._tables.daemon_commands.map((c: any) => c.command)).toEqual(["start_session"]);

    const iso = fixture([shared(), claimant()]);
    const wt = `${ROOT}/.codecast/worktrees/cloud-1`;
    const placed = await (placeConversation as any)._handler(ctx(iso), {
      conversation_id: "conv_new", device_id: "box", project_path: wt, git_root: wt, worktree_name: "cloud-1", worktree_branch: "codecast/cloud-1", worktree_path: wt, start: false,
    });
    expect(placed.placed).toBe(true);
    expect((await iso.get("conv_new")).cloud_workspace).toBe("isolated");

    // A row that once claimed the root and then placed isolated drops the claim.
    const stale = fixture([claimant({ cloud_workspace: "shared", cloud_checkout_path: ROOT })]);
    await (placeConversation as any)._handler(ctx(stale), {
      conversation_id: "conv_new", device_id: "box", project_path: wt, git_root: wt, worktree_name: "cloud-1", worktree_branch: "codecast/cloud-1", worktree_path: wt, cloud_workspace: "isolated", start: false,
    });
    expect((await stale.get("conv_new"))).toMatchObject({ cloud_workspace: "isolated" });
    expect((await stale.get("conv_new")).cloud_checkout_path).toBeUndefined();
  });

  test("enqueueCloudSpawn carries the workspace in the args JSON and still picks the newest online local daemon", async () => {
    const db = fixture([claimant()]);
    db._tables.devices.push({ _id: "dev_old", user_id: user, device_id: "old-laptop", platform: "darwin", is_remote: false, last_seen: online - 50_000 });
    const { enqueueCloudSpawn } = await import("./cloudPlacement");
    const { commandId } = await enqueueCloudSpawn({ db } as any, user, { conversationId: "conv_new" as any, cloudDeviceId: "box", projectPath: "/opt/x", workspace: "shared" });
    const cmd = await db.get(commandId);
    expect(JSON.parse(cmd.args)).toEqual({ conversation_id: "conv_new", cloud_device_id: "box", workspace: "shared" });
    expect(cmd.target_device_id).toBe("laptop");
    const iso = await enqueueCloudSpawn({ db } as any, user, { conversationId: "conv_new" as any, cloudDeviceId: "box", projectPath: "/opt/x" });
    expect(JSON.parse((await db.get(iso.commandId)).args).workspace).toBeUndefined();
  });

  test("createQuickSession: a shared create throws on a basename occupant; a free checkout parks with workspace in the cloud_spawn", async () => {
    const { createQuickSession } = await import("./conversations");
    const busy = fixture([shared()]);
    await expect((createQuickSession as any)._handler(ctx(busy), { project_path: "/Users/me/app", git_root: "/Users/me/app", cloud_device_id: "box", cloud_workspace: "shared" }))
      .rejects.toThrow(/is in use by session holder1/);
    expect(busy._tables.conversations).toHaveLength(1);

    const free = fixture([]);
    const id = await (createQuickSession as any)._handler(ctx(free), { project_path: "/Users/me/app", git_root: "/Users/me/app", cloud_device_id: "box", cloud_workspace: "shared" });
    const row = await free.get(id);
    expect(row).toMatchObject({ owner_device_id: "box", cloud_placement: "pending", cloud_workspace: "shared" });
    const spawn = free._tables.daemon_commands.find((c: any) => c.command === "cloud_spawn");
    expect(JSON.parse(spawn.args).workspace).toBe("shared");
    const iso = await (createQuickSession as any)._handler(ctx(free), { project_path: "/Users/me/app", git_root: "/Users/me/app", cloud_device_id: "box" });
    expect((await free.get(iso)).cloud_workspace).toBe("isolated");
  });

  test("dispatch.createSession: a busy checkout inserts a PARKED row with session_error and enqueues nothing; garbage normalises to isolated", async () => {
    const { dispatch } = await import("./dispatch");
    const busy = fixture([shared()]);
    const id = await (dispatch as any)._handler(ctx(busy), {
      action: "createSession", args: [{ session_id: "stub-1", agent_type: "claude_code", project_path: "/Users/me/app", git_root: "/Users/me/app", cloud_device_id: "box", target_device_id: "box", cloud_workspace: "shared" }],
    });
    const row = await busy.get(id);
    expect(row).toMatchObject({ owner_device_id: "box", cloud_placement: "pending", cloud_workspace: "shared" });
    expect(row.session_error).toMatch(/is in use by session holder1/);
    expect(row.cloud_placement_token).toBeUndefined();
    expect(busy._tables.daemon_commands.filter((c: any) => c.command === "cloud_spawn")).toEqual([]);

    const free = fixture([]);
    const id2 = await (dispatch as any)._handler(ctx(free), {
      action: "createSession", args: [{ session_id: "stub-2", agent_type: "claude_code", project_path: "/Users/me/app", git_root: "/Users/me/app", cloud_device_id: "box", target_device_id: "box", cloud_workspace: "SHARED" }],
    });
    expect((await free.get(id2)).cloud_workspace).toBe("isolated");
    expect(JSON.parse(free._tables.daemon_commands.find((c: any) => c.command === "cloud_spawn").args).workspace).toBe("isolated");
  });

  test("createSessionFromCli --shared: the parked insert IS the claim — refused on an occupant, otherwise parked with no start and no seed", async () => {
    const { createSessionFromCli } = await import("./spawn");
    const args = { agent_type: "claude_code", project_path: "/Users/me/app", git_root: "/Users/me/app", privacy_path: "/Users/me/app", cloud_device_id: "box", cloud_workspace: "shared", cloud_checkout_path: ROOT };
    const busy = fixture([shared()]);
    await expect((createSessionFromCli as any)._handler(ctx(busy), args)).rejects.toThrow(/is in use by session holder1/);
    expect(busy._tables.conversations).toHaveLength(1);

    const free = fixture([]);
    const r = await (createSessionFromCli as any)._handler(ctx(free), args);
    const row = await free.get(r.conversation_id);
    expect(row).toMatchObject({ owner_device_id: "box", cloud_placement: "pending", cloud_workspace: "shared", cloud_checkout_path: ROOT, short_id: r.short_id });
    expect(free._tables.daemon_commands).toEqual([]);
    expect(free._tables.pending_messages).toEqual([]);
    // The parked row now holds the checkout against a second claimant.
    await expect((createSessionFromCli as any)._handler(ctx(free), args)).rejects.toThrow(new RegExp(`is in use by session ${r.short_id}`));
    await expect((createSessionFromCli as any)._handler(ctx(free), { ...args, cloud_checkout_path: undefined })).rejects.toThrow(/needs cloud_device_id and cloud_checkout_path/);
  });
});

describe("where a cloud session starts: cloud_start_from, cloud_seed, the preparer (ct-49433)", () => {
  const user = "users_1" as any;
  const ctx = (db: any) => ({ db, auth: { getUserIdentity: async () => ({ subject: `${user}|session` }) } });
  const base = "abc1234def0000000000000000000000000000000";
  // Real time: the preparer choice asks "online now", which the fixed `online` above is not.
  const live = Date.now() - 10_000;
  function fixture(rows: Record<string, any>[], devices: Record<string, any>[] = []) {
    return makeFakeDb({
      users: [{ _id: user }],
      devices: [
        { _id: "dev_host", user_id: user, device_id: "box", label: "Linux - ip-1-2-3-4", platform: "linux", is_remote: true, last_seen: live, local_project_roots: ["/home/ubuntu/work/app"] },
        ...devices,
      ],
      conversations: rows,
      daemon_commands: [],
      pending_messages: [],
      rate_limits: [],
      directory_team_mappings: [],
      change_log: [],
      local_view_heads: [],
    });
  }
  const laptop = (over: Record<string, any> = {}) => ({ _id: "dev_laptop", user_id: user, device_id: "laptop", label: "mac", platform: "darwin", is_remote: false, last_seen: live, local_project_roots: ["/Users/me/app"], ...over });
  const parked = (over: Record<string, any> = {}) => ({
    _id: "conv_1", user_id: user, session_id: "sess", agent_type: "claude_code", short_id: "conv001", project_path: "/Users/me/app", git_root: "/Users/me/app",
    git_remote_url: "git@github.com:me/app.git", owner_device_id: "box", cloud_placement: "pending", cloud_placement_token: "tok", cloud_start_from: "checkout", ...over,
  });
  const wt = "/home/ubuntu/work/app/.codecast/worktrees/cloud-1";
  const seed = { source: "checkout" as const, base, branch: "feat/x", dirty: true, laptop_root: "/Users/me/app", device_id: "laptop" };
  const spawnsFor = (db: any) => db._tables.daemon_commands.filter((c: any) => c.command === "cloud_spawn");

  test("placeConversation stamps cloud_seed with `at` and clears the placement; hostSessions and placementTarget expose it", async () => {
    const db = fixture([parked()], [laptop()]);
    const before = Date.now();
    const r = await (placeConversation as any)._handler(ctx(db), {
      conversation_id: "conv_1", device_id: "box", project_path: wt, git_root: wt, worktree_name: "cloud-1", worktree_branch: "feat/x", worktree_path: wt,
      cloud_workspace: "isolated", seed, start: true, expect_token: "tok",
    });
    expect(r.placed).toBe(true);
    const row = await db.get("conv_1");
    expect(row.cloud_seed).toMatchObject(seed);
    expect(row.cloud_seed.at).toBeGreaterThanOrEqual(before);
    expect(row.cloud_placement).toBeUndefined();
    expect(row.worktree_branch).toBe("feat/x");
    const { hostSessions, placementTarget } = await import("./cloud");
    const rows = await (hostSessions as any)._handler(ctx(db), { device_id: "box" });
    expect(rows[0].cloud_seed).toEqual({ source: "checkout", base, branch: "feat/x", dirty: true, device_id: "laptop", reason: null });
    const target = await (placementTarget as any)._handler(ctx(db), { conversation_id: "conv_1" });
    expect(target).toMatchObject({ cloud_start_from: "checkout", git_remote_url: "git@github.com:me/app.git" });
    // A placement without a seed (an older CLI) leaves the field alone.
    const plain = fixture([parked({ cloud_start_from: undefined })], [laptop()]);
    await (placeConversation as any)._handler(ctx(plain), { conversation_id: "conv_1", device_id: "box", project_path: wt, worktree_name: "cloud-1", worktree_path: wt, start: false });
    expect((await plain.get("conv_1")).cloud_seed).toBeUndefined();
    const rows2 = await (hostSessions as any)._handler(ctx(plain), { device_id: "box" });
    expect(rows2[0].cloud_seed).toBeNull();
    expect((await (placementTarget as any)._handler(ctx(plain), { conversation_id: "conv_1" })).cloud_start_from).toBeNull();
  });

  test("enqueueCloudSpawn prefers the online local whose roots hold the row's repo over a more recently seen one, else last_seen; the args carry start_from", async () => {
    const { enqueueCloudSpawn } = await import("./cloudPlacement");
    const db = fixture([parked()], [laptop({ last_seen: live - 30_000 }), laptop({ _id: "dev_desk", device_id: "desk", label: "desk", local_project_roots: ["/Users/me/other"], last_seen: live })]);
    const held = await enqueueCloudSpawn({ db } as any, user, { conversationId: "conv_1" as any, cloudDeviceId: "box", gitRoot: "/Users/me/app", projectPath: "/Users/me/app/src", startFrom: "checkout", token: "tok" });
    expect((await db.get(held.commandId)).target_device_id).toBe("laptop");
    expect(JSON.parse((await db.get(held.commandId)).args)).toEqual({ conversation_id: "conv_1", cloud_device_id: "box", placement_token: "tok", start_from: "checkout" });
    const nobody = await enqueueCloudSpawn({ db } as any, user, { conversationId: "conv_1" as any, cloudDeviceId: "box", gitRoot: "/Users/me/elsewhere", startFrom: "origin_main" });
    expect((await db.get(nobody.commandId)).target_device_id).toBe("desk");
    expect(JSON.parse((await db.get(nobody.commandId)).args).start_from).toBe("origin_main");
  });

  test("parkOnCloudHost: a start_from change re-parks (the child in flight is superseded); shared forces origin_main; the row keeps the stamp", async () => {
    const { parkOnCloudHost } = await import("./cloudPlacement");
    const db = fixture([parked()], [laptop()]);
    const first = await parkOnCloudHost({ db } as any, user, await db.get("conv_1"), "box", { startFrom: "checkout" });
    expect(first).toBeTruthy();
    expect((await db.get("conv_1")).cloud_start_from).toBe("checkout");
    // Same choice, live command: idempotent.
    expect(await parkOnCloudHost({ db } as any, user, await db.get("conv_1"), "box", { startFrom: "checkout" })).toBeNull();
    expect(await parkOnCloudHost({ db } as any, user, await db.get("conv_1"), "box", {})).toBeNull();
    // A different choice: re-park with a fresh token; the earlier command is superseded.
    const second = await parkOnCloudHost({ db } as any, user, await db.get("conv_1"), "box", { startFrom: "origin_main" });
    expect(second).toBeTruthy();
    expect((await db.get(first!)).error).toBe("superseded");
    const row = await db.get("conv_1");
    expect(row.cloud_start_from).toBe("origin_main");
    expect(JSON.parse((await db.get(second!)).args)).toMatchObject({ start_from: "origin_main", placement_token: row.cloud_placement_token });
    // Shared never seeds from a laptop tree.
    const third = await parkOnCloudHost({ db } as any, user, await db.get("conv_1"), "box", { workspace: "shared", startFrom: "checkout" });
    expect(JSON.parse((await db.get(third!)).args)).toMatchObject({ workspace: "shared", start_from: "origin_main" });
    expect((await db.get("conv_1")).cloud_start_from).toBe("origin_main");
  });

  test("createQuickSession stores cloud_start_from with the cloud pair and the cloud_spawn carries it; absent means checkout", async () => {
    const { createQuickSession } = await import("./conversations");
    const db = fixture([], [laptop()]);
    const id = await (createQuickSession as any)._handler(ctx(db), { project_path: "/Users/me/app", git_root: "/Users/me/app", cloud_device_id: "box", cloud_start_from: "origin_main" });
    expect(await db.get(id)).toMatchObject({ owner_device_id: "box", cloud_placement: "pending", cloud_workspace: "isolated", cloud_start_from: "origin_main" });
    expect(JSON.parse(spawnsFor(db).at(-1).args).start_from).toBe("origin_main");
    const id2 = await (createQuickSession as any)._handler(ctx(db), { project_path: "/Users/me/app", git_root: "/Users/me/app", cloud_device_id: "box" });
    expect((await db.get(id2)).cloud_start_from).toBe("checkout");
    expect(JSON.parse(spawnsFor(db).at(-1).args).start_from).toBe("checkout");
    // A shared create is origin_main whatever was asked.
    const id3 = await (createQuickSession as any)._handler(ctx(db), { project_path: "/Users/me/app", git_root: "/Users/me/app", cloud_device_id: "box", cloud_workspace: "shared", cloud_start_from: "checkout" });
    expect((await db.get(id3)).cloud_start_from).toBe("origin_main");
  });

  test("dispatch.createSession stamps cloud_start_from; createSessionFromCli and forkFromMessage stamp cloud_seed with the time", async () => {
    const { dispatch } = await import("./dispatch");
    const db = fixture([], [laptop()]);
    const id = await (dispatch as any)._handler(ctx(db), {
      action: "createSession", args: [{ session_id: "stub-9", agent_type: "claude_code", project_path: "/Users/me/app", git_root: "/Users/me/app", cloud_device_id: "box", target_device_id: "box", cloud_workspace: "isolated", cloud_start_from: "origin_main" }],
    });
    expect((await db.get(id)).cloud_start_from).toBe("origin_main");
    expect(JSON.parse(spawnsFor(db).at(-1).args).start_from).toBe("origin_main");
    const { createSessionFromCli } = await import("./spawn");
    const r = await (createSessionFromCli as any)._handler(ctx(db), {
      agent_type: "claude_code", project_path: wt, git_root: wt, privacy_path: "/Users/me/app", device: "box",
      worktree_name: "cloud-1", worktree_branch: "feat/x", worktree_path: wt, cloud_seed: seed,
    });
    const row = await db.get(r.conversation_id);
    expect(row.cloud_seed).toMatchObject(seed);
    expect(typeof row.cloud_seed.at).toBe("number");
    expect(row.cloud_workspace).toBe("isolated");
  });
});

describe("pickOnlineLocalDevice — the laptop that carries a browser login", () => {
  const devices = [
    { device_id: "box", is_remote: true, last_seen: online, label: "Cloud Linux" },
    { device_id: "old-mac", is_remote: false, last_seen: online - 5_000, label: "old mac" },
    { device_id: "mac", is_remote: false, last_seen: online, label: "mac" },
    { device_id: "asleep", is_remote: false, last_seen: asleep, label: "asleep" },
  ];
  test("picks the most recently seen ONLINE local device, ignoring remotes and offline locals", () => {
    expect(pickOnlineLocalDevice(devices, now)).toEqual({ device_id: "mac", label: "mac" });
    expect(pickOnlineLocalDevice([devices[0], devices[3]], now)).toBeNull();
    expect(pickOnlineLocalDevice([], now)).toBeNull();
  });
  test("a label-less device reports label null", () => {
    expect(pickOnlineLocalDevice([{ device_id: "l", last_seen: online }], now)).toEqual({ device_id: "l", label: null });
  });
  test("via returns that device only when it is online and local — never a fallback", () => {
    expect(pickOnlineLocalDevice(devices, now, "old-mac")).toEqual({ device_id: "old-mac", label: "old mac" });
    expect(pickOnlineLocalDevice(devices, now, "asleep")).toBeNull();
    expect(pickOnlineLocalDevice(devices, now, "box")).toBeNull();
    expect(pickOnlineLocalDevice(devices, now, "nope")).toBeNull();
  });
});

describe("requestBrowserSync / commandOutcome — a cloud session asks its laptop for a login", () => {
  const user = "users_1" as any;
  const other = "users_2" as any;
  const ctx = (db: any, who: any = user) => ({ db, auth: { getUserIdentity: async () => ({ subject: `${who}|session` }) } });
  const fixture = (devices: any[] = []) => makeFakeDb({
    users: [{ _id: user }, { _id: other }],
    devices: [
      { _id: "dev_host", user_id: user, device_id: "box", label: "Cloud Linux", is_remote: true, last_seen: Date.now() },
      { _id: "dev_laptop", user_id: user, device_id: "mac", label: "mac", is_remote: false, last_seen: Date.now() },
      { _id: "dev_other", user_id: other, device_id: "theirs", label: "theirs", is_remote: false, last_seen: Date.now() },
      ...devices,
    ],
    conversations: [
      { _id: "conv_host", user_id: user, owner_device_id: "box" },
      { _id: "conv_laptop", user_id: user, owner_device_id: "mac" },
      { _id: "conv_other", user_id: other, owner_device_id: "box" },
    ],
    daemon_commands: [],
  });
  const ask = (db: any, extra: Record<string, any> = {}, who: any = user) =>
    (requestBrowserSync as any)._handler(ctx(db, who), { device_id: "box", cdp_port: 37121, origin: "https://github.com", ...extra });

  test("inserts exactly one targeted row whose args hold only the host id, port, origin and flag", async () => {
    const db = fixture();
    const r = await ask(db);
    expect(r).toEqual({ command_id: expect.any(String), device_id: "mac", label: "mac" });
    expect(db._inserted.length).toBe(1);
    const row = db._inserted[0];
    expect(row.table).toBe("daemon_commands");
    expect(row.doc.command).toBe("cloud_browser_sync");
    expect(row.doc.target_device_id).toBe("mac");
    expect(row.doc.user_id).toBe(user);
    expect(JSON.parse(row.doc.args)).toEqual({ host_device_id: "box", cdp_port: 37121, origin: "https://github.com", all: false });
  });
  test("conversation_id rides along only when given; the whole-jar form carries origin null", async () => {
    const db = fixture();
    await ask(db, { conversation_id: "conv_host" });
    expect(JSON.parse(db._inserted[0].doc.args)).toEqual({ host_device_id: "box", cdp_port: 37121, origin: "https://github.com", all: false, conversation_id: "conv_host" });
    await ask(db, { origin: undefined, all: true });
    expect(JSON.parse(db._inserted[1].doc.args)).toEqual({ host_device_id: "box", cdp_port: 37121, origin: null, all: true });
  });
  test("refuses a new request while the cap of unanswered ones is waiting for the laptop", async () => {
    const db = fixture();
    for (let i = 0; i < BROWSER_SYNC_PENDING_CAP; i++) expect(await ask(db)).toMatchObject({ device_id: "mac" });
    await expect(ask(db)).rejects.toThrow("already waiting for your laptop");
    // One the laptop answered no longer counts, and neither does an old one.
    await db.patch(db._tables.daemon_commands[0]._id, { executed_at: Date.now() });
    expect(await ask(db)).toMatchObject({ device_id: "mac" });
    await expect(ask(db)).rejects.toThrow("already waiting for your laptop");
    await db.patch(db._tables.daemon_commands[1]._id, { created_at: Date.now() - 10 * 60 * 1000 });
    expect(await ask(db)).toMatchObject({ device_id: "mac" });
  });
  test("refuses a device that is not a cloud host of the caller", async () => {
    const db = fixture();
    await expect(ask(db, { device_id: "mac" })).rejects.toThrow("is not a cloud host of yours");
    await expect(ask(db, { device_id: "box" }, other)).rejects.toThrow("is not a cloud host of yours");
    expect(db._inserted.length).toBe(0);
  });
  test("refuses a bad port, a URL that is not an origin, other schemes, both flags and neither", async () => {
    const db = fixture();
    for (const cdp_port of [0, 70000, 1.5]) await expect(ask(db, { cdp_port })).rejects.toThrow("is not a port");
    await expect(ask(db, { origin: "https://a.com/path?token=x" })).rejects.toThrow("is not an http(s) origin");
    await expect(ask(db, { origin: "ftp://a.com" })).rejects.toThrow("is not an http(s) origin");
    await expect(ask(db, { origin: "javascript:alert(1)" })).rejects.toThrow("is not an http(s) origin");
    await expect(ask(db, { origin: "github.com" })).rejects.toThrow("is not an http(s) origin");
    await expect(ask(db, { all: true })).rejects.toThrow("exactly one of");
    await expect(ask(db, { origin: undefined })).rejects.toThrow("exactly one of");
    expect(db._inserted.length).toBe(0);
  });
  test("a conversation of another user is refused; one not running on that host is dropped from the row, never a refusal", async () => {
    const db = fixture();
    await expect(ask(db, { conversation_id: "conv_other" })).rejects.toThrow("not your conversation");
    expect(db._inserted.length).toBe(0);
    // Attribution only: a moved conversation or an inherited env id must not block the carry.
    await ask(db, { conversation_id: "conv_laptop" });
    expect(db._inserted.length).toBe(1);
    expect(JSON.parse(db._inserted[0].doc.args).conversation_id).toBeUndefined();
  });
  test("no online laptop: throws the retry message and inserts nothing (never parks)", async () => {
    const db = makeFakeDb({
      users: [{ _id: user }],
      devices: [
        { _id: "dev_host", user_id: user, device_id: "box", is_remote: true, last_seen: Date.now() },
        { _id: "dev_laptop", user_id: user, device_id: "mac", is_remote: false, last_seen: Date.now() - DEVICE_ONLINE_MS - 1000 },
      ],
      conversations: [],
      daemon_commands: [],
    });
    await expect(ask(db)).rejects.toThrow("No online laptop can carry your logins");
    expect(db._inserted.length).toBe(0);
  });
  test("via_device_id naming an offline or remote device throws and inserts nothing", async () => {
    const db = fixture([{ _id: "dev_sleepy", user_id: user, device_id: "sleepy", is_remote: false, last_seen: Date.now() - DEVICE_ONLINE_MS - 1000 }]);
    await expect(ask(db, { via_device_id: "sleepy" })).rejects.toThrow("is not one of your online laptops");
    await expect(ask(db, { via_device_id: "box" })).rejects.toThrow("is not one of your online laptops");
    await expect(ask(db, { via_device_id: "theirs" })).rejects.toThrow("is not one of your online laptops");
    expect(db._inserted.length).toBe(0);
    const r = await ask(db, { via_device_id: "mac" });
    expect(r.device_id).toBe("mac");
  });
  test("commandOutcome returns the owner's row, null for another user or another command", async () => {
    const db = fixture();
    const { command_id } = await ask(db);
    const before = await (commandOutcome as any)._handler(ctx(db), { command_id });
    expect(before).toEqual({ executed_at: null, result: null, error: null, claimed_device: null, target_device_id: "mac" });
    await db.patch(command_id, { executed_at: 5, result: '{"ok":true,"injected":3,"host":"github.com"}', claimed_device: "mac" });
    expect(await (commandOutcome as any)._handler(ctx(db), { command_id })).toEqual({
      executed_at: 5, result: '{"ok":true,"injected":3,"host":"github.com"}', error: null, claimed_device: "mac", target_device_id: "mac",
    });
    expect(await (commandOutcome as any)._handler(ctx(db, other), { command_id })).toBeNull();
    const spawnId = await db.insert("daemon_commands", { user_id: user, command: "cloud_spawn", args: "{}", created_at: 1 });
    expect(await (commandOutcome as any)._handler(ctx(db), { command_id: spawnId })).toBeNull();
  });
});
