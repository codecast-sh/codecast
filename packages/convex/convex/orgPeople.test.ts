import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { performReparentPerson } from "./orgPeople";
import { performCreateRole } from "./orgRoles";
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
const managerOf = async (db: any, user: string) =>
  (await db.query("team_memberships").withIndex("by_user_team", (q: any) => q.eq("user_id", user).eq("team_id", TEAM)).first())?.reports_to_user_id ?? null;
const move = (db: any, caller: string, user: string, to: string | null) =>
  performReparentPerson(ctxOf(db), caller as any, { team_id: TEAM, user_id: user as any, reports_to_user_id: to as any });

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

  test("the person themself and the manager-to-be may move them; a bystander may not", async () => {
    const db = fixtures();
    await move(db, IC, IC, LEAD);
    expect(await managerOf(db, IC)).toBe(LEAD);
    await move(db, OTHER, IC, OTHER);
    expect(await managerOf(db, IC)).toBe(OTHER);
    await expect(move(db, LEAD, IC, ADMIN)).rejects.toThrow("Only a team admin");
    // The current manager may let a report go, and nobody else may.
    await expect(move(db, LEAD, IC, null)).rejects.toThrow("Only a team admin");
    await move(db, OTHER, IC, null);
    expect(await managerOf(db, IC)).toBe(null);
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
      const by = new Map(tree.people.map((p: any) => [String(p.user_id), p.reports_to_user_id ?? null]));
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
