import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { applyRole, applyScope, previewTakeover, takeOverSessions, takeoverPhrase } from "./orgInit";
import { performCreateRole } from "./orgRoles";

// Taking over a scope takes over its sessions (org-roles-run-work.md R1): the
// apply that gives a role a scope files the host's unowned sessions in it
// under the role, and the note says so before and after.

const ME = "u".repeat(31) + "m"; // team admin, the host
const MATE = "u".repeat(31) + "t";
const TEAM = "teams_acme" as any;
const WS = `team:${TEAM}`;
const NOW = 1_800_000_000_000;
const P = "projects_p";

const conv = (n: number, over: Record<string, any> = {}) => ({
  _id: `conversations_s${n}`,
  short_id: `jx7000${n}`,
  user_id: ME,
  team_id: TEAM,
  status: "active",
  agent_type: "claude_code",
  title: `Growth work ${n}`,
  project_path: "/repo/growth",
  message_count: 3,
  last_message_role: "assistant",
  updated_at: NOW - 60_000,
  created_at: 1,
  ...over,
});

function fixtures() {
  return makeFakeDb({
    users: [{ _id: ME, name: "Me", email: "me@x.ai" }, { _id: MATE, name: "Mate", email: "mate@x.ai" }],
    team_memberships: [
      { _id: "m1", user_id: ME, team_id: TEAM, role: "admin", joined_at: 1 },
      { _id: "m2", user_id: MATE, team_id: TEAM, role: "member", joined_at: 1 },
    ],
    teams: [{ _id: TEAM, name: "Acme" }],
    counters: [],
    org_roles: [],
    org_role_history: [],
    role_wakes: [],
    role_wake_outbox: [],
    anchors: [],
    projects: [
      { _id: P, user_id: ME, team_id: TEAM, workspace: WS, short_id: "pr-1", title: "Growth", status: "active", project_path: "/repo/growth", created_at: 1, updated_at: NOW },
      { _id: "projects_q", user_id: ME, team_id: TEAM, workspace: WS, short_id: "pr-2", title: "Billing", status: "active", project_path: "/repo/billing", created_at: 1, updated_at: NOW },
    ],
    plans: [],
    tasks: [],
    docs: [],
    conversations: [
      conv(1),
      conv(2),
      conv(3, { user_id: MATE }), // a teammate's session on the same path: stays theirs
      conv(4, { project_path: "/repo/billing" }), // the host's, outside the scope: stays
    ],
    session_owners: [],
    session_decisions: [],
    managed_sessions: [],
    messages: [],
    user_presence: [],
    pending_messages: [],
    devices: [],
  });
}

const ctxOf = (db: any) => ({ db }) as any;
const BOUNDARY = { team_id: TEAM };
const OPTS = { provision: false, human_decision: "sd-1" };
const roleOf = (db: any, n: number) => db._tables.conversations.find((c: any) => c._id === `conversations_s${n}`).org_role_id;

describe("a scope change takes over the sessions in it", () => {
  test("the note before accept and the note after apply say the same thing; the rows moved", async () => {
    const db = fixtures();
    const ctx = ctxOf(db);
    // A role with no projects looks after the whole workspace and takes nothing.
    const role = await performCreateRole(ctx, ME as any, { name: "Growth", handle: "growth", team_id: TEAM });
    expect(await takeOverSessions(ctx, ME as any, role._id)).toBeNull();

    const res = await applyScope(ctx, ME as any, BOUNDARY, { kind: "scope", handle: "@growth", add: ["pr-1"] }, OPTS);
    expect(res.status).toBe("applied");
    const note = (res as any).note as string;
    expect(note).toContain("2 sessions now report to @growth and leave your needs input");
    expect(note).toMatch(/\d told now/);
    expect(roleOf(db, 1)).toBe(role._id);
    expect(roleOf(db, 2)).toBe(role._id);
    expect(roleOf(db, 3)).toBeUndefined();
    expect(roleOf(db, 4)).toBeUndefined();
    // Each moved session was told once, through the reparent core's line.
    const told = db._tables.pending_messages.filter((m: any) => String(m.content).includes("You now report to Growth."));
    expect(told.length).toBe(2);
  });

  test("the dry count is the sentence a person reads before accepting, and writes nothing", async () => {
    const db = fixtures();
    const ctx = ctxOf(db);
    const role = await performCreateRole(ctx, ME as any, { name: "Growth", handle: "growth", team_id: TEAM, scope: { project_ids: [P as any], plan_ids: [] } });
    const dry = await takeOverSessions(ctx, ME as any, role._id, { dry: true });
    expect(takeoverPhrase("growth", dry, false)).toBe("2 sessions now report to @growth and leave your needs input");
    expect(roleOf(db, 1)).toBeUndefined();
    expect(db._tables.pending_messages.length).toBe(0);
  });

  test("a proposed role has no row yet: the preview reads its scope, with the person applying as the host", async () => {
    const db = fixtures();
    const ctx = ctxOf(db);
    const r = await previewTakeover(ctx, ME as any, BOUNDARY, { handle: "@growth", add: ["pr-1"] });
    expect([...(r?.sessions ?? [])].sort()).toEqual(["jx70001", "jx70002"]);
    // A live role that gains a ref counts only what would newly move.
    const role = await performCreateRole(ctx, ME as any, { name: "Growth", handle: "growth", team_id: TEAM, scope: { project_ids: [P as any], plan_ids: [] } });
    await takeOverSessions(ctx, ME as any, role._id);
    const next = await previewTakeover(ctx, ME as any, BOUNDARY, { handle: "@growth", add: ["pr-2"] });
    expect(next?.sessions).toEqual(["jx70004"]);
    expect(db._tables.conversations.find((c: any) => c.short_id === "jx70004").org_role_id).toBeUndefined();
  });

  test("leave_sessions is the person's one edit: the scope lands and the sessions stay", async () => {
    const db = fixtures();
    const ctx = ctxOf(db);
    await performCreateRole(ctx, ME as any, { name: "Growth", handle: "growth", team_id: TEAM });
    const res = await applyScope(ctx, ME as any, BOUNDARY, { kind: "scope", handle: "@growth", add: ["pr-1"], leave_sessions: true }, OPTS);
    expect((res as any).note).not.toContain("now report");
    expect(roleOf(db, 1)).toBeUndefined();
  });

  test("a new role with projects takes over on create", async () => {
    const db = fixtures();
    const ctx = ctxOf(db);
    const res = await applyRole(ctx, ME as any, BOUNDARY, { kind: "role", name: "Growth", handle: "growth", scope: { projects: ["pr-1"] } } as any, undefined, OPTS);
    expect((res as any).note).toContain("2 sessions now report to @growth");
    expect(roleOf(db, 1)).toBeDefined();
  });
});
