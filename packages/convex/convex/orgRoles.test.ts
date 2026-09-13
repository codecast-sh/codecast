import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import {
  performCreateRole,
  performReparentRole,
  performReparentSession,
  performRetireRole,
  performUpdateRole,
} from "./orgRoles";
import { computeOrgTree } from "./org";

// Org roles (docs/architecture/org-roles.md S2 to S5): the boundary rules, the
// cycle guard, the session pointer, and the tree filing sessions under roles.

const ME = "u".repeat(31) + "m"; // team admin, caller
const MATE = "u".repeat(31) + "t"; // plain member
const TEAM = "teams_acme" as any;
const NOW = 1_800_000_000_000;

function fixtures(extra: Record<string, any[]> = {}) {
  return makeFakeDb({
    users: [
      { _id: ME, name: "Me", email: "me@x.ai" },
      { _id: MATE, name: "Mate", email: "mate@x.ai" },
    ],
    team_memberships: [
      { _id: "m1", user_id: ME, team_id: TEAM, role: "admin", joined_at: 1 },
      { _id: "m2", user_id: MATE, team_id: TEAM, role: "member", joined_at: 1 },
    ],
    teams: [{ _id: TEAM, name: "Acme" }],
    counters: [],
    org_roles: [],
    conversations: [],
    session_owners: [],
    managed_sessions: [],
    messages: [],
    user_presence: [],
    ...extra,
  });
}

const ctxOf = (db: any) => ({ db }) as any;

describe("orgRoles.create", () => {
  test("creates a team role with an or- short id, reporting to the caller by default", async () => {
    const db = fixtures();
    const role = await performCreateRole(ctxOf(db), ME as any, { name: "Head of Growth", handle: "Growth", team_id: TEAM });
    expect(role.short_id).toBe("or-1");
    expect(role.scope_type).toBe("team");
    expect(role.handle).toBe("growth");
    expect(role.host_user_id).toBe(ME);
    expect(role.reports_to).toEqual({ kind: "user", user_id: ME });
    expect(role.scope).toEqual({ project_ids: [], plan_ids: [] });
  });

  test("a personal role carries the caller as its scope user", async () => {
    const db = fixtures();
    const role = await performCreateRole(ctxOf(db), ME as any, { name: "Ops", handle: "ops" });
    expect(role.scope_type).toBe("user");
    expect(role.scope_user_id).toBe(ME);
    expect(role.team_id).toBeUndefined();
  });

  test("refuses a duplicate handle in the same boundary, allows it in another", async () => {
    const db = fixtures();
    await performCreateRole(ctxOf(db), ME as any, { name: "A", handle: "growth", team_id: TEAM });
    await expect(performCreateRole(ctxOf(db), MATE as any, { name: "B", handle: "growth", team_id: TEAM }))
      .rejects.toThrow(/already taken/);
    // The same handle in the caller's personal space is a different boundary.
    const personal = await performCreateRole(ctxOf(db), ME as any, { name: "C", handle: "growth" });
    expect(personal.short_id).toBe("or-2");
  });

  test("refuses a bad handle and a non-member team", async () => {
    const db = fixtures();
    await expect(performCreateRole(ctxOf(db), ME as any, { name: "A", handle: "x" })).rejects.toThrow(/Handle/);
    await expect(performCreateRole(ctxOf(db), ME as any, { name: "A", handle: "Has Space" })).rejects.toThrow(/Handle/);
    await expect(performCreateRole(ctxOf(db), ME as any, { name: "A", handle: "ok", team_id: "teams_other" as any }))
      .rejects.toThrow(/not a member/);
  });

  test("refuses reports_to pointing at a role in another boundary", async () => {
    const db = fixtures();
    const personal = await performCreateRole(ctxOf(db), ME as any, { name: "P", handle: "pp" });
    await expect(performCreateRole(ctxOf(db), ME as any, {
      name: "T", handle: "tt", team_id: TEAM, reports_to: { kind: "role", role_id: personal._id },
    })).rejects.toThrow(/same workspace/);
  });
});

describe("orgRoles.reparent", () => {
  test("a person parent must be inside the boundary", async () => {
    const db = fixtures({ users: [
      { _id: ME, name: "Me", email: "me@x.ai" },
      { _id: MATE, name: "Mate", email: "mate@x.ai" },
      { _id: "o".repeat(32), name: "Outsider", email: "o@x.ai" },
    ] });
    const ctx = ctxOf(db);
    await expect(performCreateRole(ctx, ME as any, { name: "A", handle: "aa", team_id: TEAM, reports_to: { kind: "user", user_id: "o".repeat(32) as any } }))
      .rejects.toThrow(/same workspace/);
    await expect(performCreateRole(ctx, ME as any, { name: "P", handle: "pp", reports_to: { kind: "user", user_id: MATE as any } }))
      .rejects.toThrow(/same workspace/);
    const ok = await performCreateRole(ctx, ME as any, { name: "A", handle: "aa", team_id: TEAM, reports_to: { kind: "user", user_id: MATE as any } });
    expect(ok.reports_to).toEqual({ kind: "user", user_id: MATE });
  });

  test("retire re-homes child roles to the retired role's parent and closes the seat", async () => {
    const db = fixtures();
    const ctx = ctxOf(db);
    const a = await performCreateRole(ctx, ME as any, { name: "A", handle: "aa", team_id: TEAM, reports_to: { kind: "user", user_id: MATE as any } });
    const b = await performCreateRole(ctx, ME as any, { name: "B", handle: "bb", team_id: TEAM, reports_to: { kind: "role", role_id: a._id } });
    const c = await performCreateRole(ctx, ME as any, { name: "C", handle: "cc", team_id: TEAM, reports_to: { kind: "role", role_id: b._id } });
    const retired = await performRetireRole(ctx, ME as any, { role_id: b._id });
    expect(retired.rehomed).toBe(1);
    expect((await db.get(c._id)).reports_to).toEqual({ kind: "role", role_id: a._id });
    expect((await db.get(a._id)).reports_to).toEqual({ kind: "user", user_id: MATE }); // untouched
    // A closed seat cannot be edited back to life; its handle is free again.
    await expect(performUpdateRole(ctx, ME as any, { role_id: b._id, status: "active" })).rejects.toThrow(/retired/);
    const reuse = await performCreateRole(ctx, ME as any, { name: "B2", handle: "bb", team_id: TEAM });
    expect(reuse.handle).toBe("bb");
  });

  test("refuses a cycle and accepts a legal move", async () => {
    const db = fixtures();
    const ctx = ctxOf(db);
    const a = await performCreateRole(ctx, ME as any, { name: "A", handle: "aa", team_id: TEAM });
    const b = await performCreateRole(ctx, ME as any, { name: "B", handle: "bb", team_id: TEAM, reports_to: { kind: "role", role_id: a._id } });
    const c = await performCreateRole(ctx, ME as any, { name: "C", handle: "cc", team_id: TEAM, reports_to: { kind: "role", role_id: b._id } });
    // a -> c would close a > b > c > a.
    await expect(performReparentRole(ctx, ME as any, { role_id: a.short_id, reports_to: { kind: "role", role_id: c._id } }))
      .rejects.toThrow(/Cycle/);
    await expect(performReparentRole(ctx, ME as any, { role_id: a._id, reports_to: { kind: "role", role_id: a._id } }))
      .rejects.toThrow(/Cycle/);
    const moved = await performReparentRole(ctx, ME as any, { role_id: c.short_id, reports_to: { kind: "role", role_id: a._id } });
    expect(moved.reports_to).toEqual({ kind: "role", role_id: a._id });
  });

  test("a plain member cannot reshape a team role; the host can", async () => {
    const db = fixtures();
    const ctx = ctxOf(db);
    const a = await performCreateRole(ctx, ME as any, { name: "A", handle: "aa", team_id: TEAM });
    await expect(performUpdateRole(ctx, MATE as any, { role_id: a._id, name: "Z" })).rejects.toThrow(/admin/);
    const renamed = await performUpdateRole(ctx, ME as any, { role_id: a._id, name: "Z" });
    expect(renamed.name).toBe("Z");
  });
});

describe("orgRoles.reparentSession + retire", () => {
  const conv = (over: Record<string, any> = {}) => ({
    _id: "c".repeat(32),
    session_id: "sess1",
    user_id: ME,
    team_id: TEAM,
    status: "active",
    title: "Fix auth",
    agent_type: "claude_code",
    message_count: 3,
    last_message_role: "assistant",
    updated_at: NOW - 60_000,
    ...over,
  });

  test("a role target sets org_role_id and leaves owners alone; retire clears it", async () => {
    const db = fixtures({ conversations: [conv()] });
    const ctx = ctxOf(db);
    const role = await performCreateRole(ctx, ME as any, { name: "A", handle: "aa", team_id: TEAM });
    const res = await performReparentSession(ctx, ME as any, { conversation_id: "c".repeat(32), target: { kind: "role", role_id: role.short_id } });
    expect(res.org_role_id).toBe(role._id);
    expect(db._tables.conversations[0].org_role_id).toBe(role._id);
    expect(db._tables.session_owners.length).toBe(0);

    const retired = await performRetireRole(ctx, ME as any, { role_id: role._id });
    expect(retired.status).toBe("retired");
    expect(retired.cleared).toBe(1);
    expect(db._tables.conversations[0].org_role_id).toBeUndefined();
  });

  test("a stranger to the session cannot file it; a team role refuses a session outside its team", async () => {
    const db = fixtures({ conversations: [conv({ user_id: MATE, is_private: true })] });
    const ctx = ctxOf(db);
    const personal = await performCreateRole(ctx, ME as any, { name: "P", handle: "pp" });
    // Not the runner, not an owner, and a personal role grants no reshape over MATE's row.
    await expect(performReparentSession(ctx, ME as any, { conversation_id: "c".repeat(32), target: { kind: "role", role_id: personal._id } }))
      .rejects.toThrow(/not one of its owners/);
    const other = await performCreateRole(ctx, MATE as any, { name: "Q", handle: "qq" });
    db._tables.conversations[0].team_id = undefined;
    const teamRole = await performCreateRole(ctx, ME as any, { name: "T", handle: "tt", team_id: TEAM });
    await expect(performReparentSession(ctx, MATE as any, { conversation_id: "c".repeat(32), target: { kind: "role", role_id: teamRole._id } }))
      .rejects.toThrow(/not in the role's team/);
    void other;
  });

  test("a user target goes through the owner path and clears the pointer", async () => {
    const db = fixtures({ conversations: [conv()] });
    const ctx = ctxOf(db);
    const role = await performCreateRole(ctx, ME as any, { name: "A", handle: "aa", team_id: TEAM });
    await performReparentSession(ctx, ME as any, { conversation_id: "c".repeat(32), target: { kind: "role", role_id: role._id } });
    const res = await performReparentSession(ctx, ME as any, { conversation_id: "c".repeat(32), target: { kind: "user", user_id: MATE as any } });
    expect(res.org_role_id).toBeNull();
    expect(db._tables.conversations[0].org_role_id).toBeUndefined();
    expect(db._tables.session_owners.map((r: any) => r.user_id)).toEqual([MATE]);
    expect(db._tables.conversations[0].owner_user_id).toBe(MATE);
  });
});

describe("org.tree", () => {
  test("personal workspace: the caller alone, rows inside the window, anchors under anchors and foreign standing rows dropped", async () => {
    const anchorConv = "a".repeat(32);
    const db = fixtures({
      anchors: [
        { _id: "anchors_mine", scope_type: "user", scope_user_id: ME, host_user_id: ME, bot_user_id: "b".repeat(32), conversation_id: anchorConv, name: "Anchor", status: "active", created_at: 1 },
      ],
      conversations: [
        { _id: "1".repeat(32), session_id: "s1", user_id: ME, status: "active", title: "Fresh", agent_type: "claude_code", message_count: 1, last_message_role: "assistant", updated_at: NOW - 1000 },
        { _id: "2".repeat(32), session_id: "s2", user_id: ME, status: "active", title: "Stale", agent_type: "claude_code", message_count: 1, last_message_role: "assistant", updated_at: NOW - 31 * 24 * 60 * 60 * 1000 },
        { _id: anchorConv, session_id: "s3", user_id: ME, status: "active", title: "Anchor", agent_type: "claude_code", message_count: 1, last_message_role: "assistant", updated_at: NOW - 500, anchor_id: "anchors_mine" },
        // A standing row whose anchor is not in this workspace (decommissioned).
        { _id: "4".repeat(32), session_id: "s4", user_id: ME, status: "active", title: "Old anchor", agent_type: "claude_code", message_count: 1, last_message_role: "assistant", updated_at: NOW - 400, anchor_id: "anchors_gone" },
      ],
    });
    const tree = await computeOrgTree(ctxOf(db), ME as any, undefined, NOW);
    expect(tree.workspace.kind).toBe("user");
    expect(tree.people.map((p: any) => p.user_id)).toEqual([ME]);
    expect(tree.people[0]!.sessions.map((s: any) => s.title)).toEqual(["Fresh"]);
    expect(tree.anchors.length).toBe(1);
    expect(tree.anchors[0].short_id ?? null).toBeNull();
    expect(tree.anchors[0].state).toBeDefined();
  });


  test("files a session under its role, the rest under their owner, and counts subagents", async () => {
    const parentId = "p".repeat(32);
    const db = fixtures({
      conversations: [
        { _id: parentId, session_id: "s1", user_id: ME, team_id: TEAM, status: "active", title: "Lead", agent_type: "claude_code", message_count: 4, last_message_role: "assistant", updated_at: NOW - 1000 },
        { _id: "k".repeat(32), session_id: "s2", user_id: ME, team_id: TEAM, status: "active", title: "Kid", agent_type: "claude_code", message_count: 2, last_message_role: "assistant", updated_at: NOW - 500, is_subagent: true, parent_conversation_id: parentId },
        { _id: "o".repeat(32), session_id: "s3", user_id: MATE, team_id: TEAM, status: "active", title: "Mate's", agent_type: "codex", is_private: false, message_count: 1, last_message_role: "user", updated_at: NOW - 2000 },
        // Killed and dismissed rows never enter the tree.
        { _id: "x".repeat(32), session_id: "s4", user_id: ME, team_id: TEAM, status: "active", title: "Dead", agent_type: "claude_code", message_count: 1, last_message_role: "assistant", updated_at: NOW - 100, inbox_killed_at: NOW - 50 },
      ],
    });
    const ctx = ctxOf(db);
    const role = await performCreateRole(ctx, ME as any, { name: "Growth", handle: "growth", team_id: TEAM });
    await performReparentSession(ctx, ME as any, { conversation_id: parentId, target: { kind: "role", role_id: role._id } });

    const tree = await computeOrgTree(ctx, ME as any, TEAM, NOW);
    expect(tree.workspace).toEqual({ kind: "team", id: TEAM, name: "Acme" });
    expect(tree.truncated).toBe(false);

    const growth = tree.roles.find((r: any) => r.handle === "growth")!;
    expect(growth.total).toBe(1);
    expect(growth.sessions[0].title).toBe("Lead");
    expect(growth.sessions[0].subagent_count).toBe(1);
    expect(growth.sessions[0].org_role_id).toBe(role._id);
    expect(["needs_input", "working", "done", "dormant", "idle"]).toContain(growth.sessions[0].state);

    const me = tree.people.find((p: any) => p.user_id === ME)!;
    expect(me.is_me).toBe(true);
    expect(me.role).toBe("admin");
    expect(me.total).toBe(0); // its one session moved under the role; the killed row is gone
    const mate = tree.people.find((p: any) => p.user_id === MATE)!;
    expect(mate.total).toBe(1);
    expect(mate.sessions[0].title).toBe("Mate's");
    expect(mate.counts[mate.sessions[0].state]).toBe(1);
    // The subagent is counted, never emitted.
    const all = [...tree.people, ...tree.roles].flatMap((n: any) => n.sessions.map((s: any) => s.title));
    expect(all).not.toContain("Kid");
  });
});
