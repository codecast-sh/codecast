import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { performCoverProjects, performCreateRole, performSetProjectLead } from "./orgRoles";

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
    teams: [{ _id: TEAM, name: "Acme", features: { org: true } }],
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

// An initiative's owner role gains every project of the initiative in one act
// (initiatives-projects-role-page.md I1): the same scope write as naming a lead.
describe("naming a lead takes over the project's sessions, with the person's one edit", () => {
  // The fixture the review found missing: sessions of the host on the
  // project's path, so the gesture has something to move.
  const conv = (n: number) => ({ _id: `conversations_s${n}`, short_id: `jx7000${n}`, user_id: ME, team_id: TEAM, status: "active", agent_type: "claude_code", title: `Growth work ${n}`, project_path: "/repo/growth", message_count: 3, last_message_role: "assistant", updated_at: Date.now() - 60_000, created_at: 1 });
  function withSessions() {
    const db: any = fixtures();
    Object.assign(db._tables.projects.find((p: any) => p._id === P), { project_path: "/repo/growth" });
    db._tables.conversations.push(conv(1), conv(2));
    for (const t of ["anchors", "role_wakes", "session_decisions", "messages", "user_presence", "pending_messages", "devices", "docs"]) db._tables[t] ??= [];
    return db;
  }
  const roleOfSession = (db: any, n: number) => db._tables.conversations.find((c: any) => c._id === `conversations_s${n}`).org_role_id;

  test("one click on the project page moves the sessions, and says so", async () => {
    const db = withSessions();
    const billing = await role(db, "billing", [Q]);
    const out = await performSetProjectLead(ctxOf(db), ME as any, { project_id: P as any, role_id: String(billing._id) });
    expect(out.scope).toBe("added");
    expect(out.took_over).toContain("2 sessions now report to @billing and leave your needs input");
    expect(roleOfSession(db, 1)).toBe(billing._id);
  });

  test("naming a project's lead offers the person's one edit (leave the sessions) like every other scope gain", async () => {
    // performCoverProjects called the takeover with no `leave` option: one
    // click moved up to 100 sessions out of the person's needs input, and
    // nothing could say no (W7 review, finding 6).
    const db = withSessions();
    // A role with some other scope, so it does not look after the whole workspace.
    const r = await role(db, "growth", [Q]);
    const res = await performSetProjectLead(ctxOf(db), ME as any, { project_id: P as any, role_id: String(r._id), leave_sessions: true });
    expect(res.scope).toBe("added");
    expect(res.took_over).toBeUndefined();
    expect(roleOfSession(db, 1)).toBeUndefined();
    expect(roleOfSession(db, 2)).toBeUndefined();
  });

  test("an initiative's owner covers its projects through the same door, with the same edit", async () => {
    const db = withSessions();
    const r = await role(db, "growth", [Q]);
    const cover = await performCoverProjects(ctxOf(db), ME as any, r._id, [P as any], { leave_sessions: true });
    expect(cover.added).toEqual([P]);
    expect(cover.took_over).toBeUndefined();
    expect(roleOfSession(db, 1)).toBeUndefined();
  });
});

describe("performCoverProjects", () => {
  test("adds the projects the scope does not list in one update and says which it already had", async () => {
    const db = fixtures();
    const growth = await role(db, "growth", [P]);
    await db.patch(growth._id, { anchor_id: "anchors_growth" });
    const out = await performCoverProjects(ctxOf(db), ME as any, growth._id, [P, Q, Q] as any);
    expect(out).toMatchObject({ added: [Q], listed: [P], skipped: [] });
    expect(await scopeOf(db, growth._id)).toEqual([P, Q]);
    expect(causesFor(db, growth._id).filter((c) => c.startsWith("scope changed"))).toHaveLength(1);
    // Calling it again is safe: nothing is written twice.
    expect(await performCoverProjects(ctxOf(db), ME as any, growth._id, [P, Q] as any)).toMatchObject({ added: [], listed: [P, Q] });
    expect(await scopeOf(db, growth._id)).toEqual([P, Q]);
  });

  test("a person who may not reshape the role is told so, never refused", async () => {
    const db = fixtures();
    const billing = await role(db, "billing", [Q]);
    const out = await performCoverProjects(ctxOf(db, MATE), MATE as any, billing._id, [P] as any);
    expect(out).toMatchObject({ added: [], skipped: [{ project_id: P, reason: "not_admin" }] });
    expect(await scopeOf(db, billing._id)).toEqual([Q]);
  });

  test("a whole workspace owner keeps its whole workspace", async () => {
    const db = fixtures();
    const ops = await role(db, "ops", []);
    const out = await performCoverProjects(ctxOf(db), ME as any, ops._id, [P, Q] as any);
    expect(out.skipped.map((x) => x.reason)).toEqual(["whole_workspace", "whole_workspace"]);
    expect(await scopeOf(db, ops._id)).toEqual([]);
  });
});

describe("performCoverProjects from a token call", () => {
  // A scope edit is human only, and a `cast initiative` call authenticates by
  // token, so the role update would refuse it. The contract (I1 "The org"):
  // reported, never thrown, so the caller's own write stands and the person
  // is told the scope is theirs to widen from the role page.
  const cliCtx = (db: any) => ({ db, auth: { getUserIdentity: async () => null } }) as any;

  test("an admin on the CLI is told the scope was left for a person, and nothing throws", async () => {
    const db = fixtures();
    const growth = await role(db, "growth", [P]);
    const out = await performCoverProjects(cliCtx(db), ME as any, growth._id, [Q as any, P as any]);
    expect(out).toEqual({ added: [], listed: [P], skipped: [{ project_id: Q, reason: "human_only" }] });
    expect(await scopeOf(db, growth._id)).toEqual([P]);
  });

  test("the same call from the browser widens the scope", async () => {
    const db = fixtures();
    const growth = await role(db, "growth", [P]);
    const out = await performCoverProjects(ctxOf(db), ME as any, growth._id, [Q as any]);
    expect(out.added).toEqual([Q]);
    expect(await scopeOf(db, growth._id)).toEqual([P, Q]);
  });
});
