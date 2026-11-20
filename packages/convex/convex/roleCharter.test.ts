import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { performCreateRole, performUpdateRole } from "./orgRoles";
import { computeOrgRoles } from "./org";
import { performUndo } from "./orgChanges";
import { performFoldRoleCharters } from "./migrations";
import { charterText } from "./roleCharter.testkit";

// A role's charter has one home, its doc (lib/roleCharter): the role page,
// `cast role update --charter` and what the role reads are the same text.

const ME = "u".repeat(31) + "m";
const TEAM = "teams_acme" as any;
const DAY = 86_400_000;

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

describe("migrations.foldRoleCharters", () => {
  const T0 = 1_800_000_000_000;
  const roleRow = (id: string, short_id: string, over: Record<string, any>) => ({ _id: id, short_id, scope_type: "team", team_id: TEAM, host_user_id: ME, name: short_id, handle: short_id, scope: { project_ids: [], plan_ids: [] }, reports_to: { kind: "user", user_id: ME }, status: "active", created_by: ME, created_at: T0, updated_at: T0, ...over });
  const docRow = (id: string, content: string, over: Record<string, any> = {}) => ({ _id: id, user_id: ME, team_id: TEAM, title: "Charter", content, doc_type: "charter", source: "human", created_at: T0, updated_at: T0, ...over });
  function fixture() {
    return makeFakeDb({
      users: [{ _id: ME, name: "Me", email: "me@x.ai" }],
      teams: [{ _id: TEAM, name: "Acme" }],
      org_roles: [
        // No doc: one is made from the field.
        roleRow("org_roles_a", "or-1", { charter: "Owns A." }),
        // The doc is the field inside provision's generated wrapper.
        roleRow("org_roles_b", "or-2", { charter: "Owns B.", charter_doc_id: "docs_b" }),
        // The field was edited on the page after the doc's last write.
        roleRow("org_roles_c", "or-3", { charter: "Owns C, newer.", charter_doc_id: "docs_c" }),
        // The doc was edited after the field.
        roleRow("org_roles_d", "or-4", { charter: "Owns D, older.", charter_doc_id: "docs_d" }),
        // The editor holds unsaved steps: left for a rerun.
        roleRow("org_roles_e", "or-5", { charter: "Owns E.", charter_doc_id: "docs_e" }),
        // An older template's doc that holds the field's words among its own sections.
        roleRow("org_roles_f", "or-6", { charter: "Owns F.", charter_doc_id: "docs_f" }),
        // A generated Area list a person added a rule to: it stays.
        roleRow("org_roles_g", "or-7", { charter_doc_id: "docs_g" }),
      ],
      docs: [
        docRow("docs_b", "# Charter: B (@b)\n\nOwns B.\n\n## Area\n- no area of its own"),
        docRow("docs_c", "Owns C."),
        docRow("docs_d", "Owns D, newer.", { content_writer: { name: "Me", at: T0 + 2 * DAY } }),
        docRow("docs_e", "Owns E, being edited."),
        docRow("docs_g", "# Charter: G (@g)\n\nOwns G.\n\n## Area\n\n- no area of its own\n- never touch billing"),
        docRow("docs_f", "# Charter: F (@f)\n\nOwns F.\n\n## Scope\n- project Billing\n\n## Rules\n- Ask before spending."),
      ],
      org_changes: [
        { _id: "oc1", subject: { type: "role", id: "org_roles_c", label: "@or-3" }, before: { charter: "Owns C." }, after: { charter: "Owns C, newer." }, created_at: T0 + DAY },
        { _id: "oc2", subject: { type: "role", id: "org_roles_d", label: "@or-4" }, before: { charter: "Owns D." }, after: { charter: "Owns D, older." }, created_at: T0 + DAY },
      ],
      doc_deltas: [{ _id: "dd1", id: "docs_e", version: 3, clientId: "c", steps: [] }],
      doc_snapshots: [{ _id: "ds1", id: "docs_e", version: 2 }],
      counters: [],
    });
  }

  test("dry by default: names each fold and writes nothing", async () => {
    const db = fixture();
    const before = JSON.stringify(db._tables);
    const plan = await performFoldRoleCharters({ db }, {});
    expect(plan.dryRun).toBe(true);
    expect(plan.rows.map((r) => [r.role, r.action])).toEqual([["or-1", "created"], ["or-2", "unwrapped"], ["or-3", "field_won"], ["or-4", "doc_won"], ["or-5", "skipped"], ["or-6", "unwrapped"], ["or-7", "unwrapped"]]);
    expect(JSON.stringify(db._tables)).toBe(before);
  });

  test("the run leaves one copy per role, keeps the losing text as a note, and skips a doc mid edit", async () => {
    const db = fixture();
    await performFoldRoleCharters({ db }, { dryRun: false });
    const role = (id: string) => db._tables.org_roles.find((r: any) => r._id === id);
    for (const id of ["org_roles_a", "org_roles_b", "org_roles_c", "org_roles_d", "org_roles_f"]) expect(role(id).charter).toBeUndefined();
    expect(await charterText(db, role("org_roles_a"))).toBe("Owns A.");
    expect(await charterText(db, role("org_roles_b"))).toBe("Owns B.");
    expect(await charterText(db, role("org_roles_c"))).toBe("Owns C, newer.");
    expect(await charterText(db, role("org_roles_d"))).toBe("Owns D, newer.");
    const notes = (id: string) => ((db._tables.docs.find((d: any) => d._id === id)?.entries ?? []) as any[]).map((e) => e.content);
    expect(notes("docs_c")).toEqual([expect.stringContaining("Owns C.")]);
    expect(notes("docs_d")).toEqual([expect.stringContaining("Owns D, older.")]);
    expect(notes("docs_b")).toEqual([]);
    expect(await charterText(db, role("org_roles_f"))).toBe("Owns F.\n\n## Scope\n- project Billing\n\n## Rules\n- Ask before spending.");
    expect(notes("docs_f")).toEqual([]);
    expect(await charterText(db, role("org_roles_g"))).toBe("Owns G.\n\n## Area\n\n- no area of its own\n- never touch billing");
    expect(db._tables.docs.find((d: any) => d._id === "docs_b").workspace).toBe(`team:${TEAM}`);
    // The doc mid edit keeps both copies until a rerun.
    expect(role("org_roles_e").charter).toBe("Owns E.");
    expect(await charterText(db, role("org_roles_e"))).toBe("Owns E, being edited.");
    // A second run finds nothing left to fold but the skipped one.
    expect((await performFoldRoleCharters({ db }, {})).rows.map((r) => r.action)).toEqual(["skipped"]);
  });
});
