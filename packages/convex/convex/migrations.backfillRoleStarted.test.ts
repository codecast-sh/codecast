import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { backfillRoleStartedRun } from "./migrations";
import { HAND_BRIEFING_HEADER } from "./spawn";

// migrations:backfillRoleStarted: sessions a role started before
// spawn.recordHandStart stamped `role_started` are stamped from the
// provenance the rows already carry; a person's own session filed under the
// role is left alone, so it stays in their inbox.

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
      conv("hand_of_hand", { org_role_id: ROLE, spawned_by_conversation_id: "conversations_hand" }),
      conv("line_run", { org_role_id: ROLE, workflow_run_id: "workflow_runs_line", is_workflow_primary: true }),
      conv("briefed", { org_role_id: ROLE }),
      // Filed by a person (cast task start in the role's area, the chart, the owners menu).
      conv("person_filed", { org_role_id: ROLE, org_role_hold: "bound" }),
      conv("person_run", { org_role_id: ROLE, workflow_run_id: "workflow_runs_person", is_workflow_primary: true }),
      conv("already", { org_role_id: ROLE, role_started: true, spawned_by_conversation_id: "conversations_standing" }),
    ],
    messages: [
      { _id: "messages_b", conversation_id: "conversations_briefed", role: "user", content: `${HAND_BRIEFING_HEADER}growth`, timestamp: 1 },
      { _id: "messages_p", conversation_id: "conversations_person_filed", role: "user", content: "fix the parser", timestamp: 1 },
    ],
  });
}

describe("backfillRoleStarted", () => {
  test("a dry run names each session a role started and why, and writes nothing", async () => {
    const db = fixtures();
    const res = await backfillRoleStartedRun({ db } as any, {});
    expect(res.dryRun).toBe(true);
    expect(Object.fromEntries(res.rows.map((r) => [r.session, r.why]))).toEqual({
      hand: "spawned from a role's standing session",
      hand_of_hand: "spawned from a role's standing session",
      line_run: "a line run of the role",
      briefed: "briefed as a hand",
    });
    expect((await db.get("conversations_hand" as any)).role_started).toBeUndefined();
  });

  test("a real run stamps them; a person's session filed under the role is left alone", async () => {
    const db = fixtures();
    await backfillRoleStartedRun({ db } as any, { dryRun: false });
    for (const id of ["hand", "hand_of_hand", "line_run", "briefed"]) expect((await db.get(`conversations_${id}` as any)).role_started).toBe(true);
    for (const id of ["person_filed", "person_run", "mine", "standing"]) expect((await db.get(`conversations_${id}` as any)).role_started).toBeUndefined();
  });
});
