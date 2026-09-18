import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { performCreateRole, performSetProjectLead } from "./orgRoles";

// Naming a project's lead from the project page (org-roles-run-work.md R4):
// the owner and, when the role's scope does not list the project, the scope,
// in one act, with the role told.

const ME = "u".repeat(31) + "m"; // team admin
const MATE = "u".repeat(31) + "t"; // plain member
const TEAM = "teams_acme" as any;
const WS = `team:${TEAM}`;
const P = "projects_p";
const Q = "projects_q";

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
    role_wake_outbox: [],
    conversations: [],
    session_owners: [],
    managed_sessions: [],
    tasks: [],
    projects: [
      { _id: P, user_id: ME, team_id: TEAM, workspace: WS, short_id: "pr-1", title: "Growth", status: "active", created_at: 1, updated_at: 1 },
      { _id: Q, user_id: ME, team_id: TEAM, workspace: WS, short_id: "pr-2", title: "Billing", status: "active", created_at: 1, updated_at: 1 },
    ],
    plans: [],
  });
}

// A signed in human: scope edits refuse anonymous callers (refuseUnlessHuman).
const ctxOf = (db: any, who = ME) => ({ db, auth: { getUserIdentity: async () => ({ subject: String(who) }) } }) as any;
const role = (db: any, handle: string, project_ids: string[], reports_to?: any) =>
  performCreateRole(ctxOf(db), ME as any, { name: handle, handle, team_id: TEAM, scope: { project_ids: project_ids as any, plan_ids: [] }, reports_to });
const scopeOf = async (db: any, id: any) => ((await db.get(id)).scope.project_ids as any[]).map(String);
const causesFor = (db: any, id: any) => db._tables.role_wake_outbox.filter((r: any) => String(r.role_id) === String(id)).map((r: any) => r.cause as string);

describe("performSetProjectLead", () => {
  test("names the owner and adds the project to a scope that does not list it; the role hears both", async () => {
    const db = fixtures();
    const billing = await role(db, "billing", [Q]);
    // A role hears nothing until it has a standing agent to wake.
    await db.patch(billing._id, { anchor_id: "anchors_billing" });
    const out = await performSetProjectLead(ctxOf(db), ME as any, { project_id: P as any, role_id: String(billing._id) });
    expect(out).toMatchObject({ owner_role_id: String(billing._id), scope: "added" });
    expect(String((await db.get(P)).owner_role_id)).toBe(String(billing._id));
    expect(await scopeOf(db, billing._id)).toEqual([Q, P]);
    const causes = causesFor(db, billing._id);
    expect(causes.some((c) => c.startsWith("you now lead the project Growth"))).toBe(true);
    expect(causes.some((c) => c.startsWith("scope changed"))).toBe(true);
  });

  test("a scope that already lists the project is left alone", async () => {
    const db = fixtures();
    const growth = await role(db, "growth", [P]);
    const out = await performSetProjectLead(ctxOf(db), ME as any, { project_id: P as any, role_id: String(growth._id) });
    expect(out.scope).toBe("listed");
    expect(await scopeOf(db, growth._id)).toEqual([P]);
  });

  test("a whole workspace role is never narrowed to the one project", async () => {
    const db = fixtures();
    const ops = await role(db, "ops", []);
    const out = await performSetProjectLead(ctxOf(db), ME as any, { project_id: P as any, role_id: String(ops._id) });
    expect(out.scope).toBe("whole_workspace");
    expect(await scopeOf(db, ops._id)).toEqual([]);
    expect(String((await db.get(P)).owner_role_id)).toBe(String(ops._id));
  });

  test("a role under a parent that does not look after the project leads it and keeps its scope", async () => {
    const db = fixtures();
    const head = await role(db, "head", [Q]);
    const child = await role(db, "child", [Q], { kind: "role", role_id: head._id });
    const out = await performSetProjectLead(ctxOf(db), ME as any, { project_id: P as any, role_id: String(child._id) });
    expect(out.scope).toBe("outside_parent");
    expect(await scopeOf(db, child._id)).toEqual([Q]);
    expect(String((await db.get(P)).owner_role_id)).toBe(String(child._id));
  });

  test("a member who may not reshape the role still names the lead; the scope waits for an admin", async () => {
    const db = fixtures();
    const billing = await role(db, "billing", [Q]);
    const out = await performSetProjectLead(ctxOf(db, MATE), MATE as any, { project_id: P as any, role_id: String(billing._id) });
    expect(out.scope).toBe("not_admin");
    expect(await scopeOf(db, billing._id)).toEqual([Q]);
    expect(String((await db.get(P)).owner_role_id)).toBe(String(billing._id));
  });

  test("null clears the named lead and touches no scope", async () => {
    const db = fixtures();
    const growth = await role(db, "growth", [P]);
    await performSetProjectLead(ctxOf(db), ME as any, { project_id: P as any, role_id: String(growth._id) });
    const out = await performSetProjectLead(ctxOf(db), ME as any, { project_id: P as any, role_id: null });
    expect(out).toEqual({ owner_role_id: null, scope: "cleared" });
    expect((await db.get(P)).owner_role_id).toBeUndefined();
    expect(await scopeOf(db, growth._id)).toEqual([P]);
  });

  test("a role from another workspace is refused", async () => {
    const db = fixtures();
    await expect(performSetProjectLead(ctxOf(db), ME as any, { project_id: P as any, role_id: "@nobody" })).rejects.toThrow(/No role/);
  });
});
