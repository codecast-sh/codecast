import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { currentManagers, managersMap, onePersonShape, performSetManagers, rolePeopleIds } from "./orgPeople";
import { performCreateRole, performSetReports, performSetRoleManagers } from "./orgRoles";
import { buildLadder } from "./sessionDecisions";
import { escalationTargets } from "./decisionHandoff";
import { computeOrgWhere } from "./orgWhere";
import { listSessionOwnerIds, stampSeatOwners } from "./sessionOwners";
import { foldOrgManagers } from "./migrations";

// A role with several managers, all equal (docs/architecture/org-people.md
// P3), and the one home for who reports to a role.

const ADMIN = "u".repeat(31) + "a";
const LEAD = "u".repeat(31) + "l";
const IC = "u".repeat(31) + "i";
const OTHER = "u".repeat(31) + "o";
const TEAM = "teams_acme" as any;
const NOW = 1_800_000_000_000;

function fixtures() {
  const member = (id: string, user: string, role = "member") => ({ _id: id, user_id: user, team_id: TEAM, role, joined_at: 1, visibility: "full" });
  return makeFakeDb({
    users: [
      { _id: ADMIN, name: "Admin", email: "a@x.ai" },
      { _id: LEAD, name: "Lead", email: "l@x.ai" },
      { _id: IC, name: "Ic", email: "i@x.ai" },
      { _id: OTHER, name: "Other", email: "o@x.ai" },
    ],
    team_memberships: [member("m1", ADMIN, "admin"), member("m2", LEAD), member("m3", IC), member("m4", OTHER)],
    teams: [{ _id: TEAM, name: "Acme", features: { org: true } }],
    counters: [], org_roles: [], org_role_history: [], conversations: [], session_owners: [], managed_sessions: [], messages: [],
    user_presence: [], pending_messages: [], devices: [], anchors: [], agent_tasks: [], docs: [], projects: [], plans: [], org_changes: [],
  });
}
const ctxOf = (db: any) => ({ db, scheduler: { runAfter: async () => null } }) as any;
const role = (db: any, handle: string, reportsTo: string) =>
  performCreateRole(ctxOf(db), ADMIN as any, { name: handle, handle, team_id: TEAM, reports_to: { kind: "user", user_id: reportsTo as any } });
const user = (id: string) => ({ kind: "user" as const, user_id: id as any });
const roleRef = (r: any) => ({ kind: "role" as const, role_id: r._id });
const teamRows = async (db: any) => [
  await db.query("team_memberships").withIndex("by_team_id", (q: any) => q.eq("team_id", TEAM)).collect(),
  await db.query("org_roles").withIndex("by_team", (q: any) => q.eq("team_id", TEAM)).collect(),
];

describe("a role with several equal managers", () => {
  test("sets the whole list: the first is drawn, the rest kept beside it; where names them all", async () => {
    const db = fixtures();
    const eng = await role(db, "eng", LEAD);
    const set = await performSetRoleManagers(ctxOf(db), ADMIN as any, { role_id: eng._id, managers: [user(LEAD), user(OTHER)] });
    expect(set.reports_to).toEqual(user(LEAD));
    expect(set.also_reports_to).toEqual([user(OTHER)]);
    const where = await computeOrgWhere(ctxOf(db), ADMIN as any, TEAM, null);
    expect(where!.roles.find((r) => r.handle === "eng")!.reports_to).toBe("Lead and Other");
    // A move redraws one line and keeps the other.
    const again = await performSetRoleManagers(ctxOf(db), ADMIN as any, { role_id: eng._id, managers: [user(OTHER)] });
    expect([again.reports_to, again.also_reports_to]).toEqual([user(OTHER), undefined]);
  });

  test("refuses a loop through any line, people and roles alike", async () => {
    const db = fixtures();
    const eng = await role(db, "eng", LEAD);
    await performSetManagers(ctxOf(db), ADMIN as any, { team_id: TEAM, user_id: IC as any, managers: [roleRef(eng)] });
    await expect(performSetRoleManagers(ctxOf(db), ADMIN as any, { role_id: eng._id, managers: [user(LEAD), user(IC)] })).rejects.toThrow("Cycle");
    // And from the person's side: Lead cannot report to a role that has Lead among its managers.
    await expect(performSetManagers(ctxOf(db), ADMIN as any, { team_id: TEAM, user_id: LEAD as any, managers: [roleRef(eng)] })).rejects.toThrow("Cycle");
  });

  test("the standing session is owned by every person among its managers", async () => {
    const db = fixtures();
    await db.insert("conversations", { _id: "conv_seat", user_id: ADMIN, team_id: TEAM, session_id: "s", status: "active" } as any);
    await stampSeatOwners(ctxOf(db), "conv_seat" as any, { reports_to: user(LEAD), also_reports_to: [user(OTHER), { kind: "role", role_id: "r_x" as any }] }, ADMIN as any);
    expect((await listSessionOwnerIds(ctxOf(db), "conv_seat" as any)).map(String).sort()).toEqual([LEAD, OTHER].sort());
  });

  test("a hand's decision reaches every person each line ends at; the ladder lists every role", async () => {
    const db = fixtures();
    const head = await role(db, "head", ADMIN);
    const eng = await role(db, "eng", LEAD);
    await performSetRoleManagers(ctxOf(db), ADMIN as any, { role_id: eng._id, managers: [user(LEAD), roleRef(head)] });
    const ladder = await buildLadder(ctxOf(db), await db.get(eng._id), NOW);
    expect(ladder.firstPersonId).toBe(LEAD as any);
    expect(ladder.people.map(String).sort()).toEqual([ADMIN, LEAD].sort());
    expect(ladder.hops.map((h) => String(h.role_id))).toEqual([String(eng._id), String(head._id)]);
  });

  test("a person's escalation to a role manager reaches every person above that role", async () => {
    const db = fixtures();
    const eng = await role(db, "eng", LEAD);
    await performSetRoleManagers(ctxOf(db), ADMIN as any, { role_id: eng._id, managers: [user(LEAD), user(OTHER)] });
    await performSetManagers(ctxOf(db), ADMIN as any, { team_id: TEAM, user_id: IC as any, managers: [roleRef(eng)] });
    expect((await escalationTargets(ctxOf(db), TEAM, IC as any, IC as any)).sort()).toEqual([LEAD, OTHER].sort() as any);
  });
});

describe("one home for who reports to a role", () => {
  test("cast role reports writes the person's managers, and both sides read it", async () => {
    const db = fixtures();
    const eng = await role(db, "eng", LEAD);
    await performSetManagers(ctxOf(db), ADMIN as any, { team_id: TEAM, user_id: IC as any, managers: [user(OTHER)] });
    const r = await performSetReports(ctxOf(db), ADMIN as any, { role_id: eng._id, add: [IC as any] });
    expect(r.reports).toEqual([IC]);
    // Added beside the person they already report to, never in their place.
    expect(await currentManagers(ctxOf(db), TEAM, IC as any)).toEqual([user(OTHER), roleRef(eng)]);
    expect((await db.get(eng._id)).reports_user_ids).toBeUndefined();
    const [memberships, roles] = await teamRows(db);
    expect(rolePeopleIds(await db.get(eng._id), memberships, roles)).toEqual([IC]);
    await performSetReports(ctxOf(db), ADMIN as any, { role_id: eng._id, remove: [IC as any] });
    expect(await currentManagers(ctxOf(db), TEAM, IC as any)).toEqual([user(OTHER)]);
  });

  test("a role's own list means goals only: never a manager, until the migration settles it", async () => {
    const db = fixtures();
    const eng = await role(db, "eng", LEAD);
    await db.patch(eng._id, { reports_user_ids: [IC] });
    expect(await currentManagers(ctxOf(db), TEAM, IC as any)).toEqual([]);
    const [memberships, roles] = await teamRows(db);
    expect(rolePeopleIds(await db.get(eng._id), memberships, roles)).toEqual([IC]);
    // Choosing the role as a manager makes the goals entry redundant: it goes.
    await performSetManagers(ctxOf(db), IC as any, { team_id: TEAM, user_id: IC as any, managers: [roleRef(eng), user(OTHER)] });
    expect((await db.get(eng._id)).reports_user_ids).toBeUndefined();
    expect(await currentManagers(ctxOf(db), TEAM, IC as any)).toEqual([roleRef(eng), user(OTHER)]);
  });

  test("two founders keeping goals on each other's leads never become a loop", async () => {
    const db = fixtures();
    const eng = await role(db, "eng", ADMIN);
    const growth = await role(db, "growth", LEAD);
    await db.patch(eng._id, { reports_user_ids: [LEAD] });
    await db.patch(growth._id, { reports_user_ids: [ADMIN] });
    const run = (foldOrgManagers as any)._handler ?? (foldOrgManagers as any).handler;
    await run(ctxOf(db), { dryRun: false });
    // One of the two settles as a line; the other would close the loop and stays goals only.
    const admin = await currentManagers(ctxOf(db), TEAM, ADMIN as any);
    const lead = await currentManagers(ctxOf(db), TEAM, LEAD as any);
    expect(admin.length + lead.length).toBe(1);
    const left = [(await db.get(eng._id)).reports_user_ids, (await db.get(growth._id)).reports_user_ids].filter(Boolean);
    expect(left.length).toBe(1);
  });

  test("moving a role never changes what an old goals entry means", async () => {
    const db = fixtures();
    const eng = await role(db, "eng", ADMIN);
    await db.patch(eng._id, { reports_user_ids: [ADMIN] });
    await performSetRoleManagers(ctxOf(db), ADMIN as any, { role_id: eng._id, managers: [user(LEAD)] });
    expect(await currentManagers(ctxOf(db), TEAM, ADMIN as any)).toEqual([]);
    // And moving it back under that person is not refused as a loop.
    const back = await performSetRoleManagers(ctxOf(db), ADMIN as any, { role_id: eng._id, managers: [user(ADMIN)] });
    expect(back.reports_to).toEqual(user(ADMIN));
  });

  test("the fold migration moves both older lists into managers, dry by default", async () => {
    const db = fixtures();
    const eng = await role(db, "eng", LEAD);
    await db.patch(eng._id, { reports_user_ids: [IC] });
    await db.patch("m4", { reports_to_user_id: LEAD });
    const run = (foldOrgManagers as any)._handler ?? (foldOrgManagers as any).handler;
    const dry = await run(ctxOf(db), {});
    expect([dry.dryRun, dry.people]).toEqual([true, 2]);
    expect((await db.get(eng._id)).reports_user_ids).toEqual([IC]);
    await run(ctxOf(db), { dryRun: false });
    expect((await db.get(eng._id)).reports_user_ids).toBeUndefined();
    expect((await db.get("m3")).managers).toEqual([roleRef(eng)]);
    expect([(await db.get("m4")).managers, (await db.get("m4")).reports_to_user_id]).toEqual([[user(LEAD)], undefined]);
    expect((await run(ctxOf(db), { dryRun: false })).people).toBe(0);
  });

  test("an old entry that would loop keeps its goals-only meaning: no manager, no cycle, and moves still work", async () => {
    const db = fixtures();
    const eng = await role(db, "eng", ADMIN);
    await db.patch(eng._id, { reports_user_ids: [ADMIN] });
    // Not a reporting line: the person side never sees it...
    expect(await currentManagers(ctxOf(db), TEAM, ADMIN as any)).toEqual([]);
    // ...the role still keeps their goals...
    const [memberships, roles] = await teamRows(db);
    expect(rolePeopleIds(await db.get(eng._id), memberships, roles)).toEqual([ADMIN]);
    // ...and moving the role is not refused as a loop.
    const moved = await performSetRoleManagers(ctxOf(db), ADMIN as any, { role_id: eng._id, managers: [user(ADMIN), user(LEAD)] });
    expect(moved.also_reports_to).toEqual([user(LEAD)]);
    // A founder asking a role they manage to keep their goals gets the same.
    const ops = await role(db, "ops", LEAD);
    const r = await performSetReports(ctxOf(db), ADMIN as any, { role_id: ops._id, add: [LEAD as any] });
    expect(r.reports).toEqual([LEAD]);
    expect(await currentManagers(ctxOf(db), TEAM, LEAD as any)).toEqual([]);
    // The migration leaves it where it is.
    const run = (foldOrgManagers as any)._handler ?? (foldOrgManagers as any).handler;
    await run(ctxOf(db), { dryRun: false });
    expect((await db.get(eng._id)).reports_user_ids).toEqual([ADMIN]);
  });

  test("the one-person shape an older client sends replaces only the person managers", () => {
    const before = [{ kind: "role" as const, role_id: "r_eng" as any }, user(OTHER), user(ADMIN)];
    expect(onePersonShape(before, LEAD as any)).toEqual([{ kind: "role", role_id: "r_eng" }, user(LEAD)]);
    expect(onePersonShape(before, null)).toEqual([{ kind: "role", role_id: "r_eng" }]);
  });
});
