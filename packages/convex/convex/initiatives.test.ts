import { afterEach, describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { canAccessInitiative } from "./lib/access";
import { performCreateRole } from "./orgRoles";
import { performUndo } from "./orgChanges";
import { addProject, create, get, list, postUpdate, record, removeProject, report, setProjects, update, webGet, webList, webUpdates } from "./initiatives";
import { INITIATIVE_RECORD_MAX } from "@codecast/shared/contracts/initiative";
import { servedInitiatives } from "./lib/roleInitiatives";

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
    anchors: [],
    conversations: [],
    session_owners: [],
    managed_sessions: [],
    tasks: [
      { _id: "tasks_1", user_id: ME, team_id: TEAM, workspace: WS, project_id: P, status: "done", title: "a", source: "human" },
      { _id: "tasks_2", user_id: ME, team_id: TEAM, workspace: WS, project_id: P, status: "open", title: "b", source: "human" },
      { _id: "tasks_3", user_id: ME, team_id: TEAM, workspace: WS, project_id: Q, status: "done", title: "c", source: "meeting" },
      // Under a plan of Growth with no project of its own: not on Growth's board.
      { _id: "tasks_4", user_id: ME, team_id: TEAM, workspace: WS, plan_id: "plans_growth", status: "done", title: "d", source: "human" },
      // Dropped, and an agent's unpromoted suggestion: not on the board.
      { _id: "tasks_5", user_id: ME, team_id: TEAM, workspace: WS, project_id: P, status: "dropped", title: "e", source: "human" },
      { _id: "tasks_7", user_id: ME, team_id: TEAM, workspace: WS, project_id: P, status: "open", title: "g", source: "agent" },
      // Someone else's private task in Growth: not the caller's to read.
      { _id: "tasks_6", user_id: STRANGER, workspace: `user:${STRANGER}`, project_id: P, status: "done", title: "f", source: "human" },
    ],
    plans: [{ _id: "plans_growth", user_id: ME, team_id: TEAM, workspace: WS, project_id: P, title: "Growth plan", status: "active" }],
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

  test("an edit named by the client key lands on the row before the create has echoed; an unknown key fails so the outbox retries", async () => {
    const db = fixtures();
    const made = await run(create, db, { ...inTeam, title: "Draft title", client_key: "stub-7" });
    const renamed = await run(update, db, { id: "stub-7", title: "Win enterprise" });
    expect(renamed.id).toBe(made.id);
    expect((await db.get(made.id)).title).toBe("Win enterprise");
    // A key of someone else's create is not the caller's.
    await expect(run(update, db, { id: "stub-7", title: "Mine" }, MATE)).rejects.toThrow("Initiative not found");
    await expect(run(update, db, { id: "never-made", title: "x" })).rejects.toThrow("Initiative not found");
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

    // Health is the owner's word: a plain member is refused until named owner.
    await expect(run(postUpdate, db, { id: "in-1", body: "Two deals slipped", health: "at_risk" }, MATE)).rejects.toThrow("Only the owner or a workspace admin");
    await run(update, db, { id: "in-1", owner: "@mate" });
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

const growthRole = (db: any, project_ids: string[] = []) =>
  performCreateRole(ctxOf(db), ME as any, { name: "Head of Growth", handle: "growth", team_id: TEAM, scope: { project_ids: project_ids as any, plan_ids: [] } });

describe("initiatives: the owner is a person or a role", () => {

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

    // A teammate naming the standing session does not sign as the role, and
    // as neither owner nor admin may not post at all.
    await expect(run(postUpdate, db, { id: "in-1", body: "I am the role", health: "off_track", session_id: "sess-growth" }, MATE)).rejects.toThrow("Only the owner or a workspace admin");
    await run(update, db, { id: "in-1", owner: "@mate" });
    const asMate = await run(postUpdate, db, { id: "in-1", body: "I am the role", health: "off_track", session_id: "sess-growth" }, MATE);
    expect(asMate.row.by).toEqual({ kind: "user", user_id: MATE });

    const shown = await run(get, db, { id: "in-1" });
    expect(shown.owner_label).toBe("Mate");
    expect(shown.updates.map((u: any) => u.by_label)).toEqual(["Mate", "@growth"]);
  });

  test("a role of another workspace never signs an update here, even when its host is an admin", async () => {
    tickingClock();
    const db = fixtures();
    const foreign = await performCreateRole(ctxOf(db), ME as any, { name: "Other ops", handle: "ops", team_id: OTHER_TEAM, scope: { project_ids: [], plan_ids: [] } });
    await db.insert("users", { name: "Ops bot", is_bot: true });
    const bot = db._tables.users.at(-1)._id;
    const anchor = await db.insert("anchors", { bot_user_id: bot, team_id: OTHER_TEAM });
    await db.patch(foreign._id, { anchor_id: anchor });
    await db.insert("conversations", { user_id: ME, team_id: OTHER_TEAM, session_id: "sess-ops", standing_role_id: foreign._id, is_private: false });
    await run(create, db, { ...inTeam, title: "Win enterprise" });
    // ME is Acme's admin, so the post is allowed; it is signed by the person.
    const posted = await run(postUpdate, db, { id: "in-1", body: "From elsewhere", health: "on_track", session_id: "sess-ops" });
    expect(posted.row.by).toEqual({ kind: "user", user_id: ME });
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

  test("the terminal reads join project titles and roll up the board's task counts; the synced row stays raw", async () => {
    const db = fixtures();
    await run(create, db, { ...inTeam, title: "Win enterprise", status: "active", project_ids: [P, Q] });
    const [row] = await run(list, db, { status: "active" });
    // Growth counts the rows its board shows (shared/tasks projectTaskCounts):
    // one open and one done. The plan only task, the dropped one, the agent's
    // suggestion and the stranger's private one are not counted.
    expect(row.projects.map((p: any) => [p.title, p.task_counts])).toEqual([
      ["Growth", { total: 2, done: 1, in_progress: 0, open: 1 }],
      ["Billing", { total: 1, done: 1, in_progress: 0, open: 0 }],
    ]);
    expect(row.task_counts).toEqual({ total: 3, done: 2, in_progress: 0, open: 1 });
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

// I4: a goal is measured by one or two numbers, reported the way a template
// scoreboard is, and read against the target wherever the goal is read.
describe("initiatives: metrics and the chain up (I4)", () => {
  test("one or two metrics with a key from the name; a value is reported with a source by the owner, its role or an admin", async () => {
    tickingClock();
    const db = fixtures();
    const role = await growthRole(db, [P]);
    await db.insert("users", { name: "Growth bot", is_bot: true });
    const bot = db._tables.users.at(-1)._id;
    const anchor = await db.insert("anchors", { bot_user_id: bot, team_id: TEAM });
    await db.patch(role._id, { anchor_id: anchor });
    await db.insert("conversations", { user_id: ME, team_id: TEAM, session_id: "sess-growth", standing_role_id: role._id, is_private: false });
    const made = await run(create, db, { ...inTeam, title: "Reach 1k teams", owner: "@growth", metrics: [{ name: "Weekly active teams", target: "1,000" }, { name: "Paying teams", target: "40" }] });
    expect(made.row.metrics).toEqual([{ key: "weekly_active_teams", name: "Weekly active teams", target: "1,000" }, { key: "paying_teams", name: "Paying teams", target: "40" }]);
    await expect(run(update, db, { id: "in-1", metrics: [{ name: "A", target: "1" }, { name: "B", target: "2" }, { name: "C", target: "3" }] })).rejects.toThrow("at most 2 metrics");
    await expect(run(update, db, { id: "in-1", metrics: [{ name: "A", target: "" }] })).rejects.toThrow("a name and a target");

    // The role's standing session reports as the owner; a key the goal does not declare is refused; a source is required.
    const r = await run(report, db, { id: "in-1", entries: ["weekly_active_teams=412"], source: "https://x.ai/dash", session_id: "sess-growth" });
    expect(r.written.weekly_active_teams).toMatchObject({ value: "412", source: "https://x.ai/dash" });
    await expect(run(report, db, { id: "in-1", entries: ["churn=3"], source: "ct-1" })).rejects.toThrow("Not a scoreboard key of in-1: churn (declared: weekly_active_teams, paying_teams)");
    await expect(run(report, db, { id: "in-1", entries: ["paying_teams=12"] })).rejects.toThrow("--source must be a link");
    await expect(run(report, db, { id: "in-1", entries: ["paying_teams=12"], source: "ct-1" }, MATE)).rejects.toThrow("Only the owner or a workspace admin");
    await run(report, db, { id: "in-1", entries: ["paying_teams=12"], source: "ct-1", observed_at: 1_700_000_000_000 });
    const row = await db.get(made.id);
    expect(row.scoreboard.paying_teams).toEqual({ value: "12", observed_at: 1_700_000_000_000, source: "ct-1" });

    // Replacing the list keeps the value of a key that survives and drops the rest.
    await run(update, db, { id: "in-1", metrics: [{ name: "Paying teams", target: "50" }] });
    expect((await db.get(made.id)).scoreboard).toEqual({ paying_teams: { value: "12", observed_at: 1_700_000_000_000, source: "ct-1" } });
    await run(update, db, { id: "in-1", metrics: [] });
    expect((await db.get(made.id)).metrics).toBeUndefined();
    expect((await db.get(made.id)).scoreboard).toBeUndefined();
  });

  test("what an area serves: the goals it owns first, then the ones its projects carry, each read against its target with the chain up", async () => {
    const db = fixtures();
    const role = await growthRole(db, [P]);
    await run(create, db, { ...inTeam, title: "Reach 1k teams", metrics: [{ name: "Weekly active teams", target: "1,000" }] });
    await run(create, db, { ...inTeam, title: "Win the private network", parent_initiative_id: "in-1", project_ids: [P], metrics: [{ name: "Brokers live", target: "40" }] });
    await run(create, db, { ...inTeam, title: "Billing", project_ids: [Q], owner: "@growth" });
    await run(create, db, { ...inTeam, title: "Old", project_ids: [P], status: "completed" });
    await run(report, db, { id: "in-2", entries: ["brokers_live=12"], source: "ct-9" });
    const rows = db._tables.initiatives;
    const served = servedInitiatives(rows, { role_id: String(role._id), project_ids: [P] });
    expect(served.map((i) => [i.short_id, i.owned])).toEqual([["in-3", true], ["in-2", false]]);
    expect(served[1].chain).toEqual([{ short_id: "in-1", title: "Reach 1k teams" }]);
    expect(served[1].metrics[0]).toMatchObject({ key: "brokers_live", value: "12", standing: "behind", progress: 0.3 });
    expect(served[0].metrics).toEqual([]);
    // No role: only what the projects carry.
    expect(servedInitiatives(rows, { project_ids: [Q] }).map((i) => i.short_id)).toEqual(["in-3"]);
  });
});

// I5: the intent record. Why and done when are fields; the four lists are
// edited one entry at a time through `record`; every reported number is kept.
describe("initiatives: the intent record (I5)", () => {
  const lastLog = (db: any) => db._tables.org_changes.at(-1);
  const logCount = (db: any) => (db._tables.org_changes ?? []).length;

  test("why and done when are set on create, cleared with null, and logged as the goal's shape", async () => {
    const db = fixtures();
    const made = await run(create, db, { ...inTeam, title: "Reach 1k teams", why: "  Teams are who we sell to.  ", done_when: "A thousand teams ran an agent this week" });
    expect(made.row).toMatchObject({ why: "Teams are who we sell to.", done_when: "A thousand teams ran an agent this week" });

    await run(update, db, { id: "in-1", why: null, done_when: "Two thousand did" });
    const row = await db.get(made.id);
    expect(row.why).toBeUndefined();
    expect(row.done_when).toBe("Two thousand did");
    const logged = lastLog(db);
    expect(logged.kind).toBe("initiative_shape");
    expect(logged.before).toEqual({ why: "Teams are who we sell to.", done_when: "A thousand teams ran an agent this week" });
    expect(logged.after).toEqual({ why: null, done_when: "Two thousand did" });
    // The undo snapshot carries both fields as they were.
    expect(logged.writes).toEqual([{ table: "initiatives", id: made.id, before: logged.before, after: logged.after }]);

    await run(update, db, { id: "in-1", done_when: "  " });
    expect((await db.get(made.id)).done_when).toBeUndefined();
  });

  test("a milestone is added, edited, reached, reopened and removed by key; the next one is the first not reached", async () => {
    tickingClock();
    const db = fixtures();
    const made = await run(create, db, { ...inTeam, title: "Reach 1k teams" });
    const beta = await run(record, db, { id: "in-1", list: "milestones", action: "add", entry: { title: " Private beta open ", date: 2000 } });
    expect(beta).toMatchObject({ id: made.id, short_id: "in-1", scope: null });
    expect(beta.entry).toEqual({ key: "private_beta_open", title: "Private beta open", date: 2000 });
    // A key and a source the client chose are stored as sent.
    const ga = await run(record, db, { id: "in-1", list: "milestones", action: "add", entry: { key: "m-ga", title: "General availability", date: 1000, source: { text: "ct-12 ship by spring" } } });
    expect(ga.entry).toEqual({ key: "m-ga", title: "General availability", date: 1000, source: { kind: "task", ref: "ct-12", quote: "ship by spring" } });
    // The same title again takes a numbered key; a retried add of a known key adds nothing.
    expect((await run(record, db, { id: "in-1", list: "milestones", action: "add", entry: { title: "Private beta open" } })).entry.key).toBe("private_beta_open_2");
    const before = logCount(db);
    const again = await run(record, db, { id: "in-1", list: "milestones", action: "add", entry: { key: "m-ga", title: "General availability" } });
    expect(again.entry).toEqual(ga.entry);
    expect(again.row.milestones.map((m: any) => m.key)).toEqual(["private_beta_open", "m-ga", "private_beta_open_2"]);
    expect(logCount(db)).toBe(before);

    expect((await run(get, db, { id: "in-1" })).next_milestone.key).toBe("m-ga");
    const reached = await run(record, db, { id: "in-1", list: "milestones", action: "close", key: "m-ga", at: 1234 });
    expect(reached.entry.done_at).toBe(1234);
    expect((await run(get, db, { id: "in-1" })).next_milestone.key).toBe("private_beta_open");
    // Reaching it again without a time keeps the first one.
    expect((await run(record, db, { id: "in-1", list: "milestones", action: "close", key: "m-ga" })).entry.done_at).toBe(1234);

    const edited = await run(record, db, { id: "in-1", list: "milestones", action: "edit", key: "m-ga", entry: { title: "GA", done_at: null, source: null } });
    expect(edited.entry).toEqual({ key: "m-ga", title: "GA", date: 1000 });
    await expect(run(record, db, { id: "in-1", list: "milestones", action: "edit", key: "m-ga", entry: { title: " " } })).rejects.toThrow("A milestone needs a title");
    await expect(run(record, db, { id: "in-1", list: "milestones", action: "edit", key: "m-ga", entry: { text: "x" } })).rejects.toThrow("Not a field of a milestone: text");
    await expect(run(record, db, { id: "in-1", list: "milestones", action: "edit", key: "m-ga", entry: { date: "soon" } })).rejects.toThrow("A milestone's date is a time");
    await expect(run(record, db, { id: "in-1", list: "milestones", action: "close", key: "nope" })).rejects.toThrow("No milestone nope on in-1");
    await expect(run(record, db, { id: "in-1", list: "milestones", action: "edit", entry: { title: "x" } })).rejects.toThrow("Name the milestone by its key");

    const gone = await run(record, db, { id: "in-1", list: "milestones", action: "remove", key: "private_beta_open_2" });
    expect(gone.row.milestones.map((m: any) => m.key)).toEqual(["private_beta_open", "m-ga"]);
    // A retried remove finds nothing and changes nothing.
    expect((await run(record, db, { id: "in-1", list: "milestones", action: "remove", key: "private_beta_open_2" })).entry).toBeUndefined();
    await run(record, db, { id: "in-1", list: "milestones", action: "remove", key: "private_beta_open" });
    expect((await run(record, db, { id: "in-1", list: "milestones", action: "remove", key: "m-ga" })).row.milestones).toBeUndefined();
    expect((await run(get, db, { id: "in-1" })).next_milestone).toBeNull();
  });

  test("a question is signed by who asked, answered by close and reopened by clearing the answer; a decision is never closed", async () => {
    tickingClock();
    const db = fixtures();
    const role = await growthRole(db, [P]);
    await db.insert("users", { name: "Growth bot", is_bot: true });
    const anchor = await db.insert("anchors", { bot_user_id: db._tables.users.at(-1)._id, team_id: TEAM });
    await db.patch(role._id, { anchor_id: anchor });
    await db.insert("conversations", { user_id: ME, team_id: TEAM, session_id: "sess-growth", standing_role_id: role._id, is_private: false });
    await run(create, db, { ...inTeam, title: "Reach 1k teams" });

    // A plain member may write the record: the gate is the goal's own.
    const asked = await run(record, db, { id: "in-1", list: "questions", action: "add", entry: { text: "Do we price per seat?" } }, MATE);
    expect(asked.entry).toEqual({ key: "do_we_price_per_seat", text: "Do we price per seat?", at: asked.entry.at, by: "@mate" });
    expect(typeof asked.entry.at).toBe("number");
    // The role's standing session signs as the role; a named asker and time are kept.
    const byRole = await run(record, db, { id: "in-1", list: "questions", action: "add", entry: { text: "Which market first?" }, session_id: "sess-growth" });
    expect(byRole.entry.by).toBe("@growth");
    const named = await run(record, db, { id: "in-1", list: "questions", action: "add", entry: { key: "q3", text: "Who signs?", by: "Dana", at: 42 } });
    expect(named.entry).toEqual({ key: "q3", text: "Who signs?", by: "Dana", at: 42 });

    await expect(run(record, db, { id: "in-1", list: "questions", action: "close", key: "q3" })).rejects.toThrow("An answer needs words");
    const answered = await run(record, db, { id: "in-1", list: "questions", action: "close", key: "q3", answer: " Dana does ", at: 99 });
    expect(answered.entry).toEqual({ key: "q3", text: "Who signs?", by: "Dana", at: 42, answer: "Dana does", answered_at: 99 });
    const reopened = await run(record, db, { id: "in-1", list: "questions", action: "edit", key: "q3", entry: { answer: null } });
    expect(reopened.entry).toEqual({ key: "q3", text: "Who signs?", by: "Dana", at: 42 });

    const decided = await run(record, db, { id: "in-1", list: "decisions", action: "add", entry: { text: "Ship to brokers first", source: { kind: "call", ref: "cl-42:14", by: "Ashot" } } });
    expect(decided.entry).toEqual({ key: "ship_to_brokers_first", text: "Ship to brokers first", at: decided.entry.at, by: "@me", source: { kind: "call", ref: "cl-42:14", by: "Ashot" } });
    await expect(run(record, db, { id: "in-1", list: "decisions", action: "close", key: "ship_to_brokers_first" })).rejects.toThrow("A decision is edited or removed");
    await expect(run(record, db, { id: "in-1", list: "decisions", action: "add", entry: { text: "x", answer: "y" } })).rejects.toThrow("Not a field of a decision: answer");
    await expect(run(record, db, { id: "in-1", list: "decisions", action: "add", entry: { by: "Dana" } })).rejects.toThrow("A decision needs words");
    expect((await run(record, db, { id: "in-1", list: "decisions", action: "edit", key: "ship_to_brokers_first", entry: { text: "Ship to lenders first" } })).entry.text).toBe("Ship to lenders first");
    expect((await run(record, db, { id: "in-1", list: "decisions", action: "remove", key: "ship_to_brokers_first" })).row.decisions).toBeUndefined();

    await expect(run(record, db, { id: "in-1", list: "questions", action: "add", entry: { text: "Mine?" } }, STRANGER)).rejects.toThrow("Initiative not found");
  });

  test("a source is read from text or stored as sent, named by its address, and never recorded twice", async () => {
    const db = fixtures();
    await run(create, db, { ...inTeam, title: "Reach 1k teams" });
    const call = await run(record, db, { id: "in-1", list: "sources", action: "add", entry: { text: 'call:cl-42#14 "our goal is $250 or less per introduction"', by: "Ashot", at: 7 } });
    expect(call.entry).toEqual({ kind: "call", ref: "cl-42:14", quote: "our goal is $250 or less per introduction", by: "Ashot", at: 7 });
    const before = logCount(db);
    // The same address again, in either form, is the entry already there.
    expect((await run(record, db, { id: "in-1", list: "sources", action: "add", entry: { text: "call:CL-42:14" } })).entry).toEqual(call.entry);
    expect((await run(record, db, { id: "in-1", list: "sources", action: "add", entry: { kind: "call", ref: "cl-42:14" } })).row.sources.length).toBe(1);
    expect(logCount(db)).toBe(before);

    const note = await run(record, db, { id: "in-1", list: "sources", action: "add", entry: { text: "Ashot said brokers come first" } });
    expect(note.entry).toEqual({ kind: "note", quote: "Ashot said brokers come first" });
    expect((await run(record, db, { id: "in-1", list: "sources", action: "add", entry: { key: "session:jx7c6zk:142", kind: "session", ref: "jx7c6zk:142" } })).entry).toEqual({ kind: "session", ref: "jx7c6zk:142" });
    await expect(run(record, db, { id: "in-1", list: "sources", action: "add", entry: { text: "  " } })).rejects.toThrow("A source needs an address or the words said");
    await expect(run(record, db, { id: "in-1", list: "sources", action: "add", entry: { kind: "rumor", ref: "x" } })).rejects.toThrow("A source is one of call, chat");
    await expect(run(record, db, { id: "in-1", list: "sources", action: "add", entry: { kind: "task", ref: "ct-1", title: "x" } })).rejects.toThrow("Not a field of a source: title");

    const edited = await run(record, db, { id: "in-1", list: "sources", action: "edit", key: "call:cl-42:14", entry: { quote: "under $250 an introduction", at: null } });
    expect(edited.entry).toEqual({ kind: "call", ref: "cl-42:14", quote: "under $250 an introduction", by: "Ashot" });
    await expect(run(record, db, { id: "in-1", list: "sources", action: "edit", key: "session:jx7c6zk:142", entry: { kind: "call", ref: "cl-42:14" } })).rejects.toThrow("already on the record");
    await expect(run(record, db, { id: "in-1", list: "sources", action: "close", key: "call:cl-42:14" })).rejects.toThrow("A source is edited or removed");
    const gone = await run(record, db, { id: "in-1", list: "sources", action: "remove", key: "note:ashot said brokers come first" });
    expect(gone.row.sources.map((s: any) => s.kind)).toEqual(["call", "session"]);
  });

  test("a different entry under a key already on the list is kept, and a retry is still one entry", async () => {
    const db = fixtures();
    await run(create, db, { ...inTeam, title: "Reach 1k teams" });
    // Two teammates' questions slug to one key before either has synced.
    const first = await run(record, db, { id: "in-1", list: "questions", action: "add", entry: { key: "entry", text: "Сколько стоит место?", at: 5, by: "@me" } });
    const second = await run(record, db, { id: "in-1", list: "questions", action: "add", entry: { key: "entry", text: "Кто владеет запуском?", at: 6, by: "@mate" } }, MATE);
    expect(second.entry).toEqual({ key: "entry_2", text: "Кто владеет запуском?", at: 6, by: "@mate" });
    expect(second.row.questions).toEqual([first.entry, second.entry]);
    const before = logCount(db);
    const retried = await run(record, db, { id: "in-1", list: "questions", action: "add", entry: { key: "entry", text: "Сколько стоит место?", at: 5, by: "@me" } });
    expect(retried.entry).toEqual(first.entry);
    expect(retried.row.questions).toHaveLength(2);
    expect(logCount(db)).toBe(before);
  });

  test("an answer said twice is one answer, a time is a real one, and an entry put back lands where it sat", async () => {
    tickingClock();
    const db = fixtures();
    await run(create, db, { ...inTeam, title: "Reach 1k teams" });
    await run(record, db, { id: "in-1", list: "questions", action: "add", entry: { key: "q1", text: "Per seat?", at: 42 } });
    const answered = await run(record, db, { id: "in-1", list: "questions", action: "close", key: "q1", answer: "Per seat" });
    const before = logCount(db);
    const again = await run(record, db, { id: "in-1", list: "questions", action: "close", key: "q1", answer: "Per seat" });
    expect(again.entry.answered_at).toBe(answered.entry.answered_at);
    expect(logCount(db)).toBe(before);

    await run(record, db, { id: "in-1", list: "milestones", action: "add", entry: { key: "b", title: "B" } });
    await expect(run(record, db, { id: "in-1", list: "milestones", action: "close", key: "b", at: NaN })).rejects.toThrow("When a milestone was reached is a time");
    await expect(run(record, db, { id: "in-1", list: "milestones", action: "close", key: "b", at: 0 })).rejects.toThrow("When a milestone was reached is a time");
    // Clearing the date of a question keeps the one it had.
    expect((await run(record, db, { id: "in-1", list: "questions", action: "edit", key: "q1", entry: { at: null, text: "Per seat, or flat?" } })).entry.at).toBe(42);
    const back = await run(record, db, { id: "in-1", list: "milestones", action: "add", entry: { key: "a", title: "A" }, index: 0 });
    expect(back.row.milestones.map((m: any) => m.key)).toEqual(["a", "b"]);
    // An entry put back unsigned stays unsigned: null says nobody, where no `by` is signed by the caller.
    expect((await run(record, db, { id: "in-1", list: "decisions", action: "add", entry: { key: "d", text: "D", at: 9, by: null } })).entry).toEqual({ key: "d", text: "D", at: 9 });
  });

  test("a stored source follows the address rules the text reader follows", async () => {
    const db = fixtures();
    await run(create, db, { ...inTeam, title: "Reach 1k teams" });
    await expect(run(record, db, { id: "in-1", list: "sources", action: "add", entry: { kind: "link", ref: "javascript:alert(1)" } })).rejects.toThrow("A link is an http or https address");
    await expect(run(record, db, { id: "in-1", list: "decisions", action: "add", entry: { text: "D", source: { kind: "link", ref: "/settings" } } })).rejects.toThrow("A link is an http or https address");
    expect((await run(record, db, { id: "in-1", list: "sources", action: "add", entry: { kind: "call", ref: "CL-42#14" } })).entry).toEqual({ kind: "call", ref: "cl-42:14" });
    expect((await db.get((await run(get, db, { id: "in-1" }))._id)).sources).toHaveLength(1);
  });

  test("each list holds its limit and no more", async () => {
    const db = fixtures();
    const made = await run(create, db, { ...inTeam, title: "Reach 1k teams" });
    const entryOf = {
      milestones: (n: number) => ({ key: `m${n}`, title: `Step ${n}` }),
      questions: (n: number) => ({ key: `q${n}`, text: `Question ${n}`, at: n }),
      decisions: (n: number) => ({ key: `d${n}`, text: `Decision ${n}`, at: n }),
      sources: (n: number) => ({ kind: "task", ref: `ct-${n}` }),
    };
    for (const [name, max] of Object.entries(INITIATIVE_RECORD_MAX)) {
      const list = name as keyof typeof entryOf;
      // One short of the limit as stored, so the test makes two writes a list.
      await db.patch(made.id, { [list]: Array.from({ length: max - 1 }, (_, i) => entryOf[list](i + 1)) });
      expect((await run(record, db, { id: "in-1", list, action: "add", entry: entryOf[list](max) })).row[list].length).toBe(max);
      await expect(run(record, db, { id: "in-1", list, action: "add", entry: entryOf[list](max + 1) })).rejects.toThrow(`A goal holds at most ${max} ${list}`);
      expect((await db.get(made.id))[list].length).toBe(max);
    }
  });

  test("a record write is logged as the goal's shape, that one list before and after, with the snapshot an undo restores", async () => {
    const db = fixtures();
    const made = await run(create, db, { ...inTeam, title: "Reach 1k teams" });
    const first = await run(record, db, { id: "in-1", list: "milestones", action: "add", entry: { title: "Private beta open" } });
    let logged = lastLog(db);
    expect(logged).toMatchObject({ kind: "initiative_shape", workspace: WS, subject: { type: "initiative", id: made.id, short_id: "in-1" } });
    expect(logged.before).toEqual({ milestones: null });
    expect(logged.after).toEqual({ milestones: [first.entry] });
    expect(logged.writes).toEqual([{ table: "initiatives", id: made.id, before: { milestones: null }, after: { milestones: [first.entry] } }]);
    expect(db._tables.org_change_batches.at(-1)).toMatchObject({ door: "initiative", kinds: { initiative_shape: 1 } });

    const count = logCount(db);
    const reached = await run(record, db, { id: "in-1", list: "milestones", action: "close", key: "private_beta_open", at: 5 });
    logged = lastLog(db);
    expect(logCount(db)).toBe(count + 1);
    expect(logged.before).toEqual({ milestones: [first.entry] });
    expect(logged.after).toEqual({ milestones: [reached.entry] });
    // An edit that says what is already there writes nothing.
    await run(record, db, { id: "in-1", list: "milestones", action: "edit", key: "private_beta_open", entry: { title: "Private beta open" } });
    expect(logCount(db)).toBe(count + 1);

    // Undo puts the list back as it was, and redo reaches the milestone again.
    const batch = db._tables.org_change_batches.at(-1)._id;
    await performUndo(ctxOf(db), ME as any, { batch });
    expect((await db.get(made.id)).milestones).toEqual([first.entry]);
    await performUndo(ctxOf(db), ME as any, { batch }, true);
    expect((await db.get(made.id)).milestones).toEqual([reached.entry]);
  });

  test("a goal is born with its first milestones and the sources that stated it", async () => {
    const db = fixtures();
    const made = await run(create, db, { ...inTeam, title: "Reach 1k teams", milestones: [{ title: "Private beta open", date: 2000 }, { title: "General availability" }], sources: [{ text: "ct-12" }, { text: "CT-12 again" }, { kind: "link", ref: "https://x.ai/plan" }] });
    expect(made.row.milestones).toEqual([{ key: "private_beta_open", title: "Private beta open", date: 2000 }, { key: "general_availability", title: "General availability" }]);
    expect(made.row.sources).toEqual([{ kind: "task", ref: "ct-12" }, { kind: "link", ref: "https://x.ai/plan" }]);
    await expect(run(create, db, { ...inTeam, title: "Bad", milestones: [{ date: 1 }] })).rejects.toThrow("A milestone needs a title");
  });

  test("every reported value is kept oldest first, read as a trend, and leaves with its metric", async () => {
    tickingClock();
    const db = fixtures();
    const made = await run(create, db, { ...inTeam, title: "Reach 1k teams", metrics: [{ name: "Weekly active teams", target: "1,000" }, { name: "Paying teams", target: "40" }] });
    const say = (entries: string[], observed_at: number) => run(report, db, { id: "in-1", entries, source: "https://x.ai/dash", observed_at });
    await say(["weekly_active_teams=380"], 2000);
    await say(["weekly_active_teams=412", "paying_teams=9"], 3000);
    // An earlier observation lands in its place and never rewinds the current
    // number: the scoreboard is the latest of the history, whatever was reported last.
    const backfilled = await say(["weekly_active_teams=350"], 1000);
    expect(backfilled.row.scoreboard.weekly_active_teams).toEqual({ value: "412", observed_at: 3000, source: "https://x.ai/dash" });
    // A second report for one moment replaces the first.
    const r = await say(["weekly_active_teams=415"], 3000);
    expect(r.row.score_history.weekly_active_teams.map((s: any) => [s.value, s.observed_at])).toEqual([["350", 1000], ["380", 2000], ["415", 3000]]);
    expect(r.row.score_history.paying_teams).toEqual([{ value: "9", observed_at: 3000, source: "https://x.ai/dash" }]);
    expect(r.row.scoreboard.weekly_active_teams.value).toBe("415");

    const shown = await run(get, db, { id: "in-1" });
    expect(shown.trends.weekly_active_teams).toMatchObject({ direction: "up", toward: true, delta: 35 });
    expect(shown.trends.paying_teams.direction).toBe("unknown");

    // A value reported before the history existed opens it on the next report.
    await db.patch(made.id, { score_history: undefined });
    const next = await say(["paying_teams=12"], 4000);
    expect(next.row.score_history).toEqual({ paying_teams: [{ value: "9", observed_at: 3000, source: "https://x.ai/dash" }, { value: "12", observed_at: 4000, source: "https://x.ai/dash" }] });

    // A metric that goes takes its history; the one that stays keeps it.
    await say(["weekly_active_teams=420"], 5000);
    // A renamed metric keeps its number and its history under the key its new name reads as.
    const renamed = await run(update, db, { id: "in-1", metrics: [{ name: "Weekly active teems", target: "1,000" }, { key: "paying_teams", name: "Paying teams", target: "40" }] });
    expect(renamed.row.metrics.map((m: any) => m.key)).toEqual(["weekly_active_teems", "paying_teams"]);
    expect(renamed.row.scoreboard.weekly_active_teems.value).toBe("420");
    expect(renamed.row.score_history.weekly_active_teems.map((s: any) => s.value)).toEqual(["415", "420"]);
    expect(Object.keys(renamed.row.score_history).sort()).toEqual(["paying_teams", "weekly_active_teems"]);
    await run(update, db, { id: "in-1", metrics: [{ name: "Weekly active teams", target: "1,000" }, { name: "Paying teams", target: "40" }] });
    expect((await db.get(made.id)).score_history.weekly_active_teams).toHaveLength(2);
    await run(update, db, { id: "in-1", metrics: [{ name: "Paying teams", target: "50" }] });
    const row = await db.get(made.id);
    expect(Object.keys(row.score_history)).toEqual(["paying_teams"]);
    expect(row.score_history.paying_teams.length).toBe(2);
    // The undo snapshot of that edit holds the values and the history that went.
    const write = lastLog(db).writes[0];
    expect(Object.keys(write.before.score_history).sort()).toEqual(["paying_teams", "weekly_active_teams"]);
    expect(write.before.scoreboard.weekly_active_teams.value).toBe("420");
    await run(update, db, { id: "in-1", metrics: [] });
    expect((await db.get(made.id)).score_history).toBeUndefined();
  });
});
