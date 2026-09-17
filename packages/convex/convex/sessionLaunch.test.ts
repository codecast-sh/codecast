import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { dispatch } from "./dispatch";
import { createSessionFromCli } from "./spawn";
import { getDeviceLocalRoots, listAgentBoxes } from "./devices";
import { reconfigureSession } from "./conversations";
import { canAccessConversation } from "./lib/access";
import { listAgentBoxDevices, sessionLaunchRunner } from "./sessionLaunch";

const ME = "users_creator";
const BOT = "users_bot";
const PERSON = "users_teammate";
const OTHER_BOT = "users_other_bot";
const TEAM = "teams_ours";
const DEVICE = "mini";

function fixture() {
  return makeFakeDb({
    users: [{ _id: ME }, { _id: BOT, is_bot: true, name: "Mr Bot", team_id: TEAM }, { _id: PERSON, team_id: TEAM }, { _id: OTHER_BOT, is_bot: true, team_id: "teams_other" }],
    team_memberships: [{ _id: "member", user_id: ME, team_id: TEAM, role: "member" }],
    devices: [
      { _id: "device_own", user_id: ME, device_id: "laptop", label: "Laptop", platform: "darwin", last_seen: Date.now(), local_project_roots: ["/Users/me/src/app"] },
      { _id: "device_bot", user_id: BOT, device_id: DEVICE, label: "Mac-mini", platform: "darwin", last_seen: Date.now(), local_project_roots: ["/Users/bot/src/app"] },
      { _id: "device_person", user_id: PERSON, device_id: "person", label: "Teammate", platform: "darwin", last_seen: Date.now() },
      { _id: "device_stranger", user_id: OTHER_BOT, device_id: "other-bot", label: "Other bot", platform: "darwin", last_seen: Date.now() },
    ],
    conversations: [],
    daemon_commands: [],
    pending_messages: [],
  });
}

const context = (db: ReturnType<typeof makeFakeDb>, user = ME) => ({ db, auth: { getUserIdentity: async () => ({ subject: `${user}|session` }) } });
const HOST = "cloud-host";
const cloudHostRow = { _id: "device_host", user_id: ME, device_id: HOST, label: "Linux - ip-172-31-40-243", platform: "linux", is_remote: true, last_seen: 0, local_project_roots: ["/home/ubuntu/work/app"] };
const create = (db: ReturnType<typeof makeFakeDb>, opts: Record<string, unknown> = {}) => (dispatch as any)._handler(context(db), {
  action: "createSession", args: [{ session_id: "client-session", agent_type: "codex", project_path: "/Users/bot/src/app", target_device_id: DEVICE, ...opts }],
});

describe("agent box session launch", () => {
  test("the member sees bot boxes and their folders, never a teammate's machine", async () => {
    const db = fixture();
    const boxes = await (listAgentBoxes as any)._handler(context(db), {});
    expect(boxes).toHaveLength(1);
    expect(boxes[0]).toMatchObject({ device_id: DEVICE, bot_name: "Mr Bot", can_edit: false, local_project_roots: ["/Users/bot/src/app"] });
    expect(await getDeviceLocalRoots({ db }, ME as any, DEVICE)).toEqual(["/Users/bot/src/app"]);
    expect(await getDeviceLocalRoots({ db }, PERSON as any, DEVICE)).toBeNull();
  });

  test("creation and first message reach the bot while the human owns the session", async () => {
    const db = fixture();
    const id = await create(db);
    const row = await db.get(id);
    expect(row).toMatchObject({ user_id: BOT, author_user_id: ME, owner_user_id: ME, owner_device_id: DEVICE });
    expect(db._tables.session_owners).toMatchObject([{ conversation_id: id, user_id: ME, added_by: ME }]);
    expect(await canAccessConversation(context(db), ME as any, row)).toBe(true);
    expect(await canAccessConversation(context(db), PERSON as any, row)).toBe(false);
    expect(await canAccessConversation(context(db), ME as any, { ...row, owner_user_id: undefined })).toBe(true);
    expect(db._tables.daemon_commands).toMatchObject([{ user_id: BOT, target_device_id: DEVICE, command: "start_session" }]);
    await (dispatch as any)._handler(context(db), { action: "sendMessage", args: [id, "hello", undefined, "first-message"] });
    expect(db._tables.pending_messages).toMatchObject([{ conversation_id: id, from_user_id: ME, owner_user_id: BOT, content: "hello" }]);
  });

  test("an outbox replay returns the same bot-run session without a second launch", async () => {
    const db = fixture();
    const first = await create(db);
    expect(await create(db)).toBe(first);
    expect(db._tables.conversations).toHaveLength(1);
    expect(db._tables.daemon_commands).toHaveLength(1);
  });

  test("the CLI can select the agent box and seed its first turn", async () => {
    const db = fixture();
    const result = await (createSessionFromCli as any)._handler(context(db), { device: "mac-MINI", agent_type: "codex", project_path: "/Users/bot/src/app", prompt: "hello" });
    expect(await db.get(result.conversation_id)).toMatchObject({ user_id: BOT, owner_user_id: ME, owner_device_id: DEVICE });
    expect(db._tables.pending_messages[0]).toMatchObject({ owner_user_id: BOT, from_user_id: ME });
  });

  test("a blank bot session can finish reconciling its project and model", async () => {
    const db = fixture();
    const id = await create(db);
    await (reconfigureSession as any)._handler(context(db), { conversation_id: id, project_path: "/Users/bot/src/app/subdir", target_device_id: DEVICE });
    const latest = db._tables.daemon_commands.at(-1);
    expect(latest).toMatchObject({ user_id: BOT, target_device_id: DEVICE });
    expect(JSON.parse(latest.args).project_path).toBe("/Users/bot/src/app/subdir");
  });

  test.each(["person", "other-bot", "missing"])("rejects inaccessible target %s before creating a session", async (device) => {
    const db = fixture();
    await expect(create(db, { target_device_id: device })).rejects.toThrow("Unknown device");
    expect(db._tables.conversations).toHaveLength(0);
    expect(db._tables.daemon_commands).toHaveLength(0);
  });

  test("removed membership revokes launch access", async () => {
    const db = fixture();
    db._tables.team_memberships = [];
    expect(await listAgentBoxDevices({ db }, ME as any)).toEqual([]);
    await expect(sessionLaunchRunner({ db }, ME as any, DEVICE)).rejects.toThrow("Unknown device");
  });

  test("own machines keep their original owner and automatic routing", async () => {
    const db = fixture();
    const id = await create(db, { target_device_id: undefined });
    expect(await db.get(id)).toMatchObject({ user_id: ME, owner_device_id: "laptop" });
    expect((await db.get(id)).owner_user_id).toBeUndefined();
  });
});

describe("reconfigureSession — park, un-park and placed-row rules (ct-49427)", () => {
  const CO_OWNER = "users_coowner";
  function cloudFixture(row: Record<string, any> = {}) {
    const db = fixture();
    db._tables.devices.push(cloudHostRow);
    db._tables.users.push({ _id: CO_OWNER });
    db._tables.session_owners = [{ _id: "owner_row", conversation_id: "conv_1", user_id: CO_OWNER, added_by: ME }];
    db._tables.conversations.push({
      _id: "conv_1", user_id: ME, agent_type: "claude_code", session_id: "sess-1", message_count: 0, status: "active",
      project_path: "/Users/me/src/app", git_root: "/Users/me/src/app", owner_device_id: "laptop", ...row,
    });
    return db;
  }
  const reconfigure = (db: any, args: Record<string, unknown>, user = ME) =>
    (reconfigureSession as any)._handler(context(db, user), { conversation_id: "conv_1", ...args });
  const commands = (db: any) => db._tables.daemon_commands.map((c: any) => c.command);
  const spawns = (db: any) => db._tables.daemon_commands.filter((c: any) => c.command === "cloud_spawn");

  test("cloud_device_id parks a blank laptop-owned row: owner=host, pending, token, one cloud_spawn, laptop released", async () => {
    const db = cloudFixture();
    await reconfigure(db, { cloud_device_id: HOST });
    const row = await db.get("conv_1");
    expect(row).toMatchObject({ owner_device_id: HOST, cloud_placement: "pending" });
    expect(typeof row.cloud_placement_token).toBe("string");
    expect(commands(db)).toEqual(["cloud_spawn", "release_session"]);
    expect(JSON.parse(spawns(db)[0].args)).toMatchObject({ conversation_id: "conv_1", cloud_device_id: HOST, placement_token: row.cloud_placement_token });
    expect(spawns(db)[0].target_device_id).toBe("laptop");
  });

  test("a following target_device_id=laptop un-parks: fields cleared, cloud_spawn superseded, start_session enqueued", async () => {
    const db = cloudFixture();
    await reconfigure(db, { cloud_device_id: HOST });
    await reconfigure(db, { target_device_id: "laptop" });
    const row = await db.get("conv_1");
    expect(row.cloud_placement).toBeUndefined();
    expect(row.cloud_placement_token).toBeUndefined();
    expect(row.session_error).toBeUndefined();
    expect(row.owner_device_id).toBe("laptop");
    expect(spawns(db)[0]).toMatchObject({ error: "superseded" });
    expect(spawns(db)[0].executed_at).toBeGreaterThan(0);
    const start = db._tables.daemon_commands.find((c: any) => c.command === "start_session");
    expect(start.target_device_id).toBe("laptop");
  });

  test("a model-only reconfigure on a pending row patches the model and enqueues nothing", async () => {
    const db = cloudFixture();
    await reconfigure(db, { cloud_device_id: HOST });
    const before = db._tables.daemon_commands.length;
    await reconfigure(db, { model: "opus" });
    const row = await db.get("conv_1");
    expect(row.model).toBe("claude-opus");
    expect(row.cloud_placement).toBe("pending");
    expect(db._tables.daemon_commands).toHaveLength(before);
  });

  test("a placed row + cloud_device_id + the same path → plain start at the host, no cloud_spawn", async () => {
    const wt = "/home/ubuntu/work/app/.codecast/worktrees/cloud-1";
    const db = cloudFixture({ owner_device_id: HOST, project_path: wt, git_root: wt, worktree_path: wt, worktree_name: "cloud-1" });
    await reconfigure(db, { cloud_device_id: HOST, project_path: wt, git_root: wt });
    expect(commands(db)).toEqual(["start_session"]);
    expect(db._tables.daemon_commands[0].target_device_id).toBe(HOST);
    expect(JSON.parse(db._tables.daemon_commands[0].args).isolated).toBeUndefined();
    await reconfigure(db, { cloud_device_id: HOST });
    expect(commands(db)).toEqual(["start_session", "start_session"]);
  });

  test("a placed row + a different path is refused", async () => {
    const wt = "/home/ubuntu/work/app/.codecast/worktrees/cloud-1";
    const db = cloudFixture({ owner_device_id: HOST, project_path: wt, git_root: wt, worktree_path: wt });
    await expect(reconfigure(db, { cloud_device_id: HOST, project_path: "/Users/me/src/other" })).rejects.toThrow("already placed on the host");
    expect(db._tables.daemon_commands).toEqual([]);
  });

  test("a co-owner cannot move the session to the cloud; a laptop id is not a cloud host", async () => {
    const db = cloudFixture();
    await expect(reconfigure(db, { cloud_device_id: HOST }, CO_OWNER)).rejects.toThrow("Only the session's runner can move it to the cloud");
    await expect(reconfigure(db, { cloud_device_id: "laptop" })).rejects.toThrow("Not a cloud host you own");
    expect(db._tables.daemon_commands).toEqual([]);
  });

  test("a row with messages still refuses", async () => {
    const db = cloudFixture({ message_count: 2 });
    await expect(reconfigure(db, { cloud_device_id: HOST })).rejects.toThrow("Cannot reconfigure session with messages");
  });

  test("cloud_device_id without a project (a pathless eager row) parks tokenless with no cloud_spawn; the folder pick asks a laptop", async () => {
    const db = cloudFixture({ project_path: undefined, git_root: undefined });
    await reconfigure(db, { cloud_device_id: HOST });
    const parked = await db.get("conv_1");
    expect(parked).toMatchObject({ owner_device_id: HOST, cloud_placement: "pending" });
    expect(parked.cloud_placement_token).toBeUndefined();
    expect(parked.session_error).toBeUndefined();
    // Nothing for `cast cloud start` to fail on; the laptop is still released.
    expect(commands(db)).toEqual(["release_session"]);
    await reconfigure(db, { cloud_device_id: HOST, project_path: "/Users/me/src/app", git_root: "/Users/me/src/app" });
    const row = await db.get("conv_1");
    expect(typeof row.cloud_placement_token).toBe("string");
    expect(spawns(db)).toHaveLength(1);
    expect(JSON.parse(spawns(db)[0].args)).toMatchObject({ conversation_id: "conv_1", placement_token: row.cloud_placement_token });
    expect(spawns(db)[0].target_device_id).toBe("laptop");
  });

  test("target_device_id naming the host on a pending row with a laptop folder stays parked (a live cloud_spawn is left alone)", async () => {
    const db = cloudFixture();
    await reconfigure(db, { cloud_device_id: HOST });
    await reconfigure(db, { target_device_id: HOST, model: "opus" });
    const row = await db.get("conv_1");
    expect(row.cloud_placement).toBe("pending");
    expect(commands(db)).toEqual(["cloud_spawn", "release_session"]);
  });

  test("a pending row pointed at the host for a folder the host holds un-parks TO the host: a plain start there, no dead end", async () => {
    const wt = "/home/ubuntu/work/app/.codecast/worktrees/old-cloud";
    const db = cloudFixture({ project_path: undefined, git_root: undefined });
    await reconfigure(db, { cloud_device_id: HOST, project_path: "/Users/me/src/app", git_root: "/Users/me/src/app" });
    const first = { ...(await db.get("conv_1")) };
    expect(first.cloud_placement).toBe("pending");
    await reconfigure(db, { project_path: wt, git_root: wt, target_device_id: HOST });
    const row = await db.get("conv_1");
    expect(row.cloud_placement).toBeUndefined();
    expect(row.cloud_placement_token).toBeUndefined();
    expect(row.session_error).toBeUndefined();
    expect(row.owner_device_id).toBe(HOST);
    expect(row.project_path).toBe(wt);
    expect(spawns(db)[0]).toMatchObject({ error: "superseded" });
    const start = db._tables.daemon_commands.find((c: any) => c.command === "start_session");
    expect(start.target_device_id).toBe(HOST);
    expect(JSON.parse(start.args)).toMatchObject({ conversation_id: "conv_1", project_path: wt });
    expect(JSON.parse(start.args).isolated).toBeUndefined();
  });

  test("a folder change under a park supersedes the running cloud_spawn and asks again with a fresh token", async () => {
    const db = cloudFixture();
    await reconfigure(db, { cloud_device_id: HOST });
    const first = { ...(await db.get("conv_1")) };
    // Via cloud_device_id (the composer in cloud mode) …
    await reconfigure(db, { cloud_device_id: HOST, project_path: "/Users/me/src/other", git_root: "/Users/me/src/other" });
    const second = { ...(await db.get("conv_1")) };
    expect(second.cloud_placement).toBe("pending");
    expect(second.cloud_placement_token).not.toBe(first.cloud_placement_token);
    expect(spawns(db).map((c: any) => c.error)).toEqual(["superseded", undefined]);
    expect(JSON.parse(spawns(db)[1].args).placement_token).toBe(second.cloud_placement_token);
    // … and via target_device_id naming the host for a laptop folder.
    await reconfigure(db, { target_device_id: HOST, project_path: "/Users/me/src/third", git_root: "/Users/me/src/third" });
    const third = await db.get("conv_1");
    expect(third.cloud_placement).toBe("pending");
    expect(third.cloud_placement_token).not.toBe(second.cloud_placement_token);
    expect(spawns(db).map((c: any) => c.error)).toEqual(["superseded", "superseded", undefined]);
    // The same folder again is the no-op it always was.
    await reconfigure(db, { cloud_device_id: HOST, project_path: "/Users/me/src/third", git_root: "/Users/me/src/third" });
    expect(spawns(db)).toHaveLength(3);
  });

  test("un-parking is the runner's call: a co-owner pointing a pending row at a laptop is refused", async () => {
    const db = cloudFixture();
    await reconfigure(db, { cloud_device_id: HOST });
    await expect(reconfigure(db, { target_device_id: "laptop" }, CO_OWNER)).rejects.toThrow("Only the session's runner can move it off the cloud");
    const row = await db.get("conv_1");
    expect(row).toMatchObject({ owner_device_id: HOST, cloud_placement: "pending" });
    expect(spawns(db)[0].executed_at).toBeUndefined();
    // A model pick from the co-owner still rides the placement.
    await reconfigure(db, { model: "opus" }, CO_OWNER);
    expect((await db.get("conv_1")).model).toBe("claude-opus");
  });
});
