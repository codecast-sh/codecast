import { describe, expect, it } from "bun:test";
import { channelListeners, orgRolesListenSig, viewerAdministersRole } from "../chatListeners";
import type { OrgRole, OrgTree } from "../../components/org/orgTypes";

const role = (id: string, extra: Partial<OrgRole> = {}): OrgRole => ({
  _id: id, short_id: `or-${id}`, scope_type: "team", team_id: "t1", host_user_id: "host",
  name: id, handle: id, scope: { project_ids: [], plan_ids: [] },
  reports_to: { kind: "user", user_id: "host" }, status: "active", created_by: "host",
  created_at: 1, updated_at: 1, counts: {} as any, sessions: [], total: 0,
  scope_names: { projects: [], plans: [] }, ...extra,
});
const tree = (me: { user_id: string; role: "admin" | "member" | "owner" }, kind: "team" | "user" = "team", roles: OrgRole[] = []): OrgTree => ({
  workspace: { kind, id: "t1", name: "t" },
  people: [{ user_id: me.user_id, name: me.user_id, role: me.role, is_me: true, counts: {} as any, sessions: [], total: 0 }],
  roles, anchors: [], generated_at: 0,
});

describe("viewerAdministersRole mirrors the server grant", () => {
  const r = role("growth");
  it("a team admin administers every role", () => {
    expect(viewerAdministersRole(tree({ user_id: "a", role: "admin" }), "a", r)).toBe(true);
  });
  it("a team owner administers every role", () => {
    expect(viewerAdministersRole(tree({ user_id: "o", role: "owner" }), "o", r)).toBe(true);
  });
  it("the role's host administers it, a plain member does not", () => {
    expect(viewerAdministersRole(tree({ user_id: "host", role: "member" }), "host", r)).toBe(true);
    expect(viewerAdministersRole(tree({ user_id: "m", role: "member" }), "m", r)).toBe(false);
  });
  it("the personal workspace is its owner's", () => {
    expect(viewerAdministersRole(tree({ user_id: "m", role: "member" }, "user"), "m", r)).toBe(true);
  });
  it("falls back to the viewer id when the tree has no is_me row", () => {
    const t = tree({ user_id: "x", role: "member" });
    t.people[0].is_me = false;
    expect(viewerAdministersRole(t, "host", r)).toBe(true);
  });
});

describe("channelListeners", () => {
  it("lists followers of the channel and the viewer's own roles, never a retired one", () => {
    const t = tree({ user_id: "host", role: "member" }, "team", [
      role("a", { follow_channel_ids: ["c1"] }),
      role("b", { host_user_id: "other" }),
      role("c", { follow_channel_ids: ["c1"], status: "retired" }),
    ]);
    const { listening, mine } = channelListeners(t, "c1", "host");
    expect(listening.map((r) => r._id)).toEqual(["a"]);
    expect(mine.map((r) => r._id)).toEqual(["a"]);
  });
  it("is empty without a tree", () => {
    expect(channelListeners(null, "c1", "v")).toEqual({ listening: [], mine: [] });
  });
});

describe("orgRolesListenSig", () => {
  it("ignores session churn and moves on a follow or a grant change", () => {
    const t = tree({ user_id: "host", role: "member" }, "team", [role("a")]);
    const base = orgRolesListenSig(t);
    const churned = { ...t, generated_at: 9, roles: [{ ...t.roles[0], sessions: [{ _id: "s" } as any], total: 1, updated_at: 5 }] };
    expect(orgRolesListenSig(churned)).toBe(base);
    const followed = { ...t, roles: [{ ...t.roles[0], follow_channel_ids: ["c1"] }] };
    expect(orgRolesListenSig(followed)).not.toBe(base);
    const promoted = { ...t, people: [{ ...t.people[0], role: "admin" as const }] };
    expect(orgRolesListenSig(promoted)).not.toBe(base);
    expect(orgRolesListenSig(null)).toBe("");
  });
});
