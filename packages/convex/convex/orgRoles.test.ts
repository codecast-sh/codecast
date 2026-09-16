import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import {
  performCreateRole,
  performReparentRole,
  performReparentSession,
  performRetireRole,
  performUpdateRole,
} from "./orgRoles";
import { computeOrgTree, stateOf } from "./org";

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
    pending_messages: [],
    devices: [],
    anchors: [],
    role_wake_outbox: [],
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
    const res = await performReparentSession(ctx, ME as any, { session_id: "c".repeat(32), target: { kind: "role", role_id: role.short_id } });
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
    await expect(performReparentSession(ctx, ME as any, { session_id: "c".repeat(32), target: { kind: "role", role_id: personal._id } }))
      .rejects.toThrow(/not one of its owners/);
    const other = await performCreateRole(ctx, MATE as any, { name: "Q", handle: "qq" });
    db._tables.conversations[0].team_id = undefined;
    const teamRole = await performCreateRole(ctx, ME as any, { name: "T", handle: "tt", team_id: TEAM });
    await expect(performReparentSession(ctx, MATE as any, { session_id: "c".repeat(32), target: { kind: "role", role_id: teamRole._id } }))
      .rejects.toThrow(/not in the role's team/);
    void other;
  });

  test("a user target goes through the owner path and clears the pointer", async () => {
    const db = fixtures({ conversations: [conv()] });
    const ctx = ctxOf(db);
    const role = await performCreateRole(ctx, ME as any, { name: "A", handle: "aa", team_id: TEAM });
    await performReparentSession(ctx, ME as any, { session_id: "c".repeat(32), target: { kind: "role", role_id: role._id } });
    const res = await performReparentSession(ctx, ME as any, { session_id: "c".repeat(32), target: { kind: "user", user_id: MATE as any } });
    expect(res.org_role_id).toBeNull();
    expect(db._tables.conversations[0].org_role_id).toBeUndefined();
    expect(db._tables.session_owners.map((r: any) => r.user_id)).toEqual([MATE]);
    expect(db._tables.conversations[0].owner_user_id).toBe(MATE);
  });

  // org-staffing.md S11: the ownership menu and the chart are one gesture.
  test("adding an owner re-homes the session under that person and clears the role pointer; the session is told once", async () => {
    const db = fixtures({ conversations: [conv()], session_owners: [{ _id: "so1", conversation_id: "c".repeat(32), user_id: ME, added_by: ME, added_at: 1 }] });
    const ctx = ctxOf(db);
    const role = await performCreateRole(ctx, ME as any, { name: "Growth", handle: "growth", team_id: TEAM });
    const filed = await performReparentSession(ctx, ME as any, { session_id: "sess1", target: { kind: "role", role_id: role._id } });
    expect(filed.reports_to).toMatchObject({ kind: "role", name: "Growth" });
    expect(filed.told).toEqual({ sessions: 1, roles: 0 });

    // `cast own`: Mate is added, keeps Me as an owner, and the chart follows Mate.
    const res = await performReparentSession(ctx, ME as any, { session_id: "sess1", target: { kind: "user", owners: ["mate@x.ai"], mode: "add" }, note: "Take it from here." });
    expect(res.org_role_id).toBeNull();
    expect(db._tables.conversations[0].org_role_id).toBeUndefined();
    expect(db._tables.session_owners.map((r: any) => r.user_id).sort()).toEqual([ME, MATE].sort());
    expect(db._tables.conversations[0].owner_user_id).toBe(MATE);
    expect(res.reports_to).toEqual({ kind: "user", user_id: MATE, name: "Mate" });
    expect(res.told).toEqual({ sessions: 1, roles: 0 });

    // The line rides the session message rail, from the acting person, with the note.
    const pending = db._tables.pending_messages;
    expect(pending).toHaveLength(2);
    expect(pending[0].content).toBe(`<session-message from="unknown" name="Me">\nYou now report to Growth.\n</session-message>`);
    expect(pending[1].content).toBe(`<session-message from="unknown" name="Me">\nYou now report to Mate. Take it from here.\n</session-message>`);
    expect(pending[1].from_user_id).toBe(ME);
    expect(pending[1].conversation_id).toBe("c".repeat(32));

    // A move that changes nothing tells nobody.
    const again = await performReparentSession(ctx, ME as any, { session_id: "sess1", target: { kind: "user", owners: ["mate@x.ai"], mode: "add" } });
    expect(again.told).toEqual({ sessions: 0, roles: 0 });
    expect(db._tables.pending_messages).toHaveLength(2);

    // Removing an owner is not a re-homing: Mate leaves, Me is the line again, and the session hears it.
    const gone = await performReparentSession(ctx, ME as any, { session_id: "sess1", target: { kind: "user", owners: ["mate@x.ai"], mode: "remove" } });
    expect(gone.removed).toEqual([MATE]);
    expect(db._tables.conversations[0].owner_user_id).toBe(ME);
    expect(gone.told).toEqual({ sessions: 1, roles: 0 });
  });

  test("the acting person's own session signs the line; a bot still cannot own", async () => {
    const BOT = "u".repeat(31) + "b";
    const db = fixtures({
      conversations: [conv(), conv({ _id: "d".repeat(32), session_id: "sess2", short_id: "jxactor" })],
      users: [{ _id: ME, name: "Me", email: "me@x.ai" }, { _id: MATE, name: "Mate", email: "mate@x.ai" }, { _id: BOT, name: "Anchor", is_bot: true }],
    });
    db._tables.team_memberships.push({ _id: "m3", user_id: BOT, team_id: TEAM, role: "member", joined_at: 1 });
    const ctx = ctxOf(db);
    const res = await performReparentSession(ctx, ME as any, { session_id: "sess1", target: { kind: "user", user_id: MATE as any }, from_session: "jxactor" });
    expect(res.told.sessions).toBe(1);
    expect(db._tables.pending_messages[0].content).toBe(`<session-message from="jxactor" name="Me">\nYou now report to Mate.\n</session-message>`);
    await expect(performReparentSession(ctx, ME as any, { session_id: "sess1", target: { kind: "user", owners: ["Anchor"], mode: "add" } }))
      .rejects.toThrow(/agent account/);
  });

  test("a role move wakes the role with the same line and rides each hand as a passive fact", async () => {
    const db = fixtures({
      anchors: [{ _id: "anchor-g", scope_type: "team", team_id: TEAM, bot_user_id: "bot-g", host_user_id: ME, name: "Growth", status: "active", conversation_id: "standing-g", org_role_id: "role-g" }],
      conversations: [
        conv({ _id: "standing-g", session_id: "s-g", standing_role_id: "role-g", anchor_id: "anchor-g" }),
        conv({ _id: "hand-1", session_id: "s-h1", short_id: "jxhand1", org_role_id: "role-g" }),
        conv({ _id: "hand-2", session_id: "s-h2", short_id: "jxhand2", org_role_id: "role-g", status: "completed" }),
      ],
      org_roles: [
        { _id: "role-g", short_id: "or-1", scope_type: "team", team_id: TEAM, host_user_id: ME, name: "Growth", handle: "growth", scope: { project_ids: [], plan_ids: [] }, reports_to: { kind: "user", user_id: ME }, status: "active", anchor_id: "anchor-g", created_by: ME, created_at: 1, updated_at: 1 },
        { _id: "role-o", short_id: "or-2", scope_type: "team", team_id: TEAM, host_user_id: ME, name: "Ops", handle: "ops", scope: { project_ids: [], plan_ids: [] }, reports_to: { kind: "user", user_id: ME }, status: "active", created_by: ME, created_at: 1, updated_at: 1 },
      ],
    });
    const scheduled: any[] = [];
    const ctx: any = { db, scheduler: { runAfter: async (delay: number, _fn: any, args: any) => { scheduled.push({ delay, args }); } } };
    const moved = await performReparentRole(ctx, ME as any, { role_id: "or-1", reports_to: { kind: "role", role_id: "role-o" as any }, note: "Ops owns growth now." });
    expect(moved.told).toEqual({ sessions: 1, roles: 1 });
    const rows = db._tables.role_wake_outbox.filter((r: any) => r.role_id === "role-g");
    expect(rows.map((r: any) => r.kind)).toEqual(["immediate", "passive"]);
    expect(rows[0].cause).toBe("reporting line: You now report to Ops (@ops). Ops owns growth now. (Me moved the role)");
    expect(rows[1].cause).toBe("hand jxhand1: You now report to Ops (@ops). Ops owns growth now.");
    expect(rows[1].ref).toEqual({ table: "conversations", id: "hand-1", short_id: "jxhand1" });
    expect(scheduled).toHaveLength(1);
    // A no-op move logs nothing and tells nobody.
    const same = await performReparentRole(ctx, ME as any, { role_id: "or-1", reports_to: { kind: "role", role_id: "role-o" as any } });
    expect(same.told).toEqual({ sessions: 0, roles: 0 });
    expect(db._tables.role_wake_outbox).toHaveLength(2);
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
    await performReparentSession(ctx, ME as any, { session_id: parentId, target: { kind: "role", role_id: role._id } });
    // Telling the session (S11) stamps it with the wall clock; the tree is
    // computed at the fixture's NOW, so put the row back inside the window.
    db._tables.conversations.find((c: any) => c._id === parentId)!.updated_at = NOW - 1000;

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

describe("org.tree standing state", () => {
  // The 07:00 scene (docs/architecture/org-roles-standing.md): the phone
  // shows the anchor's line, and each lead is coloured by its own declared
  // status, not by a tally of its hands. The tree therefore carries the
  // standing session's pinned state on the anchor row and on its role.
  const anchorConv = "a".repeat(32);
  const quietConv = "q".repeat(32);
  const ANCHOR = "anchors_growth";
  const QUIET = "anchors_infra";

  test("a role and its anchor carry the standing session's line, status and stamp; a quiet standing row is read directly", async () => {
    const db = fixtures({
      org_roles: [
        { _id: "role_growth", short_id: "or-1", scope_type: "team", team_id: TEAM, host_user_id: ME, name: "Growth", handle: "growth", scope: { project_ids: [], plan_ids: [] }, reports_to: { kind: "user", user_id: ME }, status: "active", created_by: ME, created_at: 1, updated_at: 1 },
        { _id: "role_infra", short_id: "or-2", scope_type: "team", team_id: TEAM, host_user_id: ME, name: "Infra", handle: "infra", scope: { project_ids: [], plan_ids: [] }, reports_to: { kind: "user", user_id: ME }, status: "active", anchor_id: QUIET, created_by: ME, created_at: 1, updated_at: 1 },
        { _id: "role_bare", short_id: "or-3", scope_type: "team", team_id: TEAM, host_user_id: ME, name: "Bare", handle: "bare", scope: { project_ids: [], plan_ids: [] }, reports_to: { kind: "user", user_id: ME }, status: "active", created_by: ME, created_at: 1, updated_at: 1 },
      ],
      anchors: [
        // Names its role; its standing row is recent, so the scan holds it.
        { _id: ANCHOR, scope_type: "team", team_id: TEAM, host_user_id: ME, bot_user_id: "b".repeat(32), conversation_id: anchorConv, org_role_id: "role_growth", name: "Growth lead", status: "active", created_at: 1 },
        // Named by its role only; its standing row is older than the scan
        // window, so the tree must read it directly.
        { _id: QUIET, scope_type: "team", team_id: TEAM, host_user_id: ME, bot_user_id: "c".repeat(32), conversation_id: quietConv, name: "Infra lead", status: "active", created_at: 1 },
      ],
      conversations: [
        { _id: anchorConv, session_id: "s1", user_id: ME, team_id: TEAM, status: "active", title: "Growth lead", agent_type: "claude_code", message_count: 3, last_message_role: "assistant", updated_at: NOW - 500, anchor_id: ANCHOR,
          thread_state: "Status: Rewriting the weekly review\nNext: post it Friday", thread_state_status: "working", thread_state_at: NOW - 400 },
        { _id: quietConv, session_id: "s2", user_id: ME, team_id: TEAM, status: "active", title: "Infra lead", agent_type: "claude_code", message_count: 3, last_message_role: "assistant", updated_at: NOW - 40 * 24 * 60 * 60 * 1000, anchor_id: QUIET,
          thread_state: "Rotating the prod key\nBlocked: needs the new key from Ashot", thread_state_status: "blocked", thread_state_at: NOW - 3_600_000 },
      ],
    });
    const tree = await computeOrgTree(ctxOf(db), ME as any, TEAM, NOW);

    const growthAnchor = tree.anchors.find((a: any) => a.anchor_id === ANCHOR)!;
    expect(growthAnchor.state_line).toBe("Rewriting the weekly review"); // the label is dropped, the line stays
    expect(growthAnchor.state_status).toBe("working");
    expect(growthAnchor.state_at).toBe(NOW - 400);

    const growth = tree.roles.find((r: any) => r.handle === "growth")!;
    expect(growth.standing).toEqual({
      conversation_id: anchorConv, short_id: undefined, state: growthAnchor.state,
      state_line: "Rewriting the weekly review", state_status: "working", state_at: NOW - 400,
    });

    // The quiet standing row never entered the scan, yet its role and anchor
    // still carry its state, and the role's colour is its own declared status.
    const infra = tree.roles.find((r: any) => r.handle === "infra")!;
    expect(infra.standing?.state_line).toBe("Rotating the prod key");
    expect(infra.standing?.state_status).toBe("blocked");
    expect(infra.standing?.state).toBeUndefined();
    expect(tree.anchors.find((a: any) => a.anchor_id === QUIET)!.state_status).toBe("blocked");

    // A role with no standing agent says so, rather than borrowing a hand's state.
    expect(tree.roles.find((r: any) => r.handle === "bare")!.standing).toBeNull();
  });

  test("an unknown status word and an empty pinned state read as absent", () => {
    expect(stateOf({ thread_state: "\n\n", thread_state_status: "purple" })).toEqual({ state_line: null, state_status: null, state_at: null });
    expect(stateOf(null)).toEqual({ state_line: null, state_status: null, state_at: null });
  });
});
