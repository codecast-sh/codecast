import { describe, expect, test } from "bun:test";
import { ORG_SYNC_REGISTRY, orgTreeFor, windowOrgTree } from "../orgSlice";

const tree = (kind: string, id: string) => ({ workspace: { kind, id, name: id }, people: [], roles: [], anchors: [] });

describe("org scope: the window's org tree is the workspace the page reads", () => {
  test("with no scope any tree is taken; with one, only that workspace's", () => {
    expect(orgTreeFor(null, tree("user", "u1"))).toBe(true);
    expect(orgTreeFor("team:t1", tree("team", "t1"))).toBe(true);
    expect(orgTreeFor("team:t1", tree("user", "u1"))).toBe(false);
    expect(orgTreeFor("team:t1", tree("team", "t2"))).toBe(false);
  });
  test("a push for another workspace keeps the held tree (/line on Union while the app's feeder sends Personal)", () => {
    const held = tree("team", "t1");
    const draft: any = { orgScope: "team:t1", orgTree: held, orgIntents: [] };
    expect(ORG_SYNC_REGISTRY.orgTree.normalize(tree("user", "u1"), draft)).toBe(held);
    expect(draft.orgTreeServer).toBeUndefined();
    const next = ORG_SYNC_REGISTRY.orgTree.normalize(tree("team", "t1"), draft) as any;
    expect(next.workspace.id).toBe("t1");
  });
});

// A workspace with Org off never refeeds the slot: after a switch it still holds the last workspace's tree, and its
// roles must not be offered as this workspace's (a test team's decision offered Union's roles to pass to).
describe("windowOrgTree: readers see the held tree only when it is the window's workspace", () => {
  const state = (held: ReturnType<typeof tree> | null, active: string | null, orgScope: string | null = null) => ({
    orgTree: held, orgScope, clientState: { ui: { active_team_id: active } }, currentUser: { _id: "u1" },
  });
  test("the active team's tree reads through", () => {
    const held = tree("team", "t1");
    expect(windowOrgTree(state(held, "t1"))).toBe(held);
  });
  test("another team's tree left in the slot reads as none", () => {
    expect(windowOrgTree(state(tree("team", "t1"), "t2"))).toBeNull();
    expect(windowOrgTree(state(tree("team", "t1"), null))).toBeNull();
  });
  test("the personal workspace's own tree, and a scoped surface's tree, read through", () => {
    const mine = tree("user", "u1");
    expect(windowOrgTree(state(mine, null))).toBe(mine);
    const scoped = tree("team", "t1");
    expect(windowOrgTree(state(scoped, "t2", "team:t1"))).toBe(scoped);
  });
});
