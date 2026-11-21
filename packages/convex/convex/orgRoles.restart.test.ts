import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { performCreateRole, performPauseRole, performProvisionRole, performRestartRole, standingConversationOf } from "./orgRoles";
import { performUndo } from "./orgChanges";
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
    org_change_batches: [],
    daemon_commands: [],
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
      // One outside the role's workspace that also points at the seat.
      { _id: "projects_p3", user_id: ME, title: "Notes", workspace: `user:${ME}`, short_id: "pr-3", status: "active", created_at: 1, updated_at: 1, default_session_id: "mine" },
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
    expect(String(tables.projects.find((p) => p._id === "projects_p3")!.default_session_id)).toBe(String(standing._id));
    expect(tables.projects.find((p) => p._id === "projects_p1")!.default_session_id).toBe("projsess");
  });

  test("a paused role is refused and stays as it was", async () => {
    const { ctx, tables } = world();
    const role = await lead(ctx);
    await performPauseRole(ctx, ME as any, { role_id: String(role._id) });
    const anchorId = tables.org_roles[0].anchor_id;
    await expect(performRestartRole(ctx, ME as any, { role_id: String(role._id), fresh: true })).rejects.toThrow("resume it first");
    expect(tables.org_roles[0]).toMatchObject({ status: "paused", anchor_id: anchorId });
    expect(tables.anchors.find((a) => a._id === anchorId)!.status).not.toBe("decommissioned");
  });

  test("the check keeps its tuning on the new seat", async () => {
    const { ctx, tables } = world();
    const role = await lead(ctx);
    const check = tables.agent_tasks.find((t) => t.originating_conversation_id === "mine" && t.schedule_type === "recurring" && String(t.role_id) === String(role._id))!;
    Object.assign(check, { interval_ms: 7_200_000, precheck: "test -f /tmp/x", role_focus: "only CI", tune_why: "quiet week" });
    await performRestartRole(ctx, ME as any, { role_id: String(role._id), fresh: true });
    const standing = await standingConversationOf(ctx, tables.org_roles[0]);
    const fresh = tables.agent_tasks.find((t) => String(t.originating_conversation_id) === String(standing._id) && t.title === check.title)!;
    expect(fresh).toMatchObject({ status: "scheduled", interval_ms: 7_200_000, precheck: "test -f /tmp/x", role_focus: "only CI", tune_why: "quiet week" });
  });

  test("a check the person cancelled stays cancelled on the new seat", async () => {
    const { ctx, tables } = world();
    const role = await lead(ctx);
    const check = tables.agent_tasks.find((t) => t.originating_conversation_id === "mine" && t.schedule_type === "recurring" && String(t.role_id) === String(role._id))!;
    // A person's cancel (cast trigger cancel) completes the trigger.
    check.status = "completed";
    await performRestartRole(ctx, ME as any, { role_id: String(role._id), fresh: true });
    const standing = await standingConversationOf(ctx, tables.org_roles[0]);
    const fresh = tables.agent_tasks.find((t) => String(t.originating_conversation_id) === String(standing._id) && t.title === check.title)!;
    expect(live(fresh)).toBe(false);
  });

  for (const [why, stop] of [["failed three slots", { status: "failed", failed_slots: 3 }], ["was cancelled with its killed session", { status: "completed", canceled_on_kill_at: NOW }]] as const) {
    test(`a check that ${why} comes back armed, with its tuning`, async () => {
      const { ctx, tables } = world();
      const role = await lead(ctx);
      const check = tables.agent_tasks.find((t) => t.originating_conversation_id === "mine" && t.schedule_type === "recurring" && String(t.role_id) === String(role._id))!;
      Object.assign(check, stop, { interval_ms: 7_200_000, role_focus: "only CI" });
      await performRestartRole(ctx, ME as any, { role_id: String(role._id), fresh: true });
      const standing = await standingConversationOf(ctx, tables.org_roles[0]);
      const fresh = tables.agent_tasks.find((t) => String(t.originating_conversation_id) === String(standing._id) && t.title === check.title)!;
      expect(fresh).toMatchObject({ status: "scheduled", interval_ms: 7_200_000, role_focus: "only CI" });
    });
  }

  test("a check the person paused stays paused on the new seat", async () => {
    const { ctx, tables } = world();
    const role = await lead(ctx);
    const check = tables.agent_tasks.find((t) => t.originating_conversation_id === "mine" && t.schedule_type === "recurring" && String(t.role_id) === String(role._id))!;
    check.status = "paused";
    await performRestartRole(ctx, ME as any, { role_id: String(role._id), fresh: true });
    const standing = await standingConversationOf(ctx, tables.org_roles[0]);
    expect(tables.agent_tasks.find((t) => String(t.originating_conversation_id) === String(standing._id) && t.title === check.title)!.status).toBe("paused");
  });

  test("the old seat's Slack channels move to the new anchor", async () => {
    const { ctx, tables } = world();
    const role = await lead(ctx);
    tables.anchor_channels.push({ _id: "ch1", anchor_id: tables.org_roles[0].anchor_id, surface: "slack", channel_key: "C1", workspace_key: "W1", created_at: 1 });
    await performRestartRole(ctx, ME as any, { role_id: String(role._id), fresh: true });
    expect(tables.anchor_channels).toHaveLength(1);
    expect(tables.anchor_channels[0].anchor_id).toBe(tables.org_roles[0].anchor_id);
  });

  test("the new seat starts on the old seat's machine", async () => {
    const { ctx, tables } = world();
    const role = await lead(ctx);
    const now = Date.now();
    // A laptop with the checkout would win the routing if nothing named the host.
    tables.devices.push(
      { _id: "devices_host", user_id: ME, device_id: "host-1", last_seen: now, local_project_roots: [] },
      { _id: "devices_laptop", user_id: ME, device_id: "laptop-1", last_seen: now, local_project_roots: ["/repo"] },
    );
    tables.conversations.find((c) => c._id === "mine")!.owner_device_id = "host-1";
    await performRestartRole(ctx, ME as any, { role_id: String(role._id), fresh: true });
    const standing = await standingConversationOf(ctx, tables.org_roles[0]);
    expect(standing.owner_device_id).toBe("host-1");
  });

  test("an old seat's machine that is offline is not named; routing picks a live one", async () => {
    const { ctx, tables } = world();
    const role = await lead(ctx);
    const now = Date.now();
    tables.devices.push(
      { _id: "devices_old", user_id: ME, device_id: "old-1", last_seen: now - 7 * 86_400_000, local_project_roots: ["/repo"] },
      { _id: "devices_live", user_id: ME, device_id: "live-1", last_seen: now, local_project_roots: ["/repo"] },
    );
    tables.conversations.find((c) => c._id === "mine")!.owner_device_id = "old-1";
    await performRestartRole(ctx, ME as any, { role_id: String(role._id), fresh: true });
    const standing = await standingConversationOf(ctx, tables.org_roles[0]);
    expect(standing.owner_device_id).toBe("live-1");
  });

  test("a runner who left the team is named, with the move to run first", async () => {
    const { ctx, tables } = world();
    const role = await lead(ctx);
    tables.conversations.find((c) => c._id === "mine")!.user_id = RUNNER;
    tables.team_memberships.splice(tables.team_memberships.findIndex((m) => m.user_id === RUNNER), 1);
    const anchorId = tables.org_roles[0].anchor_id;
    await expect(performRestartRole(ctx, ME as any, { role_id: String(role._id), fresh: true })).rejects.toThrow(/Runner.*cast role move @infra/);
    expect(tables.anchors.find((a) => a._id === anchorId)!.status).not.toBe("decommissioned");
  });

  test("a second press moments later returns the fresh seat and keeps the real old thread", async () => {
    const { ctx, tables } = world();
    const role = await lead(ctx);
    const first = await performRestartRole(ctx, ME as any, { role_id: String(role._id), fresh: true });
    const second = await performRestartRole(ctx, ME as any, { role_id: String(role._id), fresh: true });
    expect(String(second.conversation_id)).toBe(String(first.conversation_id));
    expect(second.already_fresh).toBe(true);
    expect(String(tables.org_roles[0].previous_standing_conversation_id)).toBe("mine");
    expect(tables.anchors.filter((a) => a.status !== "decommissioned")).toHaveLength(1);
  });

  test("an old previous seat never makes a quiet new seat look like a second press", async () => {
    const { ctx, tables } = world();
    const role = await lead(ctx);
    // A seat from months ago, and a current seat that has not spoken yet.
    tables.org_roles[0].previous_standing_conversation_id = "projsess";
    Object.assign(tables.conversations.find((c) => c._id === "mine")!, { message_count: 0, started_at: Date.now() });
    const out = await performRestartRole(ctx, ME as any, { role_id: String(role._id), fresh: true });
    expect(out.already_fresh).toBeUndefined();
    expect(String(out.conversation_id)).not.toBe("mine");
    expect(String(tables.org_roles[0].previous_standing_conversation_id)).toBe("mine");
  });

  test("the org history refuses to undo a fresh restart and changes nothing", async () => {
    const { ctx, tables } = world();
    // Each gesture is its own transaction, so its own history entry.
    const fresh = () => ({ db: ctx.db, scheduler: ctx.scheduler } as any);
    const role = await lead(fresh());
    await performRestartRole(fresh(), ME as any, { role_id: String(role._id), fresh: true });
    const standing = await standingConversationOf(ctx, tables.org_roles[0]);
    const row = tables.org_changes.at(-1)!;
    expect(tables.org_changes.filter((r) => r.batch === row.batch)).toHaveLength(1);
    expect(row.effects.restarted_fresh.previous.conversation_id).toBe("mine");
    const before = JSON.stringify({ anchors: tables.anchors, roles: tables.org_roles });
    await expect(performUndo(fresh(), ME as any, { batch: String(row.batch) })).rejects.toThrow("cannot be undone");
    expect(JSON.stringify({ anchors: tables.anchors, roles: tables.org_roles })).toBe(before);
    expect(String((await standingConversationOf(ctx, tables.org_roles[0]))._id)).toBe(String(standing._id));
    // Undoing the hire before it names the restart that depends on it.
    await expect(performUndo(fresh(), ME as any, { batch: String(tables.org_changes[0].batch), with: [String(row.batch)] })).rejects.toThrow("a later fresh restart depends on it");
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
