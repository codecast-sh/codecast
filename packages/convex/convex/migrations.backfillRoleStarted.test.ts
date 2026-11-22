import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { backfillRoleStartedPage } from "./migrations";

// migrations:backfillRoleStarted: sessions a role started before
// spawn.recordHandStart stamped `role_started` are stamped by the rule a new
// spawn reads (shared actsForRole on the session that started it); a person's
// own session filed under the role, and what it started, are left alone.

const ME = "users_me";
const ROLE = "org_roles_growth";

const conv = (id: string, over: Record<string, any> = {}) => ({
  _id: `conversations_${id}`, short_id: id, user_id: ME, status: "active", message_count: 3, updated_at: 1, ...over,
});

function fixtures() {
  return makeFakeDb({
    org_roles: [{ _id: ROLE, handle: "growth", name: "Growth lead", status: "active" }],
    workflow_runs: [
      { _id: "workflow_runs_line", user_id: ME, org_role_id: ROLE, spawner_conversation_id: "conversations_standing" },
      { _id: "workflow_runs_person", user_id: ME, org_role_id: ROLE, spawner_conversation_id: "conversations_mine" },
    ],
    conversations: [
      conv("standing", { standing_role_id: ROLE, anchor_id: "anchors_growth" }),
      conv("mine"),
      conv("hand", { org_role_id: ROLE, org_role_hold: "filed", spawned_by_conversation_id: "conversations_standing" }),
      conv("hand_of_hand", { org_role_id: ROLE, org_role_hold: "filed", spawned_by_conversation_id: "conversations_hand" }),
      conv("line_run", { org_role_id: ROLE, workflow_run_id: "workflow_runs_line", is_workflow_primary: true }),
      conv("station", { org_role_id: ROLE, org_role_hold: "filed", is_subagent: true, parent_conversation_id: "conversations_line_run", spawned_by_conversation_id: "conversations_standing" }),
      // A hand a person took over: what it starts is the person's.
      conv("taken_over", { org_role_id: ROLE, role_started: true, driver_user_id: ME, spawned_by_conversation_id: "conversations_standing" }),
      conv("worker_of_taken_over", { org_role_id: ROLE, org_role_hold: "filed", spawned_by_conversation_id: "conversations_taken_over" }),
      // A person's session a task binding filed under the role, and the worker it spawned.
      conv("person_bound", { org_role_id: ROLE, org_role_hold: "bound", spawned_by_conversation_id: "conversations_standing" }),
      conv("worker_of_bound", { org_role_id: ROLE, org_role_hold: "filed", spawned_by_conversation_id: "conversations_person_bound" }),
      conv("person_run", { org_role_id: ROLE, workflow_run_id: "workflow_runs_person", is_workflow_primary: true }),
    ],
    messages: [],
  });
}

const STARTED = ["hand", "hand_of_hand", "line_run", "station"];

describe("backfillRoleStarted", () => {
  test("a dry run names each session a role started and writes nothing", async () => {
    const db = fixtures();
    const res = await backfillRoleStartedPage({ db } as any, {});
    expect(res.dryRun).toBe(true);
    expect(res.rows.map((r) => r.session).sort()).toEqual([...STARTED].sort());
    expect(res.next).toBeNull();
    expect((await db.get("conversations_hand" as any)).role_started).toBeUndefined();
  });

  test("a real run stamps them; a person's sessions and what they started are left alone", async () => {
    const db = fixtures();
    await backfillRoleStartedPage({ db } as any, { dryRun: false });
    for (const id of STARTED) expect((await db.get(`conversations_${id}` as any)).role_started).toBe(true);
    for (const id of ["person_bound", "worker_of_bound", "person_run", "worker_of_taken_over", "mine", "standing"]) {
      expect((await db.get(`conversations_${id}` as any)).role_started).toBeUndefined();
    }
  });

  test("it pages through a role's sessions and hands the cursor on", async () => {
    const db = fixtures();
    const first = await backfillRoleStartedPage({ db } as any, { dryRun: false, numItems: 3 });
    expect(first.next).toMatchObject({ roleIndex: 0 });
    let next: any = first.next;
    while (next) next = (await backfillRoleStartedPage({ db } as any, { dryRun: false, numItems: 3, ...next })).next;
    for (const id of STARTED) expect((await db.get(`conversations_${id}` as any)).role_started).toBe(true);
  });
});
