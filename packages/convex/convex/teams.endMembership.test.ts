import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { sweepStaleSessionOwners } from "./teams";
import { endMembership } from "./lib/teamMembershipEnd";

// F26: an owner row on a session another account runs steers that account's
// daemon. Leaving the team drops the rows no remaining shared team explains.
const ANA = "u".repeat(31) + "a";
const BEN = "u".repeat(31) + "b";
const BOT = "u".repeat(31) + "x";
const SOLO = "u".repeat(31) + "s";
const TEAM = "t".repeat(31) + "1";
const OTHER = "t".repeat(31) + "2";

function fixtures(extraMemberships: any[] = []) {
  return makeFakeDb({
    users: [
      { _id: ANA, name: "Ana", team_id: TEAM },
      { _id: BEN, name: "Ben", team_id: TEAM },
      { _id: BOT, name: "Box", is_bot: true, team_id: TEAM },
      { _id: SOLO, name: "Personal box", is_bot: true },
    ],
    team_memberships: [
      { _id: "m1", user_id: ANA, team_id: TEAM, role: "member" },
      { _id: "m2", user_id: BEN, team_id: TEAM, role: "admin" },
      ...extraMemberships,
    ],
    conversations: [
      { _id: "c-ben", user_id: BEN, owner_user_id: ANA, team_id: TEAM },
      { _id: "c-box", user_id: BOT, owner_user_id: ANA, team_id: TEAM },
      { _id: "c-solo", user_id: SOLO, owner_user_id: ANA },
      { _id: "c-own", user_id: ANA, team_id: TEAM },
    ],
    session_owners: [
      { _id: "o1", conversation_id: "c-ben", user_id: ANA, added_by: ANA, added_at: 1 },
      { _id: "o2", conversation_id: "c-box", user_id: ANA, added_by: ANA, added_at: 1 },
      { _id: "o3", conversation_id: "c-solo", user_id: ANA, added_by: ANA, added_at: 1 },
      { _id: "o4", conversation_id: "c-box", user_id: BEN, added_by: BEN, added_at: 2 },
    ],
  });
}

const owners = (db: any) => db._tables.session_owners.map((r: any) => r._id).sort();
const conv = (db: any, id: string) => db._tables.conversations.find((c: any) => c._id === id);

describe("endMembership releases owner rows on sessions others run", () => {
  test("a removed member loses ownership of a teammate's and the team box's sessions", async () => {
    const db = fixtures();
    await endMembership({ db } as any, ANA as any, TEAM as any, BEN as any);
    expect(owners(db)).toEqual(["o3", "o4"]);
    expect(conv(db, "c-ben").owner_user_id).toBeUndefined();
    expect(conv(db, "c-box").owner_user_id).toBe(BEN);
    expect(conv(db, "c-solo").owner_user_id).toBe(ANA);
  });

  // Sharing some other team with the runner is not the grant: it would not
  // let her start a session on that machine either (isTeamMachineFor needs a
  // device_shares row for a team both are in).
  test("a second shared team does not keep ownership the left team granted", async () => {
    const db = fixtures([
      { _id: "m3", user_id: ANA, team_id: OTHER, role: "member" },
      { _id: "m4", user_id: BEN, team_id: OTHER, role: "member" },
    ]);
    await endMembership({ db } as any, ANA as any, TEAM as any, BEN as any);
    expect(owners(db)).toEqual(["o3", "o4"]);
  });

  test("a grant the remaining team itself makes stays: the machine is shared with it too", async () => {
    const db = fixtures([
      { _id: "m3", user_id: ANA, team_id: OTHER, role: "member" },
      { _id: "m4", user_id: BEN, team_id: OTHER, role: "member" },
    ]);
    conv(db, "c-ben").owner_device_id = "ben-mini";
    db._tables.devices = [{ _id: "d1", user_id: BEN, device_id: "ben-mini", last_seen: 1 }];
    db._tables.device_shares = [
      { _id: "s1", user_id: BEN, device_id: "ben-mini", team_id: TEAM },
      { _id: "s2", user_id: BEN, device_id: "ben-mini", team_id: OTHER },
    ];
    await endMembership({ db } as any, ANA as any, TEAM as any, BEN as any);
    expect(owners(db)).toEqual(["o1", "o3", "o4"]);
    expect(conv(db, "c-ben").owner_user_id).toBe(ANA);
  });

  test("leaving an unrelated team touches nothing", async () => {
    const db = fixtures([{ _id: "m3", user_id: ANA, team_id: OTHER, role: "member" }]);
    await endMembership({ db } as any, ANA as any, OTHER as any, ANA as any);
    expect(owners(db)).toEqual(["o1", "o2", "o3", "o4"]);
  });
});

describe("sweepStaleSessionOwners (one-off, after deploy)", () => {
  const run = (db: any, args: any = {}) => {
    const scheduled: any[] = [];
    const ctx = { db, scheduler: { async runAfter(_d: number, _f: unknown, a: any) { scheduled.push(a); } } };
    return (sweepStaleSessionOwners as any)._handler(ctx, args).then((r: any) => ({ ...r, scheduled }));
  };

  test("drops rows a past removal stranded and keeps the ones still granted", async () => {
    const db = fixtures();
    // Ana was removed before the release existed: her membership is gone, her rows are not.
    db._tables.team_memberships = db._tables.team_memberships.filter((m: any) => m.user_id !== ANA);
    const dry = await run(db, { dryRun: true });
    expect(dry.dropped).toBe(2);
    expect(owners(db)).toEqual(["o1", "o2", "o3", "o4"]);
    const res = await run(db);
    expect(res.dropped).toBe(2);
    expect(res.done).toBe(true);
    expect(owners(db)).toEqual(["o3", "o4"]);
    expect(conv(db, "c-box").owner_user_id).toBe(BEN);
  });

  test("current members' rows are untouched", async () => {
    const db = fixtures();
    expect((await run(db)).dropped).toBe(0);
    expect(owners(db)).toEqual(["o1", "o2", "o3", "o4"]);
  });
});
