import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { briefingFor, performRebriefWorkspaceAgents } from "./anchors";

// Workspace agents (no role seat) get the opening that ships now only through
// a rebrief, and that opening names who reads their conversation from the
// conversation itself, not from the anchor's scope.

const ME = "u".repeat(31) + "m";
const TEAM = "teams_fern" as any;

function world() {
  const tables: Record<string, any[]> = {
    users: [{ _id: ME, name: "Theo", email: "theo@x.ai" }],
    teams: [{ _id: TEAM, name: "Fernhill" }],
    team_memberships: [{ _id: "m1", user_id: ME, team_id: TEAM, role: "admin", joined_at: 1, visibility: "full" }],
    org_roles: [],
    anchors: [
      { _id: "a_personal", scope_type: "user", scope_user_id: ME, name: "Fern", status: "active", conversation_id: "c_personal", host_user_id: ME },
      { _id: "a_team", scope_type: "team", team_id: TEAM, name: "Fernhill agent", status: "active", conversation_id: "c_team", host_user_id: ME },
      { _id: "a_role", scope_type: "team", team_id: TEAM, name: "Infra", status: "active", conversation_id: "c_role", host_user_id: ME, org_role_id: "r1" },
      { _id: "a_gone", scope_type: "team", team_id: TEAM, name: "Old", status: "decommissioned", conversation_id: "c_team", host_user_id: ME },
    ],
    conversations: ["c_personal", "c_team", "c_role"].map((id) => ({
      _id: id, user_id: ME, short_id: `jx${id.slice(2, 7)}`, session_id: `s-${id}`, status: "active", agent_type: "claude_code",
      updated_at: 1, started_at: 1, message_count: 1, team_id: TEAM, is_private: false, persistent: true,
    })),
    pending_messages: [],
    session_commands: [],
    managed_sessions: [],
  };
  return { tables, ctx: { db: makeFakeDb(tables) } as any };
}

describe("workspace agent rebrief", () => {
  test("a personal agent whose directory shares its session is told the team reads it", async () => {
    const { ctx, tables } = world();
    const shared = await briefingFor(ctx, tables.anchors[0]);
    expect(shared).toContain("this conversation is shared with Fernhill");
    expect(shared).not.toContain("private to them");
    tables.conversations[0].is_private = true;
    expect(await briefingFor(ctx, tables.anchors[0])).toContain("private to them");
  });

  test("the sweep reaches every live workspace agent once, and no role seat", async () => {
    const { ctx, tables } = world();
    const dry = await performRebriefWorkspaceAgents(ctx, { dry_run: true });
    expect(dry.sent.map((s) => s.anchor)).toEqual(["a_personal", "a_team"]);
    expect(dry.skipped).toBe(1);
    expect(tables.pending_messages).toHaveLength(0);
    await performRebriefWorkspaceAgents(ctx, { key: "17" });
    expect(tables.pending_messages).toHaveLength(2);
    expect(tables.pending_messages[0].content).toBe(await briefingFor(ctx, tables.anchors[0]));
    await performRebriefWorkspaceAgents(ctx, { key: "17" });
    expect(tables.pending_messages).toHaveLength(2);
    expect((await performRebriefWorkspaceAgents(ctx, { only: ["a_team"], dry_run: true })).sent.map((s) => s.anchor)).toEqual(["a_team"]);
  });
});
