import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { performCreateRole } from "./orgRoles";
import { releaseFolderHeld } from "./migrations";

// migrations:releaseFolderHeldSessions (org-staffing.md S35): what a lead
// holds only through the folder rule goes back to its starter; what it holds
// for a reason is kept and stamped with the reason.

const ME = "u".repeat(31) + "m";
const TEAM = "teams_acme" as any;
const WS = `team:${TEAM}`;
const NOW = 1_800_000_000_000;
const P = "projects_p";

const conv = (n: number, over: Record<string, any> = {}) => ({
  _id: `conversations_s${n}`, short_id: `jx7000${n}`, user_id: ME, team_id: TEAM, status: "active", agent_type: "claude_code",
  title: `Work ${n}`, project_path: "/repo/growth", message_count: 3, last_message_role: "assistant", updated_at: NOW - 60_000, created_at: 1, ...over,
});

function fixtures() {
  return makeFakeDb({
    users: [{ _id: ME, name: "Me", email: "me@x.ai" }],
    team_memberships: [{ _id: "m1", user_id: ME, team_id: TEAM, role: "admin", joined_at: 1 }],
    teams: [{ _id: TEAM, name: "Acme" }],
    counters: [], org_roles: [], org_role_history: [], anchors: [],
    projects: [{ _id: P, user_id: ME, team_id: TEAM, workspace: WS, short_id: "pr-1", title: "Growth", status: "active", project_path: "/repo/growth", created_at: 1, updated_at: NOW }],
    plans: [],
    tasks: [{ _id: "tasks_growth", short_id: "ct-1", title: "grow", user_id: ME, team_id: TEAM, workspace: WS, status: "open", project_id: P, created_at: 1, updated_at: NOW }],
    docs: [], conversations: [], session_owners: [], session_decisions: [], managed_sessions: [], messages: [], user_presence: [], pending_messages: [], devices: [],
    org_changes: [], org_change_batches: [],
  });
}

const row = (db: any, n: number) => db._tables.conversations.find((c: any) => c._id === `conversations_s${n}`);

describe("releaseFolderHeldSessions", () => {
  async function world() {
    const db = fixtures();
    const ctx = { db, scheduler: { runAfter: async () => {} } } as any;
    const growth = await performCreateRole(ctx, ME as any, { name: "Growth", handle: "growth", team_id: TEAM, scope: { project_ids: [P as any], plan_ids: [] } });
    const standing = conv(9, { standing_role_id: growth._id, org_role_id: undefined });
    db._tables.conversations.push(
      standing,
      conv(1, { org_role_id: growth._id, active_task_id: "tasks_growth" }), // bound: keep, stamped bound
      conv(2, { org_role_id: growth._id, org_role_hold: "filed" }), // filed: keep
      conv(3, { org_role_id: growth._id, parent_conversation_id: "conversations_s9" }), // a hand: keep, stamped filed
      conv(4, { org_role_id: growth._id }), // taken over by a role batch: release
      conv(5, { org_role_id: growth._id, status: "completed" }), // a person's filing (session batch): keep
      conv(6, { org_role_id: growth._id, status: "completed" }), // no record: release
      conv(7, { org_role_id: growth._id, inbox_killed_at: NOW }), // killed: skipped
      conv(8, { org_role_id: growth._id, workflow_run_id: "workflow_runs_1" }), // a line run: keep
      conv(10, { org_role_id: growth._id }), // briefed as a hand: keep
    );
    db._tables.messages.push({ _id: "msg_hand", conversation_id: "conversations_s10", role: "user", content: "## You are a hand of Growth (@growth)\nDo the work.", timestamp: NOW });
    const batch = (id: string, kinds: Record<string, number>) => ({ _id: id, user_id: ME, team_id: TEAM, workspace: WS, door: "proposal", gesture: "accept_all", seq: 1, row_count: 1, kinds, role_ids: [String(growth._id)], created_at: NOW });
    const change = (id: string, batch: string, subjectId: string, seq: number) => ({ _id: id, batch, seq, workspace: WS, user_id: ME, kind: "session", subject: { type: "session", id: subjectId, label: subjectId }, before: {}, after: {}, effects: {}, labels: {}, role_ids: [], created_at: NOW });
    db._tables.org_change_batches.push({ ...batch("b_role", { role: 1 }), proposal: { id: "op", short_id: "op-15", title: "Add an agent: Growth lead" } }, batch("b_person", { session: 1 }));
    // The takeover folded into the hire's row: the sessions it moved are in its effects, and no row names them as subject.
    db._tables.org_changes.push(
      { ...change("c4", "b_role", String(growth._id), 1), kind: "role", subject: { type: "role", id: String(growth._id), label: "@growth" }, effects: { takeover: { role_id: String(growth._id), handle: "growth", sessions: [{ conversation_id: "conversations_s4", short_id: "jx70004" }], kept_in_front: [], over_cap: 0, told: { sessions: 1, roles: 0, deferred: 0 } } } },
      change("c5", "b_person", "conversations_s5", 2),
    );
    return { db, ctx, growth };
  }

  test("dry by default: names each session, its verdict and why, writes nothing", async () => {
    const { db, ctx } = await world();
    const out = await releaseFolderHeld(ctx, { team: String(TEAM) });
    expect(out.dryRun).toBe(true);
    expect(out.rows.find((r) => r.session === "jx70004")?.reason).toBe("taken over by the folder rule (op-15)");
    expect(out.rows.map((r) => [r.session, r.verdict, r.reason.split(" (")[0]])).toEqual([
      ["jx70001", "keep", "bound to work in its area"],
      ["jx70002", "keep", "filed by a person or role"],
      ["jx70003", "keep", "started by the role's own line"],
      ["jx70004", "release", "taken over by the folder rule"],
      ["jx70005", "keep", "filed by a person or role"],
      ["jx70006", "release", "no record"],
      ["jx70007", "skip", "killed: a retired row nobody reads"],
      ["jx70008", "keep", "started by the role's own line"],
      ["jx700010", "keep", "started by the role's own line"],
    ]);
    expect([out.release, out.release_live, out.keep, out.skipped]).toEqual([2, 1, 6, 1]);
    expect(out.released).toBe(0);
    for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 10]) expect(row(db, n).org_role_id).toBeDefined();
    expect(row(db, 1).org_role_hold).toBeUndefined();
  });

  test("for real: releases to the starter, stamps what it keeps, one undoable batch per role; a role filter narrows it", async () => {
    const { db, ctx, growth } = await world();
    expect((await releaseFolderHeld(ctx, { dryRun: false, team: String(TEAM), role: "@nobody" })).roles).toBe(0);
    // A fresh ctx, as a mutation of its own: the release is its own org change batch.
    const out = await releaseFolderHeld({ db, scheduler: ctx.scheduler }, { dryRun: false, team: String(TEAM), role: "@growth" });
    expect([out.released, out.stamped]).toEqual([2, 5]); // stamped: s1 bound; s3, s5, s8 and s10 filed; s2 already carried its stamp
    expect(row(db, 4).org_role_id).toBeUndefined();
    expect(row(db, 6).org_role_id).toBeUndefined();
    expect(row(db, 1).org_role_hold).toBe("bound");
    expect(row(db, 3).org_role_hold).toBe("filed");
    expect(row(db, 7).org_role_id).toBe(growth._id); // killed: untouched
    expect(row(db, 2).org_role_id).toBe(growth._id);
    expect(row(db, 9).standing_role_id).toBe(growth._id);
    // The release is one org change batch, with a row per session, for History and undo.
    // One batch, door cli, whose one row folds both moves (as a takeover folds), so History and undo have them.
    const batches = db._tables.org_change_batches.filter((b: any) => b.door === "cli" && b.gesture === "command");
    expect(batches).toHaveLength(1);
    const rowsOfBatch = db._tables.org_changes.filter((c: any) => c.batch === batches[0]._id);
    expect(rowsOfBatch.flatMap((c: any) => (c.writes ?? []).map((w: any) => w.id)).sort()).toEqual(["conversations_s4", "conversations_s6"]);
  });
});
