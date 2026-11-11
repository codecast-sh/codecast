import { describe, expect, test } from "bun:test";
import { dispatch } from "./dispatch";
import { makeFakeDb } from "./testDb";

// A session launched from the device dropdown onto a cloud host: parked for
// the laptop to place it, or started natively where the host already holds
// the folder (ct-49427).
describe("createSession — dropdown-targeted cloud host launches (ct-49427)", () => {
  const ME = "users_me";
  const BOT = "users_bot";
  const TEAM = "teams_ours";
  const HOST = "cloud-host";
  const ctx = (db: any) => ({ auth: { getUserIdentity: async () => ({ subject: `${ME}|session` }) }, db });
  function cloudDb(opts: { laptopOnline?: boolean } = {}) {
    return makeFakeDb({
      rate_limits: [], directory_team_mappings: [], conversations: [], daemon_commands: [], change_log: [], local_view_heads: [],
      docs: [], plans: [], tasks: [], session_owners: [], pending_messages: [],
      users: [{ _id: ME }, { _id: BOT, is_bot: true, name: "Mr Bot", team_id: TEAM }],
      team_memberships: [{ _id: "member", user_id: ME, team_id: TEAM, role: "member" }],
      devices: [
        { _id: "dev_host", user_id: ME, device_id: HOST, label: "Linux - ip-172-31-40-243", platform: "linux", is_remote: true, last_seen: 0, local_project_roots: ["/home/ubuntu/work/app"], cloud_host: { managed_by: "laptop", state: "stopped", at: 0 } },
        { _id: "dev_laptop", user_id: ME, device_id: "laptop", label: "macOS - MacBook", platform: "darwin", is_remote: false, last_seen: opts.laptopOnline === false ? 0 : Date.now(), local_project_roots: ["/Users/me/src/app"] },
        { _id: "dev_box", user_id: BOT, device_id: "bot-box", label: "Linux - ip-10-0-0-1", platform: "linux", is_remote: true, last_seen: Date.now(), local_project_roots: ["/home/bot/work/app"] },
      ],
    });
  }
  const create = (db: any, args: Record<string, unknown>) => (dispatch as any)._handler(ctx(db), {
    action: "createSession", args: [{ session_id: "client-session", agent_type: "claude_code", project_path: "/Users/me/src/app", git_root: "/Users/me/src/app", ...args }],
  });
  const commands = (db: any) => db._tables.daemon_commands.map((c: any) => c.command);

  test("the mobile shape (target_device_id = own host, no cloud_device_id, a /Users path) parks; isolated is dropped", async () => {
    const db = cloudDb();
    const id = await create(db, { target_device_id: HOST, isolated: true });
    const row = await db.get(id);
    expect(row).toMatchObject({ owner_device_id: HOST, cloud_placement: "pending" });
    expect(typeof row.cloud_placement_token).toBe("string");
    expect(commands(db)).toEqual(["cloud_spawn"]);
    expect(JSON.parse(db._tables.daemon_commands[0].args)).toMatchObject({ conversation_id: id, cloud_device_id: HOST, placement_token: row.cloud_placement_token });
    expect(db._tables.daemon_commands[0].target_device_id).toBe("laptop");
  });

  test("a team agent box target keeps a plain start_session (never parked)", async () => {
    const db = cloudDb();
    const id = await create(db, { target_device_id: "bot-box", project_path: "/home/bot/work/app", git_root: "/home/bot/work/app" });
    expect(await db.get(id)).toMatchObject({ user_id: BOT, owner_device_id: "bot-box" });
    expect((await db.get(id)).cloud_placement).toBeUndefined();
    expect(commands(db)).toEqual(["start_session"]);
  });

  test("cloud_device_id naming an agent box is refused before any row exists", async () => {
    const db = cloudDb();
    await expect(create(db, { target_device_id: "bot-box", cloud_device_id: "bot-box" })).rejects.toThrow("Not a cloud host you own");
    expect(db._tables.conversations).toEqual([]);
  });

  test("a folder the host already holds starts natively there", async () => {
    const db = cloudDb();
    const wt = "/home/ubuntu/work/app/.codecast/worktrees/x";
    const id = await create(db, { target_device_id: HOST, project_path: wt, git_root: wt });
    expect((await db.get(id)).cloud_placement).toBeUndefined();
    expect(commands(db)).toEqual(["start_session"]);
    expect(db._tables.daemon_commands[0].target_device_id).toBe(HOST);
  });

  test("cloud_device_id with no online laptop parks, targets the most-recent laptop, and says it is waiting", async () => {
    const db = cloudDb({ laptopOnline: false });
    const id = await create(db, { target_device_id: HOST, cloud_device_id: HOST });
    const row = await db.get(id);
    expect(row).toMatchObject({ owner_device_id: HOST, cloud_placement: "pending" });
    expect(row.session_error).toContain("Waiting for MacBook to come online");
    expect(commands(db)).toEqual(["cloud_spawn"]);
    expect(db._tables.daemon_commands[0].target_device_id).toBe("laptop");
  });
});
