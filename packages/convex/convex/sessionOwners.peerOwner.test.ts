import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { computeInboxSessions } from "./conversations";
import { inboxEpoch } from "@codecast/shared/contracts";
import { makeFakeDb } from "./testDb";
import { ownPeerByItsSpawnersHuman } from "./sessionOwners";
import { backfillPeerOwnersPage } from "./ownerMigrations";

// A peer (a session another one only spawned) has no parent to own it. Under
// the owners model, one a bot-run session spawned takes its spawner's owners:
// its people, else its role, so it lands somewhere rather than nowhere.
const ME = "users_me";
const BOT = "users_bot";
const TEAM = "teams_t";
const EPOCH = inboxEpoch(1_800_000_000_000);

let nowSpy: ReturnType<typeof spyOn>;
beforeEach(() => { nowSpy = spyOn(Date, "now").mockReturnValue(EPOCH + 5_000); });
afterEach(() => nowSpy.mockRestore());

function world(flag: boolean) {
  const live = { status: "active", team_id: TEAM, message_count: 6, last_message_role: "assistant", updated_at: EPOCH - 3_600_000, started_at: EPOCH - 7_200_000 };
  return makeFakeDb({
    teams: [{ _id: TEAM, name: "Union", features: flag ? { session_owners: true } : {} }, { _id: "teams_other", name: "Other", features: flag ? { session_owners: true } : {} }],
    users: [{ _id: ME, name: "Me", email: "me@example.com" }, { _id: BOT, name: "Box", is_bot: true }],
    conversations: [
      // My session, running on the team's agent box.
      { _id: "conversations_spawner", user_id: BOT, author_user_id: ME, title: "spawner", ...live },
      // A plain spawn from it, on the same box: no human of its own.
      { _id: "conversations_peer", user_id: BOT, spawned_by_conversation_id: "conversations_spawner", title: "peer", ...live },
      // A plain spawn I started on my own account already has me.
      { _id: "conversations_mine", user_id: ME, spawned_by_conversation_id: "conversations_spawner", title: "mine", ...live },
      // A role's standing session on the box: the role alone owns it.
      { _id: "conversations_role_lead", user_id: BOT, standing_role_id: "org_roles_r", org_role_id: "org_roles_r", title: "lead", ...live },
      { _id: "conversations_teammate", user_id: BOT, spawned_by_conversation_id: "conversations_role_lead", title: "teammate", ...live },
      // A box session a person took over: they own it by row, it has no author.
      { _id: "conversations_taken", user_id: BOT, title: "taken", ...live },
      { _id: "conversations_taken_peer", user_id: BOT, spawned_by_conversation_id: "conversations_taken", title: "taken peer", ...live },
      // A box worker nested under my box session, spawning a peer of its own.
      { _id: "conversations_worker", user_id: BOT, parent_conversation_id: "conversations_spawner", title: "worker", ...live },
      { _id: "conversations_worker_peer", user_id: BOT, spawned_by_conversation_id: "conversations_worker", title: "worker peer", ...live },
      // The role lead's teammate in another team gets no role.
      { _id: "conversations_far_teammate", user_id: BOT, spawned_by_conversation_id: "conversations_role_lead", title: "far", ...live, team_id: "teams_other" },
    ],
    session_owners: [{ _id: "so_1", conversation_id: "conversations_taken", user_id: ME, added_by: ME, added_at: 1 }],
    managed_sessions: [],
    messages: [],
    session_decisions: [],
    decision_inbox: [],
  });
}

const inboxIds = async (db: any) =>
  (await computeInboxSessions({ db } as any, ME as any, { includeLiveness: false })).sessions.map((r: any) => String(r._id)).sort();

describe("a bot-run spawner's peer belongs to the spawner's human", () => {
  test("flag on: it gets my owner row and lands in my inbox", async () => {
    const db = world(true);
    expect(await inboxIds(db)).not.toContain("conversations_peer");
    expect(await ownPeerByItsSpawnersHuman({ db } as any, await db.get("conversations_peer"), await db.get("conversations_spawner"))).toBe(true);
    expect((await db.query("session_owners").collect()).filter((r: any) => r.conversation_id === "conversations_peer").map((r: any) => r.user_id)).toEqual([ME]);
    expect(await inboxIds(db)).toContain("conversations_peer");
  });

  test("a peer with a human of its own gets no row", async () => {
    const db = world(true);
    expect(await ownPeerByItsSpawnersHuman({ db } as any, await db.get("conversations_mine"), await db.get("conversations_spawner"))).toBe(false);
    expect((await db.query("session_owners").collect()).filter((r: any) => r.conversation_id === "conversations_mine")).toEqual([]);
  });

  test("a spawner owned by a person's row passes that person on", async () => {
    const db = world(true);
    expect(await ownPeerByItsSpawnersHuman({ db } as any, await db.get("conversations_taken_peer"), await db.get("conversations_taken"))).toBe(true);
    expect((await db.query("session_owners").collect()).filter((r: any) => r.conversation_id === "conversations_taken_peer").map((r: any) => r.user_id)).toEqual([ME]);
  });

  test("a spawner a role alone owns makes the peer that role's start", async () => {
    const db = world(true);
    expect(await ownPeerByItsSpawnersHuman({ db } as any, await db.get("conversations_teammate"), await db.get("conversations_role_lead"))).toBe(true);
    expect(await db.get("conversations_teammate")).toMatchObject({ org_role_id: "org_roles_r", org_role_hold: "filed", role_started: true });
    expect((await db.query("session_owners").collect()).filter((r: any) => r.conversation_id === "conversations_teammate")).toEqual([]);
  });

  test("a spawner that is itself a worker passes on its parent's person", async () => {
    const db = world(true);
    expect(await ownPeerByItsSpawnersHuman({ db } as any, await db.get("conversations_worker_peer"), await db.get("conversations_worker"))).toBe(true);
    expect((await db.query("session_owners").collect()).filter((r: any) => r.conversation_id === "conversations_worker_peer").map((r: any) => r.user_id)).toEqual([ME]);
  });

  test("a role is never filed across teams", async () => {
    const db = world(true);
    expect(await ownPeerByItsSpawnersHuman({ db } as any, await db.get("conversations_far_teammate"), await db.get("conversations_role_lead"))).toBe(false);
    expect((await db.get("conversations_far_teammate")).org_role_id).toBeUndefined();
  });

  test("a nested session is never handled as a peer", async () => {
    const db = world(true);
    expect(await ownPeerByItsSpawnersHuman({ db } as any, await db.get("conversations_worker"), await db.get("conversations_spawner"))).toBe(false);
  });

  test("flag off, or no spawner: nothing is written", async () => {
    const off = world(false);
    expect(await ownPeerByItsSpawnersHuman({ db: off } as any, await off.get("conversations_peer"), await off.get("conversations_spawner"))).toBe(false);
    const on = world(true);
    expect(await ownPeerByItsSpawnersHuman({ db: on } as any, await on.get("conversations_peer"), null)).toBe(false);
    expect((await on.query("session_owners").collect()).filter((r: any) => r.conversation_id === "conversations_peer")).toEqual([]);
  });
});

// ownerMigrations:backfillPeerOwners: peers a bot-run session spawned before
// the spawn did it, or before the team's flag was on, get the same owner.
describe("backfillPeerOwners", () => {
  const run = async (db: any, dryRun: boolean) => {
    const owned: string[] = [];
    let cursor: string | null = null;
    do {
      const res: any = await backfillPeerOwnersPage({ db } as any, { team_id: TEAM, dryRun, cursor, numItems: 3 });
      owned.push(...res.owned.map((o: any) => o.session));
      cursor = res.next;
    } while (cursor);
    return owned.sort();
  };
  const rowsOf = async (db: any) => (await db.query("session_owners").collect()).length;

  test("a dry run names each unowned peer and writes nothing; a real run owns them; a rerun owns 0", async () => {
    const db = world(true);
    const peers = ["conversations_peer", "conversations_taken_peer", "conversations_teammate", "conversations_worker_peer"];
    expect(await run(db, true)).toEqual(peers);
    expect(await rowsOf(db)).toBe(1);
    expect(await run(db, false)).toEqual(peers);
    expect(await inboxIds(db)).toContain("conversations_peer");
    expect((await db.get("conversations_teammate")).org_role_id).toBe("org_roles_r");
    expect(await run(db, false)).toEqual([]);
  });

  test("flag off: it owns nothing", async () => {
    expect(await run(world(false), false)).toEqual([]);
  });
});
