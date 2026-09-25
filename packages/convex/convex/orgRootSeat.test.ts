import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { CHIEF_OF_STAFF_HANDLE, performRetireRole, performStaff, staffTeamFor } from "./orgRoles";
import { performSeatRootRoles, planRootSeats } from "./orgRootSeat";

// One agent at the root (docs/architecture/org-staffing.md S22): the run seats
// every workspace's standing agent as its root role through the S16 seating,
// team and personal alike, once, and leaves alone what a person must decide.

const ME = "u".repeat(31) + "m";
const YOU = "u".repeat(31) + "y";
const BOT_T = "u".repeat(31) + "b";
const BOT_P = "u".repeat(31) + "p";
const TEAM = "teams_acme" as any;
const NOW = 1_800_000_000_000;

function world() {
  const tables: Record<string, any[]> = {
    users: [
      { _id: ME, name: "Me", email: "me@x.ai", github_username: "me" },
      { _id: YOU, name: "You", email: "you@x.ai" },
      { _id: BOT_T, name: "Anchor", is_bot: true, bot_kind: "anchor" },
      { _id: BOT_P, name: "Anchor", is_bot: true, bot_kind: "anchor" },
    ],
    team_memberships: [
      { _id: "m1", user_id: ME, team_id: TEAM, role: "admin", joined_at: 1 },
      { _id: "m2", user_id: BOT_T, team_id: TEAM, role: "member", joined_at: 1, visibility: "full" },
    ],
    teams: [{ _id: TEAM, name: "Acme" }],
    counters: [],
    org_roles: [],
    anchors: [
      { _id: "anchor-t", scope_type: "team", team_id: TEAM, bot_user_id: BOT_T, host_user_id: ME, name: "Anchor", status: "active", conversation_id: "conv-t", project_path: "/repo", created_at: 1, updated_at: 1 },
      { _id: "anchor-p", scope_type: "user", scope_user_id: YOU, bot_user_id: BOT_P, host_user_id: YOU, name: "Anchor", status: "active", conversation_id: "conv-p", created_at: 1, updated_at: 1 },
      // Never came online: nothing to seat.
      { _id: "anchor-n", scope_type: "user", scope_user_id: ME, bot_user_id: BOT_P, host_user_id: ME, name: "Anchor", status: "provisioning", created_at: 1, updated_at: 1 },
      // Retired: passed over.
      { _id: "anchor-d", scope_type: "team", team_id: TEAM, bot_user_id: BOT_T, host_user_id: ME, name: "Anchor", status: "decommissioned", conversation_id: "conv-d", created_at: 1, updated_at: 1 },
    ],
    conversations: [
      { _id: "conv-t", user_id: ME, acting_user_id: BOT_T, anchor_id: "anchor-t", session_id: "s-t", short_id: "jxanct1", title: "Anchor", title_is_custom: true, status: "active", agent_type: "claude_code", updated_at: NOW, message_count: 9, team_id: TEAM, is_private: false, persistent: true, project_path: "/repo" },
      { _id: "conv-p", user_id: YOU, acting_user_id: BOT_P, anchor_id: "anchor-p", session_id: "s-p", short_id: "jxancp1", title: "Anchor", title_is_custom: true, status: "active", agent_type: "claude_code", updated_at: NOW, message_count: 3, is_private: true, persistent: true },
      { _id: "conv-d", user_id: ME, acting_user_id: BOT_T, anchor_id: "anchor-d", session_id: "s-d", short_id: "jxancd1", status: "completed", agent_type: "claude_code", updated_at: NOW, message_count: 1, team_id: TEAM },
    ],
    agent_tasks: [],
    pending_messages: [],
    managed_sessions: [],
    session_owners: [],
    messages: [],
    user_presence: [],
    devices: [],
    docs: [],
    projects: [],
    plans: [],
    tasks: [],
    session_decisions: [],
  };
  const db = makeFakeDb(tables);
  const ctx: any = { db, scheduler: { runAfter: async () => {} } };
  return { ctx, tables };
}

// A mutation's writes commit together or not at all. The fake db has no
// transaction, so this models the platform's rollback: every table is
// snapshotted before the run and put back when it throws.
async function atomic<T>(tables: Record<string, any[]>, run: () => Promise<T>): Promise<T> {
  const before = Object.fromEntries(Object.entries(tables).map(([k, rows]) => [k, rows.map((r) => ({ ...r }))]));
  try {
    return await run();
  } catch (e) {
    for (const [k, rows] of Object.entries(before)) tables[k].splice(0, tables[k].length, ...rows);
    throw e;
  }
}

describe("orgRootSeat", () => {
  test("the plan names every live anchor with what the run will do, and touches nothing", async () => {
    const { ctx, tables } = world();
    const plan = await planRootSeats(ctx);
    expect(plan.map((r) => [r.workspace, r.kind, r.action])).toEqual([
      ["Acme", "team", "seat"],
      ["You (personal)", "user", "seat"],
      ["Me (personal)", "user", "no_session"],
    ]);
    expect(tables.org_roles).toHaveLength(0);
    expect(tables.pending_messages).toHaveLength(0);
  });

  test("seats each workspace's anchor as its root role through the S16 seating: nothing restarts, personal too, and a second run is a no-op", async () => {
    const { ctx, tables } = world();
    const before = { anchors: tables.anchors.length, users: tables.users.length, conversations: tables.conversations.length };
    const out = await performSeatRootRoles(ctx, false);
    expect(out.seated).toBe(2);
    expect(before).toEqual({ anchors: tables.anchors.length, users: tables.users.length, conversations: tables.conversations.length });

    const roles = tables.org_roles;
    expect(roles).toHaveLength(2);
    for (const role of roles) expect(role.handle).toBe(CHIEF_OF_STAFF_HANDLE);
    const teamRole = roles.find((r) => r.team_id === TEAM)!;
    const personalRole = roles.find((r) => !r.team_id)!;
    expect(teamRole.reports_to).toEqual({ kind: "user", user_id: ME });
    expect(personalRole.reports_to).toEqual({ kind: "user", user_id: YOU });
    expect(personalRole.scope_user_id).toBe(YOU);

    // The anchor rows are the seats; the sessions carry the standing marker and the role's name.
    expect(String(tables.anchors.find((a) => a._id === "anchor-t")!.org_role_id)).toBe(String(teamRole._id));
    expect(String(tables.anchors.find((a) => a._id === "anchor-p")!.org_role_id)).toBe(String(personalRole._id));
    const convT = tables.conversations.find((c) => c._id === "conv-t")!;
    expect(String(convT.standing_role_id)).toBe(String(teamRole._id));
    expect(convT.title).toBe("Chief of Staff");
    expect(convT.seat_previous).toEqual({ title: "Anchor", title_is_custom: true });
    expect(tables.users.find((u) => u._id === BOT_T)?.bot_kind).toBe("role");
    // The seating note and the briefing land in the thread; the review is armed on it.
    expect(tables.pending_messages.filter((p) => p.conversation_id === "conv-t").length).toBeGreaterThanOrEqual(2);
    expect(tables.agent_tasks.some((t) => t.originating_conversation_id === "conv-t")).toBe(true);
    expect(tables.agent_tasks.some((t) => t.originating_conversation_id === "conv-p")).toBe(true);

    // Idempotent: the same run again seats nothing and mints nothing.
    const again = await performSeatRootRoles(ctx, false);
    expect(again.seated).toBe(0);
    expect(again.rows.filter((r) => r.action === "seat")).toEqual([]);
    expect(again.rows.map((r) => r.action)).toEqual(["seated", "seated", "no_session"]);
    expect(tables.org_roles).toHaveLength(2);
    expect(tables.agent_tasks).toHaveLength(2);
  });

  test("a workspace whose root role already stands in another session is left for a person", async () => {
    const { ctx, tables } = world();
    // A chief seated fresh earlier, with the old anchor still alive beside it.
    tables.conversations.push({ _id: "mine", user_id: ME, session_id: "s-mine", short_id: "jxmine1", status: "active", agent_type: "claude_code", updated_at: NOW, message_count: 4, team_id: TEAM, project_path: "/repo" });
    await performStaff(ctx, ME as any, { team_id: TEAM, adopt_conversation_id: "jxmine1" });
    const plan = await planRootSeats(ctx);
    const acme = plan.find((r) => r.anchor_id === "anchor-t")!;
    expect(acme.action).toBe("two_roots");
    expect(acme.root_role).toBeDefined();
    const out = await performSeatRootRoles(ctx, false);
    expect(out.seated).toBe(1);
    expect(tables.anchors.find((a) => a._id === "anchor-t")!.org_role_id).toBeUndefined();
  });

  test("the run is all or nothing: a seating that fails throws, and the workspace seated before it keeps no row", async () => {
    const { ctx, tables } = world();
    // The second anchor's row is inconsistent: its team scope names a team
    // its host is not a member of, so performCreateRole refuses it. It sorts
    // after Acme, whose seat has already been made when it throws.
    const bad = tables.anchors.find((a) => a._id === "anchor-p")!;
    bad.scope_type = "team"; bad.team_id = "teams_other";
    let rowsBeforeThrow = -1;
    await expect(atomic(tables, () => performSeatRootRoles(ctx, false).catch((e) => { rowsBeforeThrow = tables.org_roles.length; throw e; }))).rejects.toThrow("not a member");
    // Acme's seat had been made when the throw came; the rollback took it with it.
    expect(rowsBeforeThrow).toBe(1);
    expect(tables.org_roles).toHaveLength(0);
    expect(tables.anchors.find((a) => a._id === "anchor-t")!.org_role_id).toBeUndefined();
    expect(tables.conversations.find((c) => c._id === "conv-t")!.standing_role_id).toBeUndefined();
    expect(tables.pending_messages).toHaveLength(0);
  });

  test("a root a person retired while keeping the agent is seated under a fresh root, and the plan says which seat it replaces", async () => {
    const { ctx, tables } = world();
    await performStaff(ctx, ME as any, { team_id: TEAM });
    const first = tables.org_roles[0];
    await performRetireRole(ctx, ME as any, { role_id: String(first._id), standing_session: "keep" });
    expect(tables.anchors.find((a) => a._id === "anchor-t")!.org_role_id).toBeUndefined();
    const plan = await planRootSeats(ctx);
    const acme = plan.find((r) => r.anchor_id === "anchor-t")!;
    expect(acme.action).toBe("retired_root");
    expect(acme.retired_root).toEqual({ short_id: first.short_id, handle: CHIEF_OF_STAFF_HANDLE });
    const out = await performSeatRootRoles(ctx, false);
    expect(out.seated).toBe(2);
    const live = tables.org_roles.filter((r) => r.team_id === TEAM && r.status !== "retired");
    expect(live).toHaveLength(1);
    expect(String(tables.anchors.find((a) => a._id === "anchor-t")!.org_role_id)).toBe(String(live[0]._id));
  });

  test("a staff write names its team outright; a team scope with no team is refused", () => {
    expect(staffTeamFor("team", TEAM)).toBe(TEAM);
    expect(staffTeamFor("user", TEAM)).toBeUndefined();
    expect(staffTeamFor(undefined, TEAM)).toBe(TEAM);
    expect(() => staffTeamFor("team", undefined)).toThrow("needs its team");
  });

  test("a run told which workspaces to seat seats those and holds the rest, and the held ones seat on a later run", async () => {
    const { ctx, tables } = world();
    const out = await performSeatRootRoles(ctx, false, new Set(["anchor-t"]));
    expect(out.seated).toBe(1);
    expect(out.rows.map((r) => [r.anchor_id, r.action, r.held ?? false])).toEqual([
      ["anchor-t", "seated", false],
      ["anchor-p", "seat", true],
      ["anchor-n", "no_session", false],
    ]);
    expect(tables.org_roles).toHaveLength(1);
    expect(tables.anchors.find((a) => a._id === "anchor-p")!.org_role_id).toBeUndefined();
    expect(tables.pending_messages.some((p) => p.conversation_id === "conv-p")).toBe(false);
    // Without the filter, the held one is seated and the first is passed over.
    const later = await performSeatRootRoles(ctx, false);
    expect(later.seated).toBe(1);
    expect(tables.org_roles).toHaveLength(2);
  });
});
