// Run: bun test packages/web/lib/roleRecipients.test.ts
import { describe, expect, test } from "bun:test";
import { filterRoleRecipients, roleArea, roleRecipients } from "./roleRecipients";
import type { OrgRole } from "../components/org/orgTypes";

const ME = "user-me";
const SAM = "user-sam";

function role(over: Partial<OrgRole> & { _id: string; handle: string; name: string }): OrgRole {
  return {
    short_id: `or-${over._id}`,
    scope_type: "team",
    team_id: "team-1",
    host_user_id: ME,
    scope: { project_ids: [], plan_ids: [] },
    reports_to: { kind: "user", user_id: ME },
    status: "active",
    scope_names: { projects: [], plans: [] },
    standing: { conversation_id: `conv-${over._id}`, short_id: `jx7${over._id}` },
    ...over,
  } as OrgRole;
}

const growth = role({ _id: "g", handle: "growth", name: "Head of Growth", given_name: "Ember", scope_names: { projects: [{ id: "p1", title: "Growth", short_id: "pr-1" }], plans: [{ id: "l1", title: "SEO and AI citations", short_id: "pl-1" }] } });
const platform = role({ _id: "p", handle: "platform", name: "Platform lead", given_name: "Rowan", reports_to: { kind: "user", user_id: SAM }, scope_names: { projects: [{ id: "p2", title: "Sync layer", short_id: "pr-2" }], plans: [] } });
const docs = role({ _id: "d", handle: "docs", name: "Docs lead", given_name: "Ada", reports_to: { kind: "role", role_id: "p" }, standing: null });
const retired = role({ _id: "r", handle: "old", name: "Old role", status: "retired" });

describe("roleRecipients", () => {
  test("the viewer's direct reports come first, each group by name, retired roles out", () => {
    const list = roleRecipients([platform, retired, docs, growth], ME);
    expect(list.map((r) => r.handle)).toEqual(["growth", "docs", "platform"]);
    expect(list.map((r) => r.mine)).toEqual([true, false, false]);
  });

  test("one line per role: the chosen name, the title, the area, and the standing session", () => {
    const [ember] = roleRecipients([growth], ME);
    expect(ember.name).toBe("Ember");
    expect(ember.title).toBe("Head of Growth");
    expect(ember.area).toBe("Growth, SEO and AI citations");
    expect(ember.standingId).toBe("conv-g");
    expect(roleArea(docs)).toBe("");
    expect(roleRecipients([docs], ME)[0].standingId).toBeNull();
  });

  test("a role with no chosen name still has one", () => {
    const [r] = roleRecipients([role({ _id: "n", handle: "qa", name: "QA lead" })], ME);
    expect(r.name.length).toBeGreaterThan(0);
    expect(r.title).toBe("QA lead");
  });

  test("an unknown viewer owns nothing", () => {
    expect(roleRecipients([growth], null).every((r) => !r.mine)).toBe(true);
  });
});

describe("filterRoleRecipients", () => {
  const list = roleRecipients([platform, docs, growth], ME);

  test("an empty query keeps the whole list in order", () => {
    expect(filterRoleRecipients(list, "  ").map((r) => r.handle)).toEqual(["growth", "docs", "platform"]);
  });

  test("matches by name, handle, title and area, case insensitive, @ allowed", () => {
    expect(filterRoleRecipients(list, "ember").map((r) => r.handle)).toEqual(["growth"]);
    expect(filterRoleRecipients(list, "@PLAT").map((r) => r.handle)).toEqual(["platform"]);
    expect(filterRoleRecipients(list, "lead").map((r) => r.handle)).toEqual(["docs", "platform"]);
    expect(filterRoleRecipients(list, "citations").map((r) => r.handle)).toEqual(["growth"]);
  });

  test("every word must match", () => {
    expect(filterRoleRecipients(list, "docs ada").map((r) => r.handle)).toEqual(["docs"]);
    expect(filterRoleRecipients(list, "docs ember")).toEqual([]);
  });

  test("the viewer's own stay above others even when the other matches better", () => {
    const other = role({ _id: "x", handle: "seo", name: "SEO lead", given_name: "Seo", reports_to: { kind: "user", user_id: SAM } });
    const out = filterRoleRecipients(roleRecipients([other, growth], ME), "seo");
    expect(out.map((r) => r.handle)).toEqual(["growth", "seo"]);
  });

  test("within a group a word that opens the name or handle beats a mention in the area", () => {
    const sync = role({ _id: "s", handle: "sync", name: "Sync lead", given_name: "Sol", reports_to: { kind: "user", user_id: SAM } });
    const out = filterRoleRecipients(roleRecipients([platform, sync], ME), "sync");
    expect(out.map((r) => r.handle)).toEqual(["sync", "platform"]);
  });
});
