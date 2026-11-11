import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { joinTeam, regenerateInviteCode, removeMember } from "./teams";

// F36: a member an admin removed cannot walk back in on the link they still
// hold, while the same link keeps working for everyone else, and an admin's
// new invite or new code lets them back.
const ADMIN = "user-admin" as any;
const BOB = "user-bob" as any;
const CAROL = "user-carol" as any;
const TEAM = "team-1" as any;
const WEEK = 7 * 24 * 60 * 60 * 1000;

function seed() {
  return makeFakeDb({
    users: [
      { _id: ADMIN, name: "Admin", email: "admin@example.test", team_id: TEAM, role: "admin" },
      { _id: BOB, name: "Bob", email: "Bob@example.test", team_id: TEAM, role: "member" },
      { _id: CAROL, name: "Carol", email: "carol@example.test" },
    ],
    teams: [{ _id: TEAM, name: "Team", invite_code: "CODE", invite_code_expires_at: Date.now() - 60_000 + WEEK, created_at: 1 }],
    team_memberships: [
      { _id: "m-admin", user_id: ADMIN, team_id: TEAM, role: "admin", joined_at: 1 },
      { _id: "m-bob", user_id: BOB, team_id: TEAM, role: "member", joined_at: 2 },
    ],
    team_invites: [], team_join_requests: [], directory_team_mappings: [], chat_reads: [],
    chat_channels: [], chat_channel_members: [], entity_subscriptions: [], notifications: [],
    push_outbox: [], thread_reads: [], pending_messages: [], daemon_commands: [], session_owners: [],
  });
}

function ctxFor(db: any, user: string) {
  return {
    db,
    auth: { async getUserIdentity() { return { subject: `${user}|session` }; } },
    scheduler: { async runAfter() { return undefined; } },
  } as any;
}

const member = async (db: any, user: string) =>
  (db._tables.team_memberships as any[]).some((m) => m.user_id === user && m.team_id === TEAM);

describe("rejoining after an admin removal", () => {
  test("the removed member is refused on the old code; a newcomer is not", async () => {
    const db = seed();
    await (removeMember as any)._handler(ctxFor(db, ADMIN), { member_user_id: BOB, team_id: TEAM });
    await expect((joinTeam as any)._handler(ctxFor(db, BOB), { invite_code: "CODE" })).rejects.toThrow(/expired/);
    expect(await member(db, BOB)).toBe(false);
    await (joinTeam as any)._handler(ctxFor(db, CAROL), { invite_code: "CODE" });
    expect(await member(db, CAROL)).toBe(true);
    // The removal record holds no seat as a pending invite.
    expect((db._tables.team_invites as any[]).every((i) => i.accepted_at)).toBe(true);
  });

  test("an admin's new code lets them back", async () => {
    const db = seed();
    await (removeMember as any)._handler(ctxFor(db, ADMIN), { member_user_id: BOB, team_id: TEAM });
    await new Promise((r) => setTimeout(r, 2));
    const code = await (regenerateInviteCode as any)._handler(ctxFor(db, ADMIN), { team_id: TEAM });
    await (joinTeam as any)._handler(ctxFor(db, BOB), { invite_code: code });
    expect(await member(db, BOB)).toBe(true);
  });

  test("a fresh invite email on the same code lets them back", async () => {
    const db = seed();
    await (removeMember as any)._handler(ctxFor(db, ADMIN), { member_user_id: BOB, team_id: TEAM });
    const row = (db._tables.team_invites as any[])[0];
    // what sendInvite writes for a re-invite
    await db.patch(row._id, { invite_code: "CODE", invited_by: ADMIN, created_at: Date.now() + 1, accepted_at: undefined });
    await (joinTeam as any)._handler(ctxFor(db, BOB), { invite_code: "CODE" });
    expect(await member(db, BOB)).toBe(true);
  });

  test("someone who left on their own may rejoin", async () => {
    const db = seed();
    db._tables.team_memberships.find((m: any) => m._id === "m-bob").role = "admin";
    await (removeMember as any)._handler(ctxFor(db, BOB), { member_user_id: BOB, team_id: TEAM });
    await (joinTeam as any)._handler(ctxFor(db, BOB), { invite_code: "CODE" });
    expect(await member(db, BOB)).toBe(true);
  });
});
