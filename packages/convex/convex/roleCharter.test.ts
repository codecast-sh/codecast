import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { performCreateRole, performUpdateRole } from "./orgRoles";
import { computeOrgRoles } from "./org";
import { performUndo } from "./orgChanges";
import { charterText } from "./roleCharter.testkit";

// A role's charter has one home, its doc (lib/roleCharter): the role page,
// `cast role update --charter` and what the role reads are the same text.

const ME = "u".repeat(31) + "m";
const TEAM = "teams_acme" as any;

function world() {
  const db = makeFakeDb({
    users: [{ _id: ME, name: "Me", email: "me@x.ai" }],
    team_memberships: [{ _id: "m1", user_id: ME, team_id: TEAM, role: "admin" }],
    teams: [{ _id: TEAM, name: "Acme" }],
    counters: [],
  });
  const ctx = () => ({ db, auth: { getUserIdentity: async () => ({ subject: ME }) } }) as any;
  return { db, ctx };
}

describe("one charter per role", () => {
  test("a hire's charter is born as its doc, and the row holds no copy", async () => {
    const { db, ctx } = world();
    const role = await performCreateRole(ctx(), ME as any, { name: "Growth", handle: "growth", team_id: TEAM, charter: "Owns paid acquisition." });
    expect(role.charter).toBeUndefined();
    expect(role.charter_doc_id).toBeDefined();
    const doc = await db.get(role.charter_doc_id);
    expect(doc).toMatchObject({ doc_type: "charter", content: "Owns paid acquisition.", workspace: `team:${TEAM}` });
  });

  test("an edit on the role page writes the doc the role reads, the org tree shows it, and undo puts it back", async () => {
    const { db, ctx } = world();
    const role = await performCreateRole(ctx(), ME as any, { name: "Growth", handle: "growth", team_id: TEAM, charter: "Owns paid acquisition." });
    await performUpdateRole(ctx(), ME as any, { role_id: String(role._id), charter: "Owns paid and organic acquisition." });
    expect(await charterText(db, String(role._id))).toBe("Owns paid and organic acquisition.");
    expect((await db.get(role._id)).charter).toBeUndefined();
    const tree = await computeOrgRoles(ctx(), ME as any, TEAM, Date.now());
    expect(tree.roles.find((r: any) => r.handle === "growth")?.charter).toBe("Owns paid and organic acquisition.");
    // The log row says what the charter said before and after.
    const row = db._tables.org_changes.at(-1);
    expect([row.before.charter, row.after.charter]).toEqual(["Owns paid acquisition.", "Owns paid and organic acquisition."]);
    await performUndo(ctx(), ME as any, { batch: db._tables.org_change_batches.at(-1)._id });
    expect(await charterText(db, String(role._id))).toBe("Owns paid acquisition.");
  });

  test("a role's own session may not rewrite its charter through the role's update", async () => {
    const { db, ctx } = world();
    const role = await performCreateRole(ctx(), ME as any, { name: "Growth", handle: "growth", team_id: TEAM, charter: "Owns paid acquisition." });
    await db.insert("conversations", { session_id: "seat-1", short_id: "jxseat1", user_id: ME, team_id: TEAM, standing_role_id: role._id, status: "active", agent_type: "claude_code", title: "Growth", created_at: 1, updated_at: 1 });
    await expect(performUpdateRole(ctx(), ME as any, { role_id: String(role._id), charter: "Owns everything.", from_session: "seat-1" })).rejects.toThrow(/written by people/);
    expect(await charterText(db, role)).toBe("Owns paid acquisition.");
  });

  test("a hire with no words gets its job sentence", async () => {
    const { db, ctx } = world();
    const role = await performCreateRole(ctx(), ME as any, { name: "Growth", handle: "growth", team_id: TEAM });
    expect(await charterText(db, role)).toBe("Growth works on behalf of Me: it runs its routine, answers what it is asked, and raises what needs a person with a recommendation.");
  });
});
