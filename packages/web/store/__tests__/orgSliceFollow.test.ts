import { describe, expect, it } from "bun:test";
import { createOrgSlice } from "../orgSlice";
import type { OrgTree } from "../../components/org/orgTypes";

// The action body runs against a draft object the way the org page's preview
// mode calls it: `this` is the slice data, no middleware in between.
const C1 = "c".repeat(32);
const C2 = "d".repeat(32);

function draft(follow: string[] | undefined): { orgTree: OrgTree; orgIntents: any[] } {
  return {
    orgIntents: [],
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
    slice.followOrgChannel.call(d, "or-1", C1, true);
    expect(d.orgTree.roles[0].follow_channel_ids).toEqual([C1]);
    slice.followOrgChannel.call(d, "or-1", C2, true);
    expect(d.orgTree.roles[0].follow_channel_ids).toEqual([C1, C2]);
    slice.followOrgChannel.call(d, "or-1", C1, false);
    expect(d.orgTree.roles[0].follow_channel_ids).toEqual([C2]);
    // One intent per (role, channel) subject rides to the server.
    expect(d.orgIntents.map((i) => [i.kind, i.channel_id, i.follow])).toEqual([["follow", C2, true], ["follow", C1, false]]);
  });
  it("is a no-op when the state already matches, for an unknown role, and for a stub channel id", () => {
    const d = draft([C1]);
    const before = d.orgTree.roles[0].updated_at;
    slice.followOrgChannel.call(d, "or-1", C1, true);
    slice.followOrgChannel.call(d, "or-1", C2, false);
    slice.followOrgChannel.call(d, "or-404", C1, true);
    slice.followOrgChannel.call(d, "or-1", "chatstub-abc", false);
    expect(d.orgTree.roles[0].follow_channel_ids).toEqual([C1]);
    expect(d.orgTree.roles[0].updated_at).toBe(before);
    expect(d.orgIntents).toEqual([]);
  });
});
