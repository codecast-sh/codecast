import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import {
  createTeam,
  deleteTeam,
  getTeamByInviteCode,
  joinTeam,
  removeMember,
  restoreTeam,
} from "./teams";

const ALICE = "user-alice" as any;
const BOB = "user-bob" as any;
const BOT = "user-bot" as any;
const DOOMED = "team-doomed" as any;
const OLDER = "team-older" as any;
const NEWER = "team-newer" as any;

function seed() {
  const db = makeFakeDb({
    users: [
      { _id: ALICE, name: "Alice", email: "a@example.test", team_id: DOOMED, role: "admin", active_team_id: DOOMED },
      { _id: BOB, name: "Bob", email: "b@example.test", team_id: DOOMED, role: "member", active_team_id: DOOMED },
      { _id: BOT, name: "Anchor", email: "bot@example.test" },
    ],
    teams: [
      { _id: DOOMED, name: "Doomed Team", invite_code: "DOOM", created_at: 3, client_key: "team-stub-doomed" },
      { _id: OLDER, name: "Older", invite_code: "OLD", created_at: 1 },
      { _id: NEWER, name: "Newer", invite_code: "NEW", created_at: 2 },
    ],
    team_memberships: [
      { _id: "m-a-doomed", user_id: ALICE, team_id: DOOMED, role: "admin", joined_at: 30, visibility: "full" },
      { _id: "m-b-doomed", user_id: BOB, team_id: DOOMED, role: "member", joined_at: 31 },
      { _id: "m-bot-doomed", user_id: BOT, team_id: DOOMED, role: "member", joined_at: 32 },
      // Alice's other teams, listed newest first on purpose: the fallback must
      // pick the OLDEST membership, not the first row the index returns.
      { _id: "m-a-newer", user_id: ALICE, team_id: NEWER, role: "member", joined_at: 20 },
      { _id: "m-a-older", user_id: ALICE, team_id: OLDER, role: "admin", joined_at: 10 },
    ],
    directory_team_mappings: [
      { _id: "dm-a", user_id: ALICE, team_id: DOOMED, directory_path: "/a" },
      { _id: "dm-b", user_id: BOB, team_id: DOOMED, directory_path: "/b" },
      // A stray mapping from a user who is no longer a member.
      { _id: "dm-stray", user_id: "user-gone", team_id: DOOMED, directory_path: "/gone" },
      { _id: "dm-a-older", user_id: ALICE, team_id: OLDER, directory_path: "/older" },
    ],
    anchors: [
      { _id: "anchor-1", team_id: DOOMED, bot_user_id: BOT, status: "active", updated_at: 1 },
    ],
    anchor_channels: [{ _id: "ac-1", anchor_id: "anchor-1", channel_id: "ch-1" }],
    chat_reads: [{ _id: "read-a", user_id: ALICE, team_id: DOOMED, channel_id: "ch-1" }],
    chat_channels: [], chat_channel_members: [], entity_subscriptions: [], notifications: [],
    push_outbox: [], thread_reads: [], pending_messages: [], daemon_commands: [],
  });
  return db;
}

function ctxFor(db: any, user: string | null) {
  return {
    db,
    auth: { async getUserIdentity() { return user ? { subject: `${user}|session` } : null; } },
    scheduler: { async runAfter() { return undefined; } },
  } as any;
}

const rowsOf = (db: any, table: string) => db._tables?.[table] ?? db.tables?.[table] ?? [];
const del = (db: any, user: string | null, args: any) => (deleteTeam as any)._handler(ctxFor(db, user), args);

describe("teams.deleteTeam", () => {
  test("a member who is not an admin is refused", async () => {
    const db = seed();
    await expect(del(db, "user-bob", { team_id: DOOMED, confirm_name: "Doomed Team" }))
      .rejects.toThrow(/Only admins/);
    expect(await db.get(DOOMED)).not.toHaveProperty("deleted_at");
  });

  test("the typed name must match the team name", async () => {
    const db = seed();
    await expect(del(db, "user-alice", { team_id: DOOMED, confirm_name: "Doomed" }))
      .rejects.toThrow(/Type the team name/);
    expect(await db.get(DOOMED)).not.toHaveProperty("deleted_at");
  });

  test("an admin with the exact name retires the team and everything on it", async () => {
    const db = seed();
    const result = await del(db, "user-alice", { team_id: DOOMED, confirm_name: " Doomed Team " });

    const team = await db.get(DOOMED);
    expect(team.deleted_at).toBeGreaterThan(0);
    expect(team.deleted_by).toBe(ALICE);
    expect(team.deleted_members.map((m: any) => m.user_id).sort()).toEqual([ALICE, BOB, BOT].sort());
    expect(team.invite_code_expires_at).toBeLessThanOrEqual(Date.now());

    // No membership rows survive for the team; other teams are untouched.
    const memberships = await db.query("team_memberships").withIndex("by_team_id", (q: any) => q.eq("team_id", DOOMED)).collect();
    expect(memberships).toEqual([]);
    expect(await db.get("m-a-older")).toBeTruthy();
    expect(await db.get("m-a-newer")).toBeTruthy();

    // Every mapping to the team is gone, including the stray one; others stay.
    const mappings = await db.query("directory_team_mappings").withIndex("by_team_id", (q: any) => q.eq("team_id", DOOMED)).collect();
    expect(mappings).toEqual([]);
    expect(await db.get("dm-a-older")).toBeTruthy();

    // Alice lands on her OLDEST other team; Bob had nowhere to go.
    const alice = await db.get(ALICE);
    expect(alice.active_team_id).toBe(OLDER);
    expect(alice.team_id).toBe(OLDER);
    expect(alice.role).toBe("admin");
    const bob = await db.get(BOB);
    expect(bob.active_team_id).toBeUndefined();
    expect(bob.team_id).toBeUndefined();
    expect(bob.role).toBeUndefined();

    // Chat state for the team is purged, the anchor is retired.
    expect(await db.get("read-a")).toBeNull();
    expect((await db.get("anchor-1")).status).toBe("decommissioned");
    expect(await db.get("ac-1")).toBeNull();

    expect(result).toMatchObject({ deleted: true, name: "Doomed Team", active_team_id: OLDER, members: 3, anchors: 1 });
  });

  test("a deleted team cannot be deleted twice or joined by invite", async () => {
    const db = seed();
    await del(db, "user-alice", { team_id: DOOMED, confirm_name: "Doomed Team" });
    await expect(del(db, "user-alice", { team_id: DOOMED, confirm_name: "Doomed Team" }))
      .rejects.toThrow(/Team not found/);
    await expect((joinTeam as any)._handler(ctxFor(db, "user-bob"), { invite_code: "DOOM" }))
      .rejects.toThrow(/Invalid invite code/);
    expect(await (getTeamByInviteCode as any)._handler(ctxFor(db, "user-bob"), { invite_code: "DOOM" })).toBeNull();
  });

  test("a replayed create carrying the tombstone's client_key does not bring the team back", async () => {
    const db = seed();
    await del(db, "user-alice", { team_id: DOOMED, confirm_name: "Doomed Team" });
    const before = rowsOf(db, "teams").length;
    await expect((createTeam as any)._handler(ctxFor(db, "user-alice"), {
      name: "Doomed Team",
      client_key: "team-stub-doomed",
    })).rejects.toThrow(/was deleted/);
    expect(db._inserted.filter((i: any) => i.table === "teams")).toEqual([]);
    expect(rowsOf(db, "teams").length).toBe(before);
  });

  test("restoreTeam clears the tombstone and re-seats the recorded roster", async () => {
    const db = seed();
    await del(db, "user-alice", { team_id: DOOMED, confirm_name: "Doomed Team" });
    const result = await (restoreTeam as any)._handler(ctxFor(db, null), { team_id: DOOMED });
    expect(result).toEqual({ restored: true, members: 3 });
    const team = await db.get(DOOMED);
    expect(team.deleted_at).toBeUndefined();
    expect(team.deleted_members).toBeUndefined();
    const memberships = await db.query("team_memberships").withIndex("by_team_id", (q: any) => q.eq("team_id", DOOMED)).collect();
    expect(memberships.map((m: any) => [m.user_id, m.role, m.joined_at]).sort()).toEqual([
      [ALICE, "admin", 30], [BOB, "member", 31], [BOT, "member", 32],
    ].sort());
    // Idempotent: a second restore is a no-op.
    expect(await (restoreTeam as any)._handler(ctxFor(db, null), { team_id: DOOMED })).toEqual({ restored: false, members: 0 });
  });
});

describe("teams.removeMember (shared membership end)", () => {
  test("removing a member drops their directory mappings to the team and repoints them", async () => {
    const db = seed();
    await (removeMember as any)._handler(ctxFor(db, "user-alice"), { member_user_id: BOB, team_id: DOOMED });
    expect(await db.get("m-b-doomed")).toBeNull();
    expect(await db.get("dm-b")).toBeNull();
    expect(await db.get("dm-a")).toBeTruthy();
    const bob = await db.get(BOB);
    expect(bob.team_id).toBeUndefined();
    expect(bob.active_team_id).toBeUndefined();
  });
});
