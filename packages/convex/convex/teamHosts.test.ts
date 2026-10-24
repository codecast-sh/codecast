import { describe, expect, test } from "bun:test";
import { DEVICE_BOUND_TOKEN_PREFIX, hashToken, presentToken } from "@platform/auth/convex";
import { claimMember, linkTeamHostBeat, list, performJoinTeamHost, performRemoveTeamHostMember, performRenameTeamHost, register, reportMember } from "./teamHosts";
import { makeFakeDb } from "./testDb";

// The whole life of a team machine on the server: the admin registers the
// box, a teammate joins, the admin daemon claims and carries out the join,
// the new daemon's heartbeat makes them ready, and a removal signs them out.

const TEAM = "teams_union";
const OTHER_TEAM = "teams_other";
const ADMIN = "users_jason";
const MEMBER = "users_ashot";
const STRANGER = "users_stranger";
const BOX_ADMIN_DEVICE = "box-ubuntu";
const BOX_MEMBER_DEVICE = "box-ashot";

async function fixture() {
  const adminSecret = `${DEVICE_BOUND_TOKEN_PREFIX}admin-box-secret`;
  const memberSecret = `${DEVICE_BOUND_TOKEN_PREFIX}member-box-secret`;
  const tables: Record<string, any[]> = {
    users: [
      { _id: ADMIN, name: "Jason", email: "jason@union.ai", github_username: "JasonBenn" },
      { _id: MEMBER, name: "Ashot Petrosian", email: "ashot@almostcandid.com", github_username: "ashot" },
      { _id: STRANGER, name: "Stranger", email: "s@example.com" },
    ],
    teams: [{ _id: TEAM, name: "Union" }, { _id: OTHER_TEAM, name: "Other" }],
    team_memberships: [
      { _id: "tm_1", user_id: ADMIN, team_id: TEAM, role: "member" },
      { _id: "tm_2", user_id: MEMBER, team_id: TEAM, role: "member" },
      { _id: "tm_3", user_id: STRANGER, team_id: OTHER_TEAM, role: "admin" },
    ],
    api_tokens: [
      { _id: "tok_admin", user_id: ADMIN, token_hash: await hashToken(adminSecret), name: "box", created_at: 1, last_used_at: 1, device_id: BOX_ADMIN_DEVICE },
      { _id: "tok_member_box", user_id: MEMBER, token_hash: await hashToken(memberSecret), name: "box", created_at: 1, last_used_at: 1, device_id: BOX_MEMBER_DEVICE },
    ],
    team_hosts: [],
    team_host_members: [],
    daemon_commands: [],
    devices: [],
    machine_resources: [],
  };
  const scheduled: any[] = [];
  let viewer: string | null = MEMBER;
  const ctx: any = {
    db: makeFakeDb(tables),
    auth: { getUserIdentity: async () => (viewer ? { subject: `${viewer}|session` } : null) },
    scheduler: { runAfter: async (...a: any[]) => { scheduled.push(a); } },
  };
  return {
    tables, ctx, scheduled,
    as: (u: string | null) => { viewer = u; },
    adminToken: presentToken(adminSecret, BOX_ADMIN_DEVICE),
    memberBoxToken: presentToken(memberSecret, BOX_MEMBER_DEVICE),
  };
}

async function registered() {
  const f = await fixture();
  f.as(null);
  const r = await (register as any)._handler(f.ctx, {
    api_token: f.adminToken, team_id: TEAM, name: "Union AWS 128GB", device_id: BOX_ADMIN_DEVICE,
    linux_user: "ubuntu", platform: "linux", address: "32.188.57.163",
  });
  f.as(MEMBER);
  return { ...f, hostId: r.host_id, hostKey: r.host_key as string };
}

describe("registering a team machine", () => {
  test("the admin's own user is its first member, and re-registering with the key updates it in place", async () => {
    const f = await registered();
    expect(f.hostKey).toMatch(/^[a-f0-9]{48}$/);
    expect(f.tables.team_host_members).toMatchObject([{ user_id: ADMIN, linux_user: "ubuntu", status: "ready", device_id: BOX_ADMIN_DEVICE }]);
    f.as(null);
    const again = await (register as any)._handler(f.ctx, {
      api_token: f.adminToken, team_id: TEAM, name: "Union box", device_id: BOX_ADMIN_DEVICE,
      linux_user: "ubuntu", platform: "linux", host_key: f.hostKey,
    });
    expect(again.host_id).toBe(f.hostId);
    expect(f.tables.team_hosts).toHaveLength(1);
    expect(f.tables.team_hosts[0].name).toBe("Union box");
  });

  test("a login bound to another machine cannot register this one", async () => {
    const f = await fixture();
    f.as(null);
    await expect((register as any)._handler(f.ctx, {
      api_token: f.adminToken, team_id: TEAM, name: "x", device_id: "laptop", linux_user: "ubuntu", platform: "linux",
    })).rejects.toThrow("another machine");
  });
});

describe("joining", () => {
  test("a join names the Linux user, mints a one-time voucher and queues the admin daemon", async () => {
    const f = await registered();
    const { member_id, linux_user } = await performJoinTeamHost(f.ctx, MEMBER as any, f.hostId);
    expect(linux_user).toBe("ashot");
    const row = f.tables.team_host_members.find((m) => m._id === member_id);
    expect(row).toMatchObject({ status: "joining", step: "queued" });
    expect(typeof row.voucher).toBe("string");
    expect(f.tables.daemon_commands).toMatchObject([{ user_id: ADMIN, command: "team_host_member", target_device_id: BOX_ADMIN_DEVICE }]);
    expect(JSON.parse(f.tables.daemon_commands[0].args)).toEqual({ member_id, action: "add" });
    // The voucher is a setup token: in the token table, never a bearer credential.
    expect(f.tables.api_tokens.some((t) => t.user_id === MEMBER && t.name.startsWith("setup-"))).toBe(true);
  });

  test("someone off the machine's team cannot join", async () => {
    const f = await registered();
    await expect(performJoinTeamHost(f.ctx, STRANGER as any, f.hostId)).rejects.toThrow("not on this machine's team");
  });

  test("a taken Linux user gets a number, and a requested one that is taken is refused", async () => {
    const f = await registered();
    f.tables.users.push({ _id: "users_ash2", name: "Ash Other", email: "ashot@other.com", github_username: "ashot" });
    f.tables.team_memberships.push({ _id: "tm_4", user_id: "users_ash2", team_id: TEAM, role: "member" });
    await performJoinTeamHost(f.ctx, MEMBER as any, f.hostId);
    expect((await performJoinTeamHost(f.ctx, "users_ash2" as any, f.hostId)).linux_user).toBe("ashot2");
    f.tables.users.push({ _id: "users_3", name: "Three", email: "3@x.com" });
    f.tables.team_memberships.push({ _id: "tm_5", user_id: "users_3", team_id: TEAM, role: "member" });
    await expect(performJoinTeamHost(f.ctx, "users_3" as any, f.hostId, { linux_user: "ubuntu" })).rejects.toThrow("taken");
  });

  test("only the admin daemon claims, and the voucher comes out exactly once", async () => {
    const f = await registered();
    const { member_id } = await performJoinTeamHost(f.ctx, MEMBER as any, f.hostId);
    f.as(null);
    await expect((claimMember as any)._handler(f.ctx, { api_token: f.memberBoxToken, member_id })).rejects.toThrow("admin daemon");
    const first = await (claimMember as any)._handler(f.ctx, { api_token: f.adminToken, member_id });
    expect(first).toMatchObject({ action: "add", linux_user: "ashot", github: "ashot", user_id: MEMBER });
    expect(first.voucher).toBeTruthy();
    expect(await (claimMember as any)._handler(f.ctx, { api_token: f.adminToken, member_id })).toEqual({ action: "claimed" });
    expect(f.tables.team_host_members.find((m) => m._id === member_id).voucher).toBeUndefined();
  });

  test("steps and a failure land on the row; a re-join keeps the Linux user and queues again", async () => {
    const f = await registered();
    const { member_id } = await performJoinTeamHost(f.ctx, MEMBER as any, f.hostId);
    f.as(null);
    await (claimMember as any)._handler(f.ctx, { api_token: f.adminToken, member_id });
    await (reportMember as any)._handler(f.ctx, { api_token: f.adminToken, member_id, step: "tools" });
    expect(f.tables.team_host_members.find((m) => m._id === member_id).step).toBe("tools");
    await (reportMember as any)._handler(f.ctx, { api_token: f.adminToken, member_id, error: "bun install failed" });
    expect(f.tables.team_host_members.find((m) => m._id === member_id)).toMatchObject({ status: "failed", error: "bun install failed" });
    const again = await performJoinTeamHost(f.ctx, MEMBER as any, f.hostId);
    expect(again).toEqual({ member_id, linux_user: "ashot" });
    expect(f.tables.daemon_commands).toHaveLength(2);
  });
});

describe("the heartbeat link", () => {
  test("the member's new daemon makes them ready and names the device after the machine", async () => {
    const f = await registered();
    const { member_id } = await performJoinTeamHost(f.ctx, MEMBER as any, f.hostId);
    const linked = await linkTeamHostBeat(f.ctx, MEMBER as any, BOX_MEMBER_DEVICE, { key: f.hostKey, linux_user: "ashot" });
    expect(linked).toEqual({ name: "Union AWS 128GB" });
    expect(f.tables.team_host_members.find((m) => m._id === member_id)).toMatchObject({ status: "ready", device_id: BOX_MEMBER_DEVICE, voucher: undefined });
    const writes = f.ctx.db._patched.length;
    await linkTeamHostBeat(f.ctx, MEMBER as any, BOX_MEMBER_DEVICE, { key: f.hostKey, linux_user: "ashot" });
    expect(f.ctx.db._patched.length).toBe(writes);
  });

  test("a daemon set up by hand on the box becomes a member on its first beat", async () => {
    const f = await registered();
    await linkTeamHostBeat(f.ctx, MEMBER as any, BOX_MEMBER_DEVICE, { key: f.hostKey, linux_user: "ashot" });
    expect(f.tables.team_host_members.find((m) => m.user_id === MEMBER)).toMatchObject({ status: "ready", linux_user: "ashot" });
  });

  test("a stranger's daemon, or a Linux user someone else holds, links nothing", async () => {
    const f = await registered();
    expect(await linkTeamHostBeat(f.ctx, STRANGER as any, "x", { key: f.hostKey, linux_user: "stranger" })).toBeNull();
    expect(await linkTeamHostBeat(f.ctx, MEMBER as any, "y", { key: f.hostKey, linux_user: "ubuntu" })).toBeNull();
    expect(f.tables.team_host_members).toHaveLength(1);
  });
});

describe("removing", () => {
  test("a member leaves: the admin daemon is told, and its report signs the device out for good", async () => {
    const f = await registered();
    const { member_id } = await performJoinTeamHost(f.ctx, MEMBER as any, f.hostId);
    await linkTeamHostBeat(f.ctx, MEMBER as any, BOX_MEMBER_DEVICE, { key: f.hostKey, linux_user: "ashot" });
    f.tables.devices.push({ _id: "devices_box_ashot", user_id: MEMBER, device_id: BOX_MEMBER_DEVICE, label: "Union AWS 128GB", platform: "linux", last_seen: Date.now() });
    await performRemoveTeamHostMember(f.ctx, MEMBER as any, member_id);
    expect(f.tables.team_host_members.find((m) => m._id === member_id).status).toBe("removing");
    f.as(null);
    expect(await (claimMember as any)._handler(f.ctx, { api_token: f.adminToken, member_id })).toMatchObject({ action: "remove", linux_user: "ashot" });
    await (reportMember as any)._handler(f.ctx, { api_token: f.adminToken, member_id, removed: true });
    expect(f.tables.team_host_members.find((m) => m._id === member_id)).toBeUndefined();
    expect(f.tables.api_tokens.find((t) => t._id === "tok_member_box")).toBeUndefined();
    expect(f.tables.devices).toHaveLength(0);
  });

  test("a teammate cannot remove someone else, the admin can, and the admin's own user cannot leave", async () => {
    const f = await registered();
    const { member_id } = await performJoinTeamHost(f.ctx, MEMBER as any, f.hostId);
    f.tables.users.push({ _id: "users_cam", name: "Cam", email: "cam@union.ai" });
    f.tables.team_memberships.push({ _id: "tm_6", user_id: "users_cam", team_id: TEAM, role: "member" });
    await expect(performRemoveTeamHostMember(f.ctx, "users_cam" as any, member_id)).rejects.toThrow("Only the machine's admin");
    // Queued and never claimed: nothing on the box to undo, so the row just goes.
    expect(await performRemoveTeamHostMember(f.ctx, ADMIN as any, member_id)).toEqual({ removed: true });
    expect(f.tables.team_host_members.find((m) => m._id === member_id)).toBeUndefined();
    const adminRow = f.tables.team_host_members.find((m) => m.user_id === ADMIN);
    await expect(performRemoveTeamHostMember(f.ctx, ADMIN as any, adminRow._id)).rejects.toThrow("remove the machine instead");
    await expect(performRenameTeamHost(f.ctx, MEMBER as any, f.hostId, "mine")).rejects.toThrow("Only the machine's admin");
  });
});

describe("reading", () => {
  test("teammates see the machine with its members; another team sees nothing", async () => {
    const f = await registered();
    await performJoinTeamHost(f.ctx, MEMBER as any, f.hostId);
    const rows = await (list as any)._handler(f.ctx, {});
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: "Union AWS 128GB", team_name: "Union", can_manage: false, admin_name: "Jason" });
    expect(rows[0].members.map((m: any) => [m.linux_user, m.status])).toEqual([["ubuntu", "ready"], ["ashot", "joining"]]);
    expect(JSON.stringify(rows)).not.toContain("voucher");
    f.as(STRANGER);
    expect(await (list as any)._handler(f.ctx, {})).toEqual([]);
  });
});
