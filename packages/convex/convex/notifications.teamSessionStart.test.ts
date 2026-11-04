import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { notifyTeamSessionStart } from "./notifications";

const SAM = "user-sam";
const ADA = "user-ada";
const TEAM = "team-1";
const CONV = "conversations_1";

async function notificationsFor(conv: Record<string, unknown>) {
  const db = makeFakeDb({
    users: [
      { _id: SAM, name: "Sam" },
      { _id: ADA, name: "Ada" },
    ],
    team_memberships: [
      { _id: "tm_sam", team_id: TEAM, user_id: SAM, visibility: "summary" },
      { _id: "tm_ada", team_id: TEAM, user_id: ADA, visibility: "summary" },
    ],
    conversations: [{
      _id: CONV,
      user_id: SAM,
      team_id: TEAM,
      is_private: false,
      title: "Daily fleet sweep",
      started_at: Date.now(),
      ...conv,
    }],
    notifications: [],
  });
  await (notifyTeamSessionStart as any)._handler({ db }, { conversation_id: CONV, user_id: SAM });
  return db.query("notifications").collect();
}

describe("notifyTeamSessionStart", () => {
  test("a session a teammate started notifies the team", async () => {
    expect(await notificationsFor({})).toHaveLength(1);
  });

  test("a trigger run never announces itself as a teammate starting to code", async () => {
    expect(await notificationsFor({ agent_task_id: "agent_tasks_1" })).toHaveLength(0);
  });
});
