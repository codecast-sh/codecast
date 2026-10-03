// org.roles feeds the same orgTree slot as org.tree (ct-53363): the surfaces
// that only name roles subscribe to it because it reads no session. Its push
// must never blank what a full tree put in the slot, and must never carry one
// workspace's sessions into another.
import { describe, expect, it } from "bun:test";
import { ORG_SYNC_REGISTRY, fillRolesOnlyTree } from "../orgSlice";
import { ORG_FIXTURE } from "../../components/org/orgFixture";
import type { OrgTree } from "../../components/org/orgTypes";

const SESSION = ["counts", "sessions", "total"];
const ANCHOR_LIVE = ["short_id", "state", "state_line", "state_status", "state_at"];
const omit = (row: any, keys: string[]) => Object.fromEntries(Object.entries(row).filter(([k]) => !keys.includes(k)));

// What org.roles sends for the fixture's org: the same rows, session fields gone.
function rolesOnlyOf(tree: OrgTree): any {
  return {
    workspace: tree.workspace,
    people: tree.people.map((p) => omit(p, ["presence", ...SESSION])),
    roles: tree.roles.map((r) => ({ ...omit(r, SESSION), standing: r.standing ? { conversation_id: r.standing.conversation_id } : null })),
    anchors: tree.anchors.map((a) => omit(a, ANCHOR_LIVE)),
    roles_only: true,
    generated_at: 1,
  };
}

const normalize = (payload: any, held: OrgTree | null) => {
  const draft: any = { orgTree: held, orgTreeServer: held, orgIntents: [] };
  return ORG_SYNC_REGISTRY.orgTree.normalize(payload, draft) as OrgTree;
};

describe("a roles-only push into the org tree slot", () => {
  it("leaves a held tree of the same workspace exactly as it was", () => {
    const { generated_at: _g, ...held } = ORG_FIXTURE;
    expect(normalize(rolesOnlyOf(ORG_FIXTURE), ORG_FIXTURE)).toEqual(held as any);
  });

  it("starts the session fields empty when the held tree is another workspace's", () => {
    const other: OrgTree = { ...ORG_FIXTURE, workspace: { kind: "team", id: "other-team", name: "Other" } };
    const out = normalize(rolesOnlyOf(ORG_FIXTURE), other);
    for (const r of out.roles) {
      expect(r.sessions).toEqual([]);
      expect(r.total).toBe(0);
    }
    for (const p of out.people) {
      expect(p.sessions).toEqual([]);
      expect(p.presence).toBe("offline");
    }
    expect(out.roles.map((r) => r._id)).toEqual(ORG_FIXTURE.roles.map((r) => r._id));
  });

  it("takes a role edit from the push while keeping its held sessions", () => {
    const payload = rolesOnlyOf(ORG_FIXTURE);
    payload.roles[0] = { ...payload.roles[0], name: "Renamed" };
    const out = normalize(payload, ORG_FIXTURE);
    expect(out.roles[0]!.name).toBe("Renamed");
    expect(out.roles[0]!.sessions).toEqual(ORG_FIXTURE.roles[0]!.sessions);
  });

  it("drops a held standing state whose session the push no longer names", () => {
    const withStanding = ORG_FIXTURE.roles.findIndex((r) => r.standing);
    if (withStanding < 0) return;
    const payload = rolesOnlyOf(ORG_FIXTURE);
    payload.roles[withStanding] = { ...payload.roles[withStanding], standing: { conversation_id: "a-new-seat" } };
    const out = fillRolesOnlyTree(payload, ORG_FIXTURE);
    expect(out.roles[withStanding]!.standing).toEqual({ conversation_id: "a-new-seat" } as any);
  });

  it("passes a full tree through untouched", () => {
    const { generated_at: _g, ...rest } = ORG_FIXTURE;
    expect(normalize(ORG_FIXTURE, null)).toEqual(rest as any);
  });
});
