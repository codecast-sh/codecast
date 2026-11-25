import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { computePersonDetail, performSetManagers, performSetProfile } from "./orgPeople";
import { performCreateRole, performReparentRole } from "./orgRoles";
import { escalationTargets } from "./decisionHandoff";
import { computeOrgWhere } from "./orgWhere";
import { computeOrgRoles, computeOrgTree } from "./org";

// A person reports to a person: who may set it, the loop and boundary guards,
// and the tree carrying it without widening what anyone reads.

const ADMIN = "u".repeat(31) + "a";
const LEAD = "u".repeat(31) + "l";
const IC = "u".repeat(31) + "i";
const OTHER = "u".repeat(31) + "o";
const STRANGER = "u".repeat(31) + "s";
const TEAM = "teams_acme" as any;
const NOW = 1_800_000_000_000;

function fixtures(extra: Record<string, any[]> = {}) {
  const member = (id: string, user: string, role = "member") => ({ _id: id, user_id: user, team_id: TEAM, role, joined_at: 1, visibility: "full" });
  return makeFakeDb({
    users: [
      { _id: ADMIN, name: "Admin", email: "a@x.ai" },
      { _id: LEAD, name: "Lead", email: "l@x.ai" },
      { _id: IC, name: "Ic", email: "i@x.ai" },
      { _id: OTHER, name: "Other", email: "o@x.ai" },
      { _id: STRANGER, name: "Stranger", email: "s@x.ai" },
    ],
    team_memberships: [member("m1", ADMIN, "admin"), member("m2", LEAD), member("m3", IC), member("m4", OTHER)],
    teams: [{ _id: TEAM, name: "Acme", features: { org: true } }],
    counters: [], org_roles: [], conversations: [], session_owners: [], managed_sessions: [], messages: [],
    user_presence: [], pending_messages: [], devices: [], anchors: [],
    ...extra,
  });
}
const ctxOf = (db: any) => ({ db }) as any;
const membership = (db: any, user: string) => db.query("team_memberships").withIndex("by_user_team", (q: any) => q.eq("user_id", user).eq("team_id", TEAM)).first();
// The one person someone reports to, for the single-manager cases.
const managerOf = async (db: any, user: string) => ((await membership(db, user))?.managers ?? []).map((m: any) => m.user_id ?? m.role_id)[0] ?? null;
const managerIds = async (db: any, user: string) => ((await membership(db, user))?.managers ?? []).map((m: any) => m.user_id ?? m.role_id);
const setManagers = (db: any, caller: string, user: string, managers: any[]) =>
  performSetManagers(ctxOf(db), caller as any, { team_id: TEAM, user_id: user as any, managers });
const move = (db: any, caller: string, user: string, to: string | null) => setManagers(db, caller, user, to ? [{ kind: "user", user_id: to }] : []);

describe("orgPeople.reparentPerson", () => {
  test("an admin sets and moves who a person reports to, and clears it", async () => {
    const db = fixtures();
    expect((await move(db, ADMIN, IC, LEAD)).changed).toBe(true);
    expect(await managerOf(db, IC)).toBe(LEAD);
    await move(db, ADMIN, IC, OTHER);
    expect(await managerOf(db, IC)).toBe(OTHER);
    expect((await move(db, ADMIN, IC, OTHER)).changed).toBe(false);
    await move(db, ADMIN, IC, null);
    expect(await managerOf(db, IC)).toBe(null);
  });

  test("the person sets any list; a manager changes only what they answer for; a bystander nothing", async () => {
    const db = fixtures();
    await move(db, IC, IC, LEAD);
    expect(await managerOf(db, IC)).toBe(LEAD);
    // Someone who does not manage Ic cannot make themself Ic's manager.
    await expect(setManagers(db, OTHER, IC, [{ kind: "user", user_id: LEAD }, { kind: "user", user_id: OTHER }])).rejects.toThrow("Only a team admin");
    // Ic may add Other; then Lead cannot add Admin (not Lead's to answer for).
    await setManagers(db, IC, IC, [{ kind: "user", user_id: LEAD }, { kind: "user", user_id: OTHER }]);
    expect(await managerIds(db, IC)).toEqual([LEAD, OTHER]);
    await expect(setManagers(db, LEAD, IC, [{ kind: "user", user_id: LEAD }, { kind: "user", user_id: OTHER }, { kind: "user", user_id: ADMIN }])).rejects.toThrow("Only a team admin");
    // Replacing Lead is not Other's to do; each lets themself go.
    await expect(move(db, OTHER, IC, OTHER)).rejects.toThrow("Only a team admin");
    await move(db, LEAD, IC, OTHER);
    await move(db, OTHER, IC, null);
    expect(await managerIds(db, IC)).toEqual([]);
  });

  test("refuses a loop, a self report, and anyone outside the team", async () => {
    const db = fixtures();
    await move(db, ADMIN, IC, LEAD);
    await move(db, ADMIN, LEAD, OTHER);
    await expect(move(db, ADMIN, OTHER, IC)).rejects.toThrow("Cycle");
    await expect(move(db, ADMIN, IC, IC)).rejects.toThrow("themself");
    await expect(move(db, ADMIN, IC, STRANGER)).rejects.toThrow("member of the same team");
    await expect(move(db, ADMIN, STRANGER, LEAD)).rejects.toThrow("not a member");
    await expect(move(db, STRANGER, IC, STRANGER)).rejects.toThrow("Not a member");
  });
});

describe("org tree people", () => {
  test("both tree payloads carry who a person reports to; a manager who left reads as nobody", async () => {
    const db = fixtures();
    await move(db, ADMIN, IC, LEAD);
    await move(db, ADMIN, OTHER, LEAD);
    await db.delete("m2"); // the lead leaves the team
    await move(db, ADMIN, ADMIN, OTHER);
    for (const tree of [await computeOrgTree(ctxOf(db), ADMIN as any, TEAM, NOW), await computeOrgRoles(ctxOf(db), ADMIN as any, TEAM, NOW)]) {
      const by = new Map(tree.people.map((p: any) => [String(p.user_id), p.managers?.[0]?.user_id ?? null]));
      expect(by.get(ADMIN)).toBe(OTHER);
      expect(by.get(IC)).toBe(null);
      expect(by.get(OTHER)).toBe(null);
    }
  });

  test("reporting to someone shows them nothing more: a private session stays out of the manager's tree", async () => {
    const conv = (id: string, user: string, extra: any = {}) => ({
      _id: id, user_id: user, team_id: TEAM, session_id: id, title: id, status: "active", message_count: 3,
      started_at: NOW - 1000, updated_at: NOW - 1000, last_message_at: NOW - 1000, agent_type: "claude_code", ...extra,
    });
    const db = fixtures({ conversations: [conv("conv_private", IC, { is_private: true }), conv("conv_shared", IC, { is_private: false, team_visibility: "full", auto_shared: true })] });
    const before = await computeOrgTree(ctxOf(db), LEAD as any, TEAM, NOW);
    await move(db, ADMIN, IC, LEAD);
    const after = await computeOrgTree(ctxOf(db), LEAD as any, TEAM, NOW);
    const ids = (t: any) => t.people.flatMap((p: any) => p.sessions.map((s: any) => s._id)).sort();
    expect(ids(after)).toEqual(ids(before));
    expect(ids(after)).toContain("conv_shared");
    expect(ids(after)).not.toContain("conv_private");
  });

  test("a role keeps reporting to its person when that person moves under another", async () => {
    const db = fixtures();
    const role = await performCreateRole(ctxOf(db), ADMIN as any, { name: "Growth", handle: "growth", team_id: TEAM, reports_to: { kind: "user", user_id: IC as any } });
    await move(db, ADMIN, IC, LEAD);
    expect((await db.get(role._id)).reports_to).toEqual({ kind: "user", user_id: IC });
  });
});

describe("orgPeople.setProfile", () => {
  const set = (db: any, caller: string, user: string, p: Record<string, unknown>) =>
    performSetProfile(ctxOf(db), caller as any, { team_id: TEAM, user_id: user as any, ...p } as any, NOW);

  test("the person sets their own profile; the tree, roles and detail carry it", async () => {
    const db = fixtures();
    expect((await set(db, IC, IC, { title: "Head of Sales", focus: "pipeline, pricing", labels: ["Sales", "GTM"], about: "Bring me deals." })).changed).toBe(true);
    await move(db, ADMIN, IC, LEAD);
    const roles = await computeOrgRoles(ctxOf(db), ADMIN as any, TEAM, NOW);
    const ic: any = roles.people.find((p: any) => p.user_id === IC);
    expect(ic).toMatchObject({ title: "Head of Sales", focus: "pipeline, pricing", labels: ["sales", "gtm"] });
    expect(ic.about).toBeUndefined();
    const tree = await computeOrgTree(ctxOf(db), ADMIN as any, TEAM, NOW);
    expect((tree.people as any[]).find((p) => p.user_id === IC).title).toBe("Head of Sales");
    const detail = await computePersonDetail(ctxOf(db), ADMIN as any, TEAM, IC as any);
    expect(detail).toMatchObject({ about: "Bring me deals.", reports_to: ["Lead"], profile_updated: { by: "Ic", at: NOW } });
    expect((await computePersonDetail(ctxOf(db), ADMIN as any, TEAM, LEAD as any))!.reports).toEqual(["Ic"]);
  });

  test("an admin may edit anyone's; another member may not", async () => {
    const db = fixtures();
    await set(db, ADMIN, IC, { title: "Engineer" });
    await expect(set(db, OTHER, IC, { title: "Intern" })).rejects.toThrow("Only the person or a team admin");
    await expect(set(db, STRANGER, IC, { title: "x" })).rejects.toThrow("Not a member");
  });

  test("an empty value clears the field, and an unchanged write changes nothing", async () => {
    const db = fixtures();
    await set(db, IC, IC, { title: "Engineer", labels: ["infra"] });
    expect((await set(db, IC, IC, { title: "Engineer" })).changed).toBe(false);
    await set(db, IC, IC, { title: "", labels: [] });
    const m = await db.query("team_memberships").withIndex("by_user_team", (q: any) => q.eq("user_id", IC).eq("team_id", TEAM)).first();
    expect(m.title).toBeUndefined();
    expect(m.labels).toBeUndefined();
  });
});

describe("a person reports to a role (org-people.md P2)", () => {
  const under = (db: any, caller: string, user: string, to: any) => setManagers(db, caller, user, to ? [to] : []);
  const growth = (db: any, reportsTo = LEAD) =>
    performCreateRole(ctxOf(db), ADMIN as any, { name: "Growth", handle: "growth", team_id: TEAM, reports_to: { kind: "user", user_id: reportsTo as any } });

  test("an admin files a person under a role; the tree, where and detail say so", async () => {
    const db = fixtures();
    const role = await growth(db);
    expect((await under(db, ADMIN, IC, { kind: "role", role_id: role._id })).changed).toBe(true);
    expect(await managerIds(db, IC)).toEqual([role._id]);
    const roles = await computeOrgRoles(ctxOf(db), ADMIN as any, TEAM, NOW);
    expect((roles.people as any[]).find((p) => p.user_id === IC)).toMatchObject({ managers: [{ kind: "role", role_id: role._id }] });
    const where = await computeOrgWhere(ctxOf(db), ADMIN as any, TEAM, null);
    expect(where!.people.find((p) => p.name === "Ic")!.reports_to).toBe("@growth");
    expect((await computePersonDetail(ctxOf(db), ADMIN as any, TEAM, IC as any))!.reports_to).toEqual(["@growth"]);
    // A person and a role, side by side and equal.
    await setManagers(db, ADMIN, IC, [{ kind: "role", role_id: role._id }, { kind: "user", user_id: OTHER }]);
    expect((await computePersonDetail(ctxOf(db), ADMIN as any, TEAM, IC as any))!.reports_to).toEqual(["@growth", "Other"]);
    expect((await computeOrgWhere(ctxOf(db), ADMIN as any, TEAM, null))!.people.find((p) => p.name === "Ic")!.reports_to).toBe("@growth, Other");
  });

  test("someone who manages a person may file them under a role they manage; a bystander may not", async () => {
    const db = fixtures();
    const role = await growth(db);
    // Lead manages the role but not Ic yet: refused.
    await expect(under(db, LEAD, IC, { kind: "role", role_id: role._id })).rejects.toThrow("Only a team admin");
    await under(db, ADMIN, IC, { kind: "user", user_id: LEAD });
    await setManagers(db, LEAD, IC, [{ kind: "user", user_id: LEAD }, { kind: "role", role_id: role._id }]);
    expect(await managerIds(db, IC)).toEqual([LEAD, role._id]);
    await expect(setManagers(db, OTHER, IC, [{ kind: "user", user_id: LEAD }])).rejects.toThrow("Only a team admin");
  });

  test("no loop closes across people and roles, in either direction", async () => {
    const db = fixtures();
    const role = await growth(db, IC);
    // The role reports to Ic, so Ic cannot report to the role.
    await expect(under(db, ADMIN, IC, { kind: "role", role_id: role._id })).rejects.toThrow("Cycle");
    // Lead under the role, then the role under Lead: refused from the role's side.
    await under(db, ADMIN, LEAD, { kind: "role", role_id: role._id });
    await expect(performReparentRole(ctxOf(db), ADMIN as any, { role_id: role._id, reports_to: { kind: "user", user_id: LEAD as any } })).rejects.toThrow("Cycle");
    // A chain that only passes through the role is no loop: Admin under Other under Lead under the role.
    await under(db, ADMIN, OTHER, { kind: "user", user_id: LEAD });
    expect((await under(db, ADMIN, ADMIN, { kind: "user", user_id: OTHER })).changed).toBe(true);
  });

  test("a retired role reads as no manager, and refuses new reports", async () => {
    const db = fixtures();
    const role = await growth(db);
    await under(db, ADMIN, IC, { kind: "role", role_id: role._id });
    await db.patch(role._id, { status: "retired" });
    const roles = await computeOrgRoles(ctxOf(db), ADMIN as any, TEAM, NOW);
    const ic: any = (roles.people as any[]).find((p) => p.user_id === IC);
    expect(ic.managers).toBeUndefined();
    await expect(under(db, ADMIN, OTHER, { kind: "role", role_id: role._id })).rejects.toThrow("active role");
  });

  test("an escalation reaches every manager: people directly, a role as the person above it", async () => {
    const db = fixtures();
    const role = await growth(db, LEAD);
    await under(db, ADMIN, IC, { kind: "role", role_id: role._id });
    expect(await escalationTargets(ctxOf(db), TEAM, IC as any, IC as any)).toEqual([LEAD]);
    await setManagers(db, ADMIN, IC, [{ kind: "role", role_id: role._id }, { kind: "user", user_id: OTHER }]);
    expect(await escalationTargets(ctxOf(db), TEAM, IC as any, IC as any)).toEqual([LEAD, OTHER]);
  });

  test("a row from before the list reads its one manager, and the next write moves it into the list", async () => {
    const db = fixtures();
    await db.patch("m3", { reports_to_user_id: LEAD });
    const roles = await computeOrgRoles(ctxOf(db), ADMIN as any, TEAM, NOW);
    expect((roles.people as any[]).find((p) => p.user_id === IC).managers).toEqual([{ kind: "user", user_id: LEAD }]);
    await setManagers(db, ADMIN, IC, [{ kind: "user", user_id: LEAD }, { kind: "user", user_id: OTHER }]);
    const m = await membership(db, IC);
    expect([m.reports_to_user_id, m.managers.length]).toEqual([undefined, 2]);
  });
});
