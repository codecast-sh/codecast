import { describe, expect, test } from "bun:test";
import { ORG_SYNC_REGISTRY, orgTreeFor } from "../orgSlice";

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
