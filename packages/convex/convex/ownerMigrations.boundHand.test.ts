import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { performCreateRole } from "./orgRoles";
import { releaseFolderHeld } from "./migrations";
import { backfillRoleStartedPage } from "./lib/roleStartedBackfill";
import { backfillBoundDriverPage } from "./lib/boundDriverBackfill";
import { backfillMovedStarterRowsPage } from "./lib/starterRowBackfill";

// Main's data: releaseFolderHeld stamped "bound" on every session a role held
// whose task is in its area, the role's own hands among them. The owner
// backfills judge a hand by who started it, never by that hold.

const ME = "u".repeat(31) + "m";
const TEAM = "teams_acme" as any;
const WS = `team:${TEAM}`;
const NOW = 1_800_000_000_000;
const P = "projects_p";
const conv = (n: number, over: Record<string, any> = {}) => ({
  _id: `conversations_s${n}`, short_id: `jx7000${n}`, user_id: ME, team_id: TEAM, status: "active", agent_type: "claude_code",
  title: `Work ${n}`, project_path: "/repo/growth", message_count: 3, last_message_role: "assistant", updated_at: NOW - 60_000, created_at: 1, _creationTime: 1000, ...over,
});

async function mainShaped() {
  const db = makeFakeDb({
    users: [{ _id: ME, name: "Me", email: "me@x.ai" }],
    team_memberships: [{ _id: "m1", user_id: ME, team_id: TEAM, role: "admin", joined_at: 1 }],
    teams: [{ _id: TEAM, name: "Acme" }],
    counters: [], org_roles: [], org_role_history: [], anchors: [],
    projects: [{ _id: P, user_id: ME, team_id: TEAM, workspace: WS, short_id: "pr-1", title: "Growth", status: "active", project_path: "/repo/growth", created_at: 1, updated_at: NOW }],
    plans: [],
    tasks: [{ _id: "tasks_growth", short_id: "ct-1", title: "grow", user_id: ME, team_id: TEAM, workspace: WS, status: "open", project_id: P, created_at: 1, updated_at: NOW }],
    docs: [], conversations: [], session_owners: [], session_decisions: [], managed_sessions: [], messages: [], user_presence: [], pending_messages: [], devices: [],
    org_changes: [], org_change_batches: [], workflow_runs: [],
  });
  const ctx = { db, scheduler: { runAfter: async () => {} } } as any;
  const growth = await performCreateRole(ctx, ME as any, { name: "Growth", handle: "growth", team_id: TEAM, scope: { project_ids: [P as any], plan_ids: [] } });
  db._tables.conversations.push(
    conv(9, { standing_role_id: growth._id }),
    // The role's hand, spawned by its standing session, which ran `cast task start` on the role's task.
    conv(11, { org_role_id: growth._id, org_role_hold: "filed", parent_conversation_id: "conversations_s9", spawned_by_conversation_id: "conversations_s9", active_task_id: "tasks_growth" }),
  );
  // The row the old spawn rules gave the person whose account ran the spawner.
  db._tables.session_owners.push({ _id: "so_hand", conversation_id: "conversations_s11", user_id: ME, added_by: ME, added_at: 1000 });
  await releaseFolderHeld(ctx, { team: String(TEAM), dryRun: false });
  const hand = () => db._tables.conversations.find((c: any) => c._id === "conversations_s11");
  expect(hand().org_role_hold).toBe("bound");
  return { db, ctx, hand };
}

describe("a role's hand bound to its own task", () => {
  test("is the role's start: role_started, no driver, no person row, after all three backfills", async () => {
    const { db, ctx, hand } = await mainShaped();
    expect((await backfillRoleStartedPage(ctx, {})).rows.map((r) => r.session)).toEqual(["jx700011"]);
    expect((await backfillBoundDriverPage(ctx, {})).rows).toEqual([]);
    await backfillRoleStartedPage(ctx, { dryRun: false });
    await backfillBoundDriverPage(ctx, { dryRun: false });
    await backfillMovedStarterRowsPage(ctx, { dryRun: false });
    expect(hand().role_started).toBe(true);
    expect(hand().driver_user_id).toBeUndefined();
    expect(db._tables.session_owners.filter((r: any) => r.conversation_id === "conversations_s11")).toEqual([]);
  });
});
