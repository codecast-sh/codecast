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
