import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { performCreateRole } from "./orgRoles";
import { applyHoldChange } from "./sessionOwnership";
import { holdChangeFor } from "./lib/orgOwnership";

// The hold a binding gives or takes (org-staffing.md S35): a lead holds a
// session only when it is bound to work the lead owns or someone filed it
// there. Binding files, unbinding returns, a person's filing stands, a done
// session stays, another person's session is never taken.

const ME = "u".repeat(31) + "m";
const MATE = "u".repeat(31) + "t";
const TEAM = "teams_acme" as any;
const WS = `team:${TEAM}`;
const NOW = 1_800_000_000_000;
const P = "projects_p";

const conv = (n: number, over: Record<string, any> = {}) => ({
  _id: `conversations_s${n}`, short_id: `jx7000${n}`, user_id: ME, team_id: TEAM, status: "active", agent_type: "claude_code",
  title: `Work ${n}`, project_path: "/repo/elsewhere", message_count: 3, last_message_role: "assistant", updated_at: NOW - 60_000, created_at: 1, ...over,
});

function fixtures() {
  return makeFakeDb({
    users: [{ _id: ME, name: "Me", email: "me@x.ai" }, { _id: MATE, name: "Mate", email: "mate@x.ai" }],
    team_memberships: [
      { _id: "m1", user_id: ME, team_id: TEAM, role: "admin", joined_at: 1 },
      { _id: "m2", user_id: MATE, team_id: TEAM, role: "member", joined_at: 1 },
    ],
    teams: [{ _id: TEAM, name: "Acme" }],
    counters: [], org_roles: [], org_role_history: [], anchors: [],
    projects: [
      { _id: P, user_id: ME, team_id: TEAM, workspace: WS, short_id: "pr-1", title: "Growth", status: "active", project_path: "/repo/growth", created_at: 1, updated_at: NOW },
      { _id: "projects_q", user_id: ME, team_id: TEAM, workspace: WS, short_id: "pr-2", title: "Billing", status: "active", created_at: 1, updated_at: NOW },
    ],
    plans: [],
    tasks: [
      { _id: "tasks_growth", short_id: "ct-1", title: "grow", user_id: ME, team_id: TEAM, workspace: WS, status: "open", project_id: P, created_at: 1, updated_at: NOW },
      { _id: "tasks_billing", short_id: "ct-2", title: "bill", user_id: ME, team_id: TEAM, workspace: WS, status: "open", project_id: "projects_q", created_at: 1, updated_at: NOW },
    ],
    docs: [], conversations: [], session_owners: [], session_decisions: [], managed_sessions: [], messages: [], user_presence: [], pending_messages: [], devices: [],
  });
}

const ctxOf = (db: any) => ({ db, scheduler: { runAfter: async () => {} } }) as any;
const row = (db: any, n: number) => db._tables.conversations.find((c: any) => c._id === `conversations_s${n}`);

describe("the hold a binding gives or takes", () => {
  test("binding to a task in a lead's area files the session under the lead, held as bound; unbinding returns it", async () => {
    const db = fixtures();
    const ctx = ctxOf(db);
    const growth = await performCreateRole(ctx, ME as any, { name: "Growth", handle: "growth", team_id: TEAM, scope: { project_ids: [P as any], plan_ids: [] } });
    db._tables.conversations.push(conv(1));
    expect(await holdChangeFor(ctx, row(db, 1))).toMatchObject({ kind: "keep", why: "unbound" });

    await db.patch("conversations_s1", { active_task_id: "tasks_growth" });
    expect(await applyHoldChange(ctx, "conversations_s1" as any)).toEqual({ change: "file", role: "growth" });
    expect(row(db, 1).org_role_id).toBe(growth._id);
    expect(row(db, 1).org_role_hold).toBe("bound");
    // The same binding again changes nothing.
    expect(await applyHoldChange(ctx, "conversations_s1" as any)).toEqual({ change: "keep" });

    await db.patch("conversations_s1", { active_task_id: undefined });
    expect(await applyHoldChange(ctx, "conversations_s1" as any)).toEqual({ change: "release", role: "growth" });
    expect(row(db, 1).org_role_id).toBeUndefined();
    expect(row(db, 1).org_role_hold).toBeUndefined();
  });

  test("a binding outside any lead's area, a whole-workspace role, or another person's session moves nothing", async () => {
    const db = fixtures();
    const ctx = ctxOf(db);
    await performCreateRole(ctx, ME as any, { name: "Head of People", handle: "head-of-people", team_id: TEAM });
    await performCreateRole(ctx, ME as any, { name: "Growth", handle: "growth", team_id: TEAM, scope: { project_ids: [P as any], plan_ids: [] } });
    db._tables.conversations.push(conv(1, { active_task_id: "tasks_billing" }), conv(2, { active_task_id: "tasks_growth", user_id: MATE }));
    // Billing is only the Head of People's remainder: a whole workspace role takes nothing by a binding.
    expect(await holdChangeFor(ctx, row(db, 1))).toMatchObject({ kind: "keep", why: "no lead owns its work" });
    expect(await holdChangeFor(ctx, row(db, 2))).toMatchObject({ kind: "keep", why: "another person's session" });
  });

  test("a session a person filed is never moved by a binding; a done session stays; a bound hold follows the work to another lead", async () => {
    const db = fixtures();
    const ctx = ctxOf(db);
    const growth = await performCreateRole(ctx, ME as any, { name: "Growth", handle: "growth", team_id: TEAM, scope: { project_ids: [P as any], plan_ids: [] } });
    const billing = await performCreateRole(ctx, ME as any, { name: "Billing", handle: "billing", team_id: TEAM, scope: { project_ids: ["projects_q" as any], plan_ids: [] } });
    db._tables.conversations.push(
      conv(1, { org_role_id: growth._id, org_role_hold: "filed" }),
      conv(2, { org_role_id: growth._id, org_role_hold: "bound", status: "done" }),
      conv(3, { org_role_id: growth._id, org_role_hold: "bound", active_task_id: "tasks_billing" }),
      conv(4, { org_role_id: growth._id }), // from before the stamp: read as filed
    );
    expect(await holdChangeFor(ctx, row(db, 1))).toMatchObject({ kind: "keep", why: "filed" });
    expect(await holdChangeFor(ctx, row(db, 2))).toMatchObject({ kind: "keep", why: "done" });
    expect(await holdChangeFor(ctx, row(db, 4))).toMatchObject({ kind: "keep", why: "filed" });
    expect(await applyHoldChange(ctx, "conversations_s3" as any)).toEqual({ change: "move", role: "billing" });
    expect(row(db, 3).org_role_id).toBe(billing._id);
    expect(row(db, 3).org_role_hold).toBe("bound");
  });
});
