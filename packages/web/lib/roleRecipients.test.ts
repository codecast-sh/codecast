// Run: bun test packages/web/lib/roleRecipients.test.ts
import { describe, expect, test } from "bun:test";
import { filterRoleRecipients, roleArea, roleRecipients, sendRequestToRole } from "./roleRecipients";
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

describe("sendRequestToRole", () => {
  const fakeStore = (tree: any) => {
    const calls: any[] = [];
    const store = { orgTree: tree, addOptimisticMessage: (...a: any[]) => { calls.push(["optimistic", ...a]); return "client-1"; }, sendMessage: (...a: any[]) => { calls.push(["send", ...a]); } };
    return { store, calls };
  };
  const [ember] = roleRecipients([growth], ME);

  test("paints the bubble at once with previews, sends once uploads settle, into the live tree's standing session", async () => {
    const { store, calls } = fakeStore({ roles: [{ _id: "g", standing: { conversation_id: "conv-g-live" } }] });
    let release!: (id: string | null) => void;
    const pending = new Promise<string | null>((r) => { release = r; });
    const images = [{ storageId: "st-1", previewUrl: "blob:a", mime: "image/png", uploading: false }, { previewUrl: "blob:b", mime: "image/jpeg", uploading: true }];
    const done = sendRequestToRole(() => store, ember, "Draft the review", images, (url) => (url === "blob:b" ? pending : Promise.resolve(null)));
    await Promise.resolve();
    expect(calls).toEqual([["optimistic", "conv-g-live", "Draft the review", [{ media_type: "image/png", storage_id: "st-1" }, { media_type: "image/jpeg", preview_url: "blob:b", uploading: true }]]]);
    release("st-2");
    expect(await done).toBe("conv-g-live");
    expect(calls[1]).toEqual(["send", "conv-g-live", "Draft the review", ["st-1", "st-2"], "client-1"]);
  });

  test("falls back to the recipient's standing id, sends no image list when there are none", async () => {
    const { store, calls } = fakeStore(null);
    expect(await sendRequestToRole(() => store, ember, "hi", [], async () => null)).toBe("conv-g");
    expect(calls).toEqual([["optimistic", "conv-g", "hi", []], ["send", "conv-g", "hi", undefined, "client-1"]]);
  });

  test("a seat with no standing session refuses without writing", async () => {
    const { store, calls } = fakeStore({ roles: [] });
    const [ada] = roleRecipients([docs], ME);
    expect(await sendRequestToRole(() => store, ada, "hi", [], async () => null)).toBeNull();
    expect(calls).toEqual([]);
  });
});
