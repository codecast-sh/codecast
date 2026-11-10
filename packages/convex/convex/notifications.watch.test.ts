import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { toggleWatch } from "./notifications";

// The Watch button subscribes its presser to a task, doc, plan or session:
// only something they can read.

const TEAM = "teams_acme";
const ANA = "users_ana";
const BEN = "users_ben"; // teammate
const EVE = "users_eve"; // outsider

function world() {
  const tables: Record<string, any[]> = {
    users: [{ _id: ANA }, { _id: BEN }, { _id: EVE }],
    team_memberships: [
      { _id: "m1", user_id: ANA, team_id: TEAM, role: "member", visibility: "full" },
      { _id: "m2", user_id: BEN, team_id: TEAM, role: "member", visibility: "full" },
    ],
    tasks: [
      { _id: "task_team", user_id: ANA, team_id: TEAM, workspace: `team:${TEAM}` },
      { _id: "task_private", user_id: ANA, team_id: TEAM, workspace: `user:${ANA}` },
    ],
    conversations: [{ _id: "conv_private", user_id: ANA, team_id: TEAM, is_private: true }],
    session_owners: [],
    entity_subscriptions: [],
  };
  const db: any = makeFakeDb(tables);
  db.normalizeId = (table: string, id: string) => ((tables[table] ?? []).some((r) => r._id === id) ? id : null);
  return db;
}
const watch = (db: any, userId: string, entity_type: string, entity_id: string) =>
  (toggleWatch as any)._handler({ db, auth: { getUserIdentity: async () => ({ subject: `${userId}|sess`, tokenIdentifier: "x" }) } }, { entity_type, entity_id });

describe("notifications.toggleWatch", () => {
  test("nobody watches what they cannot read", async () => {
    const db = world();
    await expect(watch(db, EVE, "task", "task_team")).rejects.toThrow(/Not found/);
    await expect(watch(db, BEN, "task", "task_private")).rejects.toThrow(/Not found/);
    await expect(watch(db, BEN, "conversation", "conv_private")).rejects.toThrow(/Not found/);
    await expect(watch(db, ANA, "doc", "task_team")).rejects.toThrow(/Not found/);
    expect(db._tables.entity_subscriptions).toEqual([]);
  });

  test("a teammate watches a team task and unwatches it; the owner watches their own", async () => {
    const db = world();
    expect(await watch(db, BEN, "task", "task_team")).toEqual({ watching: true });
    expect(await watch(db, BEN, "task", "task_team")).toEqual({ watching: false });
    expect(await watch(db, ANA, "task", "task_private")).toEqual({ watching: true });
    expect(await watch(db, ANA, "conversation", "conv_private")).toEqual({ watching: true });
  });
});
