import { describe, expect, it } from "bun:test";
import { createOrgSlice } from "../orgSlice";
import type { OrgTree } from "../../components/org/orgTypes";

// The action body runs against a draft object the way the org page's preview
// mode calls it: `this` is the slice data, no middleware in between.
function draft(follow: string[] | undefined): { orgTree: OrgTree } {
  return {
    orgTree: {
      workspace: { kind: "team", id: "t1", name: "t" }, people: [], anchors: [], generated_at: 0,
      roles: [{
        _id: "r1", short_id: "or-1", scope_type: "team", host_user_id: "h", name: "Growth", handle: "growth",
        scope: { project_ids: [], plan_ids: [] }, reports_to: { kind: "user", user_id: "h" }, status: "active",
        created_by: "h", created_at: 1, updated_at: 1, counts: {} as any, sessions: [], total: 0,
        scope_names: { projects: [], plans: [] }, ...(follow ? { follow_channel_ids: follow } : {}),
      }],
    },
  };
}

describe("followOrgChannel", () => {
  const slice = createOrgSlice();
  it("adds and drops a channel by the role's short id", () => {
    const d = draft(undefined);
    slice.followOrgChannel.call(d, "or-1", "c1", true);
    expect(d.orgTree.roles[0].follow_channel_ids).toEqual(["c1"]);
    slice.followOrgChannel.call(d, "or-1", "c2", true);
    expect(d.orgTree.roles[0].follow_channel_ids).toEqual(["c1", "c2"]);
    slice.followOrgChannel.call(d, "or-1", "c1", false);
    expect(d.orgTree.roles[0].follow_channel_ids).toEqual(["c2"]);
  });
  it("is a no-op when the state already matches, and for an unknown role", () => {
    const d = draft(["c1"]);
    const before = d.orgTree.roles[0].updated_at;
    slice.followOrgChannel.call(d, "or-1", "c1", true);
    slice.followOrgChannel.call(d, "or-1", "c9", false);
    slice.followOrgChannel.call(d, "or-404", "c1", true);
    expect(d.orgTree.roles[0].follow_channel_ids).toEqual(["c1"]);
    expect(d.orgTree.roles[0].updated_at).toBe(before);
  });
});
