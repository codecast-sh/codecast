import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { backfillRoleStartedPage } from "./lib/roleStartedBackfill";

// ownerMigrations:backfillRoleStarted on main-shaped data: sessions a role
// started before spawn.recordHandStart stamped `role_started` are stamped by
// the rule a new spawn reads (shared actsForRole on the session that started
// it); a person's own session filed under the role, and what it started, are
// left alone. It only stamps: owner rows never move.

const ME = "users_me";
const ROLE = "org_roles_growth";
const OTHER = "org_roles_ops";
const TEAM = "teams_union";
const ELSEWHERE = "teams_other";
// Another team's role with the same handle: the backfill is the team's own.
const FOREIGN = "org_roles_other_growth";

const conv = (id: string, over: Record<string, any> = {}) => ({
  _id: `conversations_${id}`, short_id: id, user_id: ME, status: "active", message_count: 3, updated_at: 1, ...over,
});

const ROWS = () => [
  conv("standing", { standing_role_id: ROLE, anchor_id: "anchors_growth" }),
  conv("mine"),
  conv("hand", { org_role_id: ROLE, org_role_hold: "filed", spawned_by_conversation_id: "conversations_standing" }),
  conv("hand_of_hand", { org_role_id: ROLE, org_role_hold: "filed", spawned_by_conversation_id: "conversations_hand" }),
  conv("line_run", { org_role_id: ROLE, workflow_run_id: "workflow_runs_line", is_workflow_primary: true }),
  conv("station", { org_role_id: ROLE, org_role_hold: "filed", is_subagent: true, parent_conversation_id: "conversations_line_run", spawned_by_conversation_id: "conversations_standing" }),
  // A hand a person took over on main: a person target took the role pointer off.
  conv("taken_over", { spawned_by_conversation_id: "conversations_standing" }),
  conv("worker_of_taken_over", { org_role_id: ROLE, org_role_hold: "filed", spawned_by_conversation_id: "conversations_taken_over" }),
  // A person's session a task binding filed under the role, and the worker it spawned.
  conv("person_bound", { org_role_id: ROLE, org_role_hold: "bound" }),
  conv("worker_of_bound", { org_role_id: ROLE, org_role_hold: "filed", spawned_by_conversation_id: "conversations_person_bound" }),
  // The role's hand bound to the role's own task: still the role's start.
  conv("hand_bound", { org_role_id: ROLE, org_role_hold: "bound", spawned_by_conversation_id: "conversations_standing" }),
  conv("person_run", { org_role_id: ROLE, workflow_run_id: "workflow_runs_person", is_workflow_primary: true }),
  // A hand of another role's standing session, filed under that role.
  conv("ops_standing", { standing_role_id: OTHER }),
  conv("ops_hand", { org_role_id: OTHER, spawned_by_conversation_id: "conversations_ops_standing" }),
  conv("other_standing", { standing_role_id: FOREIGN }),
  conv("other_hand", { org_role_id: FOREIGN, spawned_by_conversation_id: "conversations_other_standing" }),
];

function fixtures(order: (rows: any[]) => any[] = (r) => r) {
  return makeFakeDb({
    org_roles: [
      { _id: ROLE, team_id: TEAM, handle: "growth", name: "Growth lead", status: "active" },
      { _id: OTHER, team_id: TEAM, handle: "ops", name: "Ops lead", status: "active" },
      { _id: FOREIGN, team_id: ELSEWHERE, handle: "growth", name: "Growth lead", status: "active" },
    ],
    workflow_runs: [
      { _id: "workflow_runs_line", user_id: ME, org_role_id: ROLE, spawner_conversation_id: "conversations_standing" },
      { _id: "workflow_runs_person", user_id: ME, org_role_id: ROLE, spawner_conversation_id: "conversations_mine" },
    ],
    conversations: order(ROWS()),
    session_owners: [
      { _id: "so1", conversation_id: "conversations_hand", user_id: ME, added_by: ME, added_at: 1 },
      { _id: "so2", conversation_id: "conversations_person_run", user_id: ME, added_by: ME, added_at: 1 },
    ],
  });
}

const STARTED = ["hand", "hand_of_hand", "line_run", "station", "hand_bound", "ops_hand"];
const LEFT = ["person_bound", "worker_of_bound", "person_run", "taken_over", "worker_of_taken_over", "mine", "standing", "ops_standing", "other_standing", "other_hand"];

async function runAll(db: any, numItems?: number) {
  let next: any = {};
  const seen: string[] = [];
  while (next) {
    const res = await backfillRoleStartedPage({ db } as any, { team_id: TEAM, dryRun: false, numItems, ...next });
    seen.push(...res.sessions);
    next = res.next;
  }
  return seen;
}

const stamped = (db: any) => db._tables.conversations.filter((c: any) => c.role_started).map((c: any) => c.short_id).sort();

describe("backfillRoleStarted", () => {
  test("a dry run names each session a role started and writes nothing", async () => {
    const db = fixtures();
    const res = await backfillRoleStartedPage({ db } as any, { team_id: TEAM });
    expect(res.dryRun).toBe(true);
    expect(res.next).toEqual({ roleIndex: 1, cursor: undefined });
    expect(stamped(db)).toEqual([]);
    const ops = await backfillRoleStartedPage({ db } as any, { team_id: TEAM, ...res.next! });
    expect([...res.sessions, ...ops.sessions].sort()).toEqual([...STARTED].sort());
    expect(stamped(db)).toEqual([]);
  });

  test("a real run stamps them, leaves a person's sessions alone, and moves no owner row", async () => {
    const db = fixtures();
    await runAll(db);
    expect(stamped(db)).toEqual([...STARTED].sort());
    for (const id of LEFT) expect((await db.get(`conversations_${id}` as any)).role_started).toBeUndefined();
    expect(db._tables.session_owners.map((r: any) => r._id)).toEqual(["so1", "so2"]);
  });

  test("any order of rows and any page size gives the same result", async () => {
    const orders: Array<(rows: any[]) => any[]> = [(r) => r, (r) => [...r].reverse(), (r) => [...r.slice(7), ...r.slice(0, 7)]];
    for (const order of orders) {
      for (const numItems of [1, 2, 100]) {
        const db = fixtures(order);
        await runAll(db, numItems);
        expect(stamped(db)).toEqual([...STARTED].sort());
      }
    }
  });

  test("a re-run stamps 0 and writes nothing", async () => {
    const db = fixtures();
    await runAll(db);
    const writes = db._tables.conversations.map((c: any) => ({ ...c }));
    expect(await runAll(db)).toEqual([]);
    expect(db._tables.conversations).toEqual(writes);
  });

  test("it pages one team's roles only: another team's role of the same handle is left alone", async () => {
    const db = fixtures();
    await runAll(db);
    expect(stamped(db)).not.toContain("other_hand");
    const elsewhere = await backfillRoleStartedPage({ db } as any, { team_id: ELSEWHERE, dryRun: false });
    expect([elsewhere.sessions, elsewhere.next]).toEqual([["other_hand"], null]);
  });
});
