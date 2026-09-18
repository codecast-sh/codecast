import { afterEach, describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { canAccessInitiative } from "./lib/access";
import { performCreateRole } from "./orgRoles";
import { addProject, create, get, list, postUpdate, removeProject, setProjects, update, webGet, webList, webUpdates } from "./initiatives";

// Initiatives (initiatives-projects-role-page.md I1). Pinned here: who may
// read one, where its health comes from, a role as its owner, and a project
// that sits in two of them.

const ME = "u".repeat(31) + "m"; // team admin
const MATE = "u".repeat(31) + "t"; // plain member
const STRANGER = "u".repeat(31) + "s"; // in no team
const TEAM = "teams_acme" as any;
const OTHER_TEAM = "teams_other" as any;
const WS = `team:${TEAM}`;
const P = "projects_p";
const Q = "projects_q";
const FOREIGN = "projects_foreign";

const project = (_id: string, title: string, extra: Record<string, any> = {}) => ({
  _id, user_id: ME, team_id: TEAM, workspace: WS, title, status: "active", created_at: 1, updated_at: 1, ...extra,
});

function fixtures() {
  return makeFakeDb({
    users: [
      { _id: ME, name: "Me", email: "me@x.ai", github_username: "me" },
      { _id: MATE, name: "Mate", email: "mate@x.ai", github_username: "mate" },
      { _id: STRANGER, name: "Stranger", email: "s@y.ai" },
    ],
    teams: [{ _id: TEAM, name: "Acme" }, { _id: OTHER_TEAM, name: "Other" }],
    team_memberships: [
      { _id: "m1", user_id: ME, team_id: TEAM, role: "admin", joined_at: 1 },
      { _id: "m2", user_id: MATE, team_id: TEAM, role: "member", joined_at: 1 },
      { _id: "m3", user_id: ME, team_id: OTHER_TEAM, role: "admin", joined_at: 1 },
    ],
    directory_team_mappings: [],
    counters: [],
    initiatives: [],
    initiative_updates: [],
    org_roles: [],
    org_role_history: [],
    role_wake_outbox: [],
    anchors: [],
    conversations: [],
    session_owners: [],
    managed_sessions: [],
    tasks: [
      { _id: "tasks_1", user_id: ME, team_id: TEAM, workspace: WS, project_id: P, status: "done", title: "a" },
      { _id: "tasks_2", user_id: ME, team_id: TEAM, workspace: WS, project_id: P, status: "open", title: "b" },
      { _id: "tasks_3", user_id: ME, team_id: TEAM, workspace: WS, project_id: Q, status: "done", title: "c" },
    ],
    plans: [],
    projects: [
      project(P, "Growth"),
      project(Q, "Billing"),
      project(FOREIGN, "Elsewhere", { team_id: OTHER_TEAM, workspace: `team:${OTHER_TEAM}` }),
    ],
  });
}

const ctxOf = (db: any, who: string | null = ME) =>
  ({ db, auth: { getUserIdentity: async () => (who ? { subject: `${who}|session` } : null) } }) as any;
const run = (fn: any, db: any, args: Record<string, any>, who: string | null = ME) => fn._handler(ctxOf(db, who), args);
const inTeam = { workspace: "team" as const, team_id: TEAM };

// Updates are ordered by their server clock, so each write gets its own tick.
const realNow = Date.now;
function tickingClock() {
  let t = 1_700_000_000_000;
  Date.now = () => (t += 1000);
}
afterEach(() => { Date.now = realNow; });

describe("initiatives: access", () => {
  test("a team initiative is read by every member and by nobody outside the team", async () => {
    const db = fixtures();
    const made = await run(create, db, { ...inTeam, title: "Win enterprise" });
    expect(made.short_id).toBe("in-1");
    expect(made.row).toMatchObject({ workspace: WS, team_id: TEAM, user_id: ME, status: "proposed", health: "none", project_ids: [] });

    expect((await run(webList, db, inTeam, MATE)).map((r: any) => r.short_id)).toEqual(["in-1"]);
    expect((await run(webGet, db, { ref: "IN-1" }, MATE))?.title).toBe("Win enterprise");
    expect(await run(webGet, db, { ref: "in-1" }, STRANGER)).toBeNull();
    expect(await run(webList, db, {}, STRANGER)).toEqual([]);
    expect(await run(webUpdates, db, { initiative_id: "in-1" }, STRANGER)).toBeNull();
    await expect(run(update, db, { id: "in-1", title: "Mine now" }, STRANGER)).rejects.toThrow("Initiative not found");
    await expect(run(postUpdate, db, { id: "in-1", body: "hi", health: "on_track" }, STRANGER)).rejects.toThrow("Initiative not found");
  });

  test("a personal initiative stays with its owner, and a signed out caller reads nothing", async () => {
    const db = fixtures();
    await run(create, db, { workspace: "personal", title: "Learn to sail" });
    expect((await run(webList, db, {}, ME)).length).toBe(1);
    expect(await run(webList, db, {}, MATE)).toEqual([]);
    expect(await run(webGet, db, { ref: "in-1" }, MATE)).toBeNull();
    expect(await run(webList, db, {}, null)).toEqual([]);
  });

  test("access reads the workspace key and never team_id: routed to the team, readable by its owner only", async () => {
    const db = fixtures();
    const row = { user_id: ME, team_id: TEAM, workspace: `user:${ME}` } as any;
    expect(await canAccessInitiative({ db }, ME as any, row)).toBe(true);
    expect(await canAccessInitiative({ db }, MATE as any, row)).toBe(false);
    // The reverse: no routing at all, and the team key still admits a member.
    expect(await canAccessInitiative({ db }, MATE as any, { user_id: ME, workspace: WS } as any)).toBe(true);
    // An unknown key variant grants nothing.
    expect(await canAccessInitiative({ db }, MATE as any, { user_id: ME, team_id: TEAM, workspace: "restricted:x" } as any)).toBe(false);
  });

  test("a write names its workspace, and a team the caller is not in is refused", async () => {
    const db = fixtures();
    await expect(run(create, db, { workspace: "team", title: "No team" })).rejects.toThrow("team_id is required");
    await expect(run(create, db, { ...inTeam, title: "Not mine" }, STRANGER)).rejects.toThrow("team membership required");
  });

  test("a retried create answers with the row it already made", async () => {
    const db = fixtures();
    const a = await run(create, db, { ...inTeam, title: "Once", client_key: "k1" });
    const b = await run(create, db, { ...inTeam, title: "Once", client_key: "k1" });
    expect(b.id).toBe(a.id);
    expect(db._tables.initiatives.length).toBe(1);
  });
});

describe("initiatives: health comes from the latest update", () => {
  test("none before an update; the first update must say how it is going; later ones may keep the last word", async () => {
    tickingClock();
    const db = fixtures();
    await run(create, db, { ...inTeam, title: "Win enterprise" });
    await expect(run(postUpdate, db, { id: "in-1", body: "Kickoff" })).rejects.toThrow("Say how it is going");
    await expect(run(postUpdate, db, { id: "in-1", body: "  ", health: "on_track" })).rejects.toThrow("needs a body");

    const first = await run(postUpdate, db, { id: "in-1", body: "Kickoff went well", health: "on_track" });
    let row = await run(webGet, db, { ref: "in-1" });
    expect(row).toMatchObject({ health: "on_track", latest_update_id: first.id, health_at: first.row.at });

    const second = await run(postUpdate, db, { id: "in-1", body: "Two deals slipped", health: "at_risk" }, MATE);
    row = await run(webGet, db, { ref: "in-1" });
    expect(row).toMatchObject({ health: "at_risk", latest_update_id: second.id, health_at: second.row.at });
    expect(second.row.by).toEqual({ kind: "user", user_id: MATE });

    const third = await run(postUpdate, db, { id: "in-1", body: "Still working it" });
    expect(third.row.health).toBe("at_risk");

    const updates = await run(webUpdates, db, { initiative_id: "in-1" });
    expect(updates.map((u: any) => u.body)).toEqual(["Still working it", "Two deals slipped", "Kickoff went well"]);
    expect(updates.every((u: any) => u.workspace === WS && u.team_id === TEAM)).toBe(true);
  });

  test("an update written with an older clock never rewinds the initiative", async () => {
    tickingClock();
    const db = fixtures();
    const made = await run(create, db, { ...inTeam, title: "Win enterprise" });
    const late = await run(postUpdate, db, { id: "in-1", body: "Off track", health: "off_track" });
    // A row that lands after it but carries an earlier time (a replayed write).
    Date.now = () => late.row.at - 5000;
    await run(postUpdate, db, { id: "in-1", body: "Older news", health: "on_track" });
    expect(await db.get(made.id)).toMatchObject({ health: "off_track", latest_update_id: late.id });
  });

  test("a retried update is posted once", async () => {
    tickingClock();
    const db = fixtures();
    await run(create, db, { ...inTeam, title: "Win enterprise" });
    const a = await run(postUpdate, db, { id: "in-1", body: "Once", health: "on_track", client_key: "u1" });
    const b = await run(postUpdate, db, { id: "in-1", body: "Once", health: "on_track", client_key: "u1" });
    expect(b.id).toBe(a.id);
    expect(db._tables.initiative_updates.length).toBe(1);
  });
});

describe("initiatives: the owner is a person or a role", () => {
  const growthRole = (db: any, project_ids: string[] = []) =>
    performCreateRole(ctxOf(db), ME as any, { name: "Head of Growth", handle: "growth", team_id: TEAM, scope: { project_ids: project_ids as any, plan_ids: [] } });

  test("a handle names a role first, then a person; `me` is the caller; none clears", async () => {
    const db = fixtures();
    const role = await growthRole(db, [P]);
    await run(create, db, { ...inTeam, title: "Win enterprise", owner: "@growth" });
    expect((await run(webGet, db, { ref: "in-1" })).owner).toEqual({ kind: "role", role_id: role._id });

    await run(update, db, { id: "in-1", owner: "@mate" });
    expect((await run(webGet, db, { ref: "in-1" })).owner).toEqual({ kind: "user", user_id: MATE });
    await run(update, db, { id: "in-1", owner: "me" }, MATE);
    expect((await run(webGet, db, { ref: "in-1" })).owner).toEqual({ kind: "user", user_id: MATE });
    await run(update, db, { id: "in-1", owner: null });
    expect((await run(webGet, db, { ref: "in-1" })).owner).toBeUndefined();

    await expect(run(update, db, { id: "in-1", owner: "@nobody" })).rejects.toThrow("No role or person @nobody");
    // A person outside the workspace cannot own what they cannot read.
    await expect(run(update, db, { id: "in-1", owner: { kind: "user", user_id: STRANGER } })).rejects.toThrow("not in this workspace");
  });

  test("an owner role gains the initiative's projects in its scope: when it is named, and when a project is added under it", async () => {
    const db = fixtures();
    const role = await growthRole(db, [P]);
    const scope = async () => ((await db.get(role._id)).scope.project_ids as any[]).map(String);

    await run(create, db, { ...inTeam, title: "Win enterprise", project_ids: [P] });
    const named = await run(update, db, { id: "in-1", owner: { kind: "role", role_id: String(role._id) } });
    expect(named.scope).toMatchObject({ added: [], listed: [P] });

    const grown = await run(addProject, db, { id: "in-1", project_id: Q });
    expect(grown).toMatchObject({ added: true, scope: { added: [Q], listed: [P] } });
    expect(await scope()).toEqual([P, Q]);

    // Removing a project from the initiative takes nothing from the role.
    const shrunk = await run(removeProject, db, { id: "in-1", project_id: Q });
    expect(shrunk).toMatchObject({ removed: true, scope: null });
    expect(await scope()).toEqual([P, Q]);
  });

  test("a member who may not reshape the role still names it owner, and is told the scope was left", async () => {
    const db = fixtures();
    const role = await growthRole(db, [P]);
    const out = await run(create, db, { ...inTeam, title: "Win enterprise", owner: "@growth", project_ids: [Q] }, MATE);
    expect(out.row.owner).toEqual({ kind: "role", role_id: role._id });
    expect(out.scope.skipped).toEqual([{ project_id: Q, reason: "not_admin" }]);
  });

  test("a role's standing session writes its update as the role; a teammate naming that session does not", async () => {
    tickingClock();
    const db = fixtures();
    const role = await growthRole(db, [P]);
    await db.insert("users", { name: "Growth bot", is_bot: true });
    const bot = db._tables.users.at(-1)._id;
    const anchor = await db.insert("anchors", { bot_user_id: bot, team_id: TEAM });
    await db.patch(role._id, { anchor_id: anchor });
    const conv = await db.insert("conversations", { user_id: ME, team_id: TEAM, session_id: "sess-growth", standing_role_id: role._id, is_private: false });
    await run(create, db, { ...inTeam, title: "Win enterprise", owner: "@growth" });

    const asRole = await run(postUpdate, db, { id: "in-1", body: "Pipeline doubled", health: "on_track", session_id: "sess-growth" });
    expect(asRole.row.by).toEqual({ kind: "role", role_id: role._id, conversation_id: conv });
    // The record keeps the account that made the call.
    expect(asRole.row.user_id).toBe(ME);

    const asMate = await run(postUpdate, db, { id: "in-1", body: "I am the role", health: "off_track", session_id: "sess-growth" }, MATE);
    expect(asMate.row.by).toEqual({ kind: "user", user_id: MATE });

    const shown = await run(get, db, { id: "in-1" });
    expect(shown.owner_label).toBe("@growth");
    expect(shown.updates.map((u: any) => u.by_label)).toEqual(["Mate", "@growth"]);
  });
});

describe("initiatives: projects", () => {
  test("one project sits in two initiatives, in the order each owner arranged", async () => {
    const db = fixtures();
    await run(create, db, { ...inTeam, title: "Win enterprise", project_ids: [P, Q] });
    await run(create, db, { ...inTeam, title: "Cut churn", project_ids: [Q] });
    const rows = await run(webList, db, inTeam);
    const byId = Object.fromEntries(rows.map((r: any) => [r.short_id, r.project_ids.map(String)]));
    expect(byId).toEqual({ "in-1": [P, Q], "in-2": [Q] });

    // Removing it from one leaves the other alone.
    await run(removeProject, db, { id: "in-1", project_id: Q });
    expect((await run(webGet, db, { ref: "in-1" })).project_ids).toEqual([P]);
    expect((await run(webGet, db, { ref: "in-2" })).project_ids).toEqual([Q]);
  });

  test("add is idempotent, a reorder keeps the set, and a project of another workspace is refused", async () => {
    const db = fixtures();
    await run(create, db, { ...inTeam, title: "Win enterprise", project_ids: [P] });
    expect((await run(addProject, db, { id: "in-1", project_id: P })).added).toBe(false);
    await run(addProject, db, { id: "in-1", project_id: Q });
    await run(setProjects, db, { id: "in-1", project_ids: [Q, P, Q] });
    expect((await run(webGet, db, { ref: "in-1" })).project_ids).toEqual([Q, P]);

    await expect(run(addProject, db, { id: "in-1", project_id: FOREIGN })).rejects.toThrow("belongs to another workspace");
    await expect(run(addProject, db, { id: "in-1", project_id: "projects_missing" })).rejects.toThrow("No project");
  });

  test("the terminal reads join project titles and roll task counts up; the synced row stays raw", async () => {
    const db = fixtures();
    await run(create, db, { ...inTeam, title: "Win enterprise", status: "active", project_ids: [P, Q] });
    const [row] = await run(list, db, { status: "active" });
    expect(row.projects.map((p: any) => [p.title, p.task_counts])).toEqual([["Growth", { total: 2, done: 1 }], ["Billing", { total: 1, done: 1 }]]);
    expect(row.task_counts).toEqual({ total: 3, done: 2 });
    expect(await run(list, db, { status: "completed" })).toEqual([]);

    const [raw] = await run(webList, db, inTeam);
    expect("projects" in raw || "task_counts" in raw || "owner_label" in raw).toBe(false);
  });
});

describe("initiatives: one level of nesting", () => {
  test("a child has a parent; a child is never a parent and a parent is never a child", async () => {
    const db = fixtures();
    await run(create, db, { ...inTeam, title: "Win enterprise" });
    await run(create, db, { ...inTeam, title: "Land three banks", parent_initiative_id: "in-1" });
    await run(create, db, { ...inTeam, title: "Third" });

    await expect(run(update, db, { id: "in-3", parent_initiative_id: "in-2" })).rejects.toThrow("nesting is one level");
    await expect(run(update, db, { id: "in-1", parent_initiative_id: "in-3" })).rejects.toThrow("has sub initiatives");
    await expect(run(update, db, { id: "in-3", parent_initiative_id: "in-3" })).rejects.toThrow("cannot sit under itself");

    const shown = await run(get, db, { id: "in-1" });
    expect(shown.sub_initiatives.map((c: any) => c.short_id)).toEqual(["in-2"]);
    expect((await run(get, db, { id: "in-2" })).parent.short_id).toBe("in-1");

    await run(update, db, { id: "in-2", parent_initiative_id: null });
    expect((await run(webGet, db, { ref: "in-2" })).parent_initiative_id).toBeUndefined();
  });
});
