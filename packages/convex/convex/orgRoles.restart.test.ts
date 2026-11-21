import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { performCreateRole, performProvisionRole, performRestartRole, standingConversationOf } from "./orgRoles";
import { isBootstrapPrompt } from "@codecast/shared/contracts";

// `cast role restart` (org-roles-standing.md T4): plain restarts the standing
// session in place; `--fresh` starts a new one seeded like a first standing
// session and retires the old.

const ME = "u".repeat(31) + "m";
const RUNNER = "u".repeat(31) + "r";
const TEAM = "teams_acme" as any;
const NOW = 1_800_000_000_000;

function world() {
  const tables: Record<string, any[]> = {
    users: [{ _id: ME, name: "Me", email: "me@x.ai" }, { _id: RUNNER, name: "Runner", email: "runner@x.ai" }],
    team_memberships: [
      { _id: "m1", user_id: ME, team_id: TEAM, role: "admin", joined_at: 1 },
      { _id: "m2", user_id: RUNNER, team_id: TEAM, role: "member", joined_at: 1 },
    ],
    teams: [{ _id: TEAM, name: "Acme", features: { org: true } }],
    counters: [],
    org_roles: [],
    org_role_history: [],
    org_changes: [],
    org_proposals: [],
    org_proposal_changes: [],
    anchors: [],
    anchor_channels: [],
    session_commands: [],
    conversations: [
      { _id: "mine", user_id: ME, session_id: "s-mine", short_id: "jxmine1", status: "active", agent_type: "codex", model: "gpt-5", updated_at: NOW, message_count: 4, team_id: TEAM, project_path: "/repo" },
      { _id: "projsess", user_id: ME, session_id: "s-proj", short_id: "jxproj1", status: "active", agent_type: "claude_code", updated_at: NOW, message_count: 2, team_id: TEAM, project_path: "/repo" },
    ],
    agent_tasks: [],
    pending_messages: [],
    managed_sessions: [],
    session_owners: [],
    messages: [],
    user_presence: [],
    devices: [],
    docs: [],
    projects: [{ _id: "projects_p1", user_id: ME, title: "Repo", team_id: TEAM, workspace: `team:${TEAM}`, short_id: "pr-1", status: "active", created_at: 1, updated_at: 1, default_session_id: "projsess" },
      // A project whose canonical session is the seat itself.
      { _id: "projects_p2", user_id: ME, title: "Ops", team_id: TEAM, workspace: `team:${TEAM}`, short_id: "pr-2", status: "active", created_at: 1, updated_at: 1, default_session_id: "mine" },
    ],
    plans: [],
    tasks: [],
    session_decisions: [],
    decision_inbox: [],
    decision_grants: [],
  };
  const db = makeFakeDb(tables);
  const ctx: any = { db, scheduler: { runAfter: async () => {} } };
  return { ctx, tables };
}

async function lead(ctx: any) {
  const role = await performCreateRole(ctx, ME as any, { name: "Infra lead", handle: "infra", team_id: TEAM, scope: { project_ids: ["projects_p1" as any], plan_ids: [] } });
  await performProvisionRole(ctx, ME as any, { role_id: String(role._id), adopt_conversation_id: "mine" });
  return role;
}

const live = (t: any) => !["cancelled", "completed", "failed"].includes(t.status);

describe("cast role restart --fresh", () => {
  test("seats a new conversation with a pending opening and retires the old seat without adopting the project's session", async () => {
    const { ctx, tables } = world();
    const role = await lead(ctx);
    const oldAnchorId = tables.org_roles[0].anchor_id;
    expect(tables.agent_tasks.filter((t) => t.originating_conversation_id === "mine" && live(t)).length).toBeGreaterThan(0);

    const out = await performRestartRole(ctx, ME as any, { role_id: String(role._id), fresh: true });

    const roleRow = tables.org_roles[0];
    const standing = await standingConversationOf(ctx, roleRow);
    expect(standing).toBeTruthy();
    expect(String(standing._id)).not.toBe("mine");
    expect(String(standing._id)).not.toBe("projsess");
    expect(String(out.conversation_id)).toBe(String(standing._id));
    expect(out.short_id).toBe(standing.short_id);
    expect(String(out.previous_conversation_id)).toBe("mine");
    expect(standing).toMatchObject({ standing_role_id: roleRow._id, persistent: true, agent_type: "codex", model: "gpt-5", project_path: "/repo" });
    expect(tables.pending_messages.some((p) => String(p.conversation_id) === String(standing._id) && p.status === "pending" && isBootstrapPrompt(String(p.content)))).toBe(true);
    // The new seat gets its own routine.
    expect(tables.agent_tasks.some((t) => String(t.originating_conversation_id) === String(standing._id) && live(t))).toBe(true);

    // The old seat is retired.
    expect(String(roleRow.anchor_id)).not.toBe(String(oldAnchorId));
    expect(tables.anchors.find((a) => a._id === oldAnchorId)!.status).toBe("decommissioned");
    const old = tables.conversations.find((c) => c._id === "mine")!;
    expect(old.standing_role_id).toBeUndefined();
    expect(old.anchor_id).toBeUndefined();
    expect(old.acting_user_id).toBeUndefined();
    expect(old.persistent).toBe(false);
    expect(tables.agent_tasks.filter((t) => t.originating_conversation_id === "mine" && live(t))).toEqual([]);
    expect(String(roleRow.previous_standing_conversation_id)).toBe("mine");

    // The project's session was left alone.
    const proj = tables.conversations.find((c) => c._id === "projsess")!;
    expect(proj.standing_role_id).toBeUndefined();
    expect(proj.anchor_id).toBeUndefined();
  });

  test("the new seat runs and bills on the old seat's runner, not on the admin who restarted it", async () => {
    const { ctx, tables } = world();
    const role = await lead(ctx);
    // The seat moved to another account since it was seated (cast role move).
    tables.conversations.find((c) => c._id === "mine")!.user_id = RUNNER;
    await performRestartRole(ctx, ME as any, { role_id: String(role._id), fresh: true });
    const standing = await standingConversationOf(ctx, tables.org_roles[0]);
    expect(String(standing._id)).not.toBe("mine");
    expect(standing.user_id).toBe(RUNNER);
    expect(tables.anchors.find((a) => a._id === tables.org_roles[0].anchor_id)!.host_user_id).toBe(RUNNER);
    expect(tables.agent_tasks.filter((t) => String(t.originating_conversation_id) === String(standing._id) && live(t)).every((t) => t.user_id === RUNNER)).toBe(true);
    expect(tables.pending_messages.some((p) => String(p.conversation_id) === String(standing._id) && isBootstrapPrompt(String(p.content)))).toBe(true);
  });

  test("a project whose canonical session was the old seat points at the new one; others are untouched", async () => {
    const { ctx, tables } = world();
    const role = await lead(ctx);
    await performRestartRole(ctx, ME as any, { role_id: String(role._id), fresh: true });
    const standing = await standingConversationOf(ctx, tables.org_roles[0]);
    expect(String(tables.projects.find((p) => p._id === "projects_p2")!.default_session_id)).toBe(String(standing._id));
    expect(tables.projects.find((p) => p._id === "projects_p1")!.default_session_id).toBe("projsess");
  });

  test("plain restart keeps the same standing session", async () => {
    const { ctx, tables } = world();
    const role = await lead(ctx);
    const anchorId = tables.org_roles[0].anchor_id;
    const out = await performRestartRole(ctx, ME as any, { role_id: String(role._id) });
    expect(String(out.conversation_id)).toBe("mine");
    expect(tables.org_roles[0].anchor_id).toBe(anchorId);
    expect(tables.anchors.find((a) => a._id === anchorId)!.status).not.toBe("decommissioned");
    expect(tables.org_roles[0].previous_standing_conversation_id).toBeUndefined();
  });
});
