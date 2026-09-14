import { describe, expect, it } from "bun:test";
import { firstServerCursor, moveExpandedSession } from "./orgPager";
import { ORG_FIXTURE_ALL_SESSIONS } from "./orgFixture";
import { layoutOrgTree, personNodeId, roleNodeId } from "./orgLayout";
import { ORG_FIXTURE } from "./orgFixture";

describe("orgPager", () => {
  it("the first server request starts past the tree's own rows; later ones follow the server cursor", () => {
    // The tree payload is page one (8 rows): asking from 0 would return them again.
    expect(firstServerCursor(undefined, 8)).toBe("8");
    expect(firstServerCursor(null, 8)).toBe("8");
    expect(firstServerCursor("16", 8)).toBe("16");
  });

  it("a moved session leaves every loaded list and joins the target's only when that list is open", () => {
    const [a, b, c] = ORG_FIXTURE_ALL_SESSIONS;
    const me = personNodeId("fixture-user-me"), sam = personNodeId("fixture-user-sam"), role = roleNodeId("fixture-role-growth");
    const start = { [me]: [a, b], [sam]: [c] };
    const toSam = moveExpandedSession(start, a._id, sam, a);
    expect(toSam[me].map((s) => s._id)).toEqual([b._id]);
    expect(toSam[sam].map((s) => s._id)).toEqual([c._id, a._id]);
    // Closed target: the row is not forced into a list that is not open.
    const toRole = moveExpandedSession(start, a._id, role, a);
    expect(role in toRole).toBe(false);
    expect(toRole[me].map((s) => s._id)).toEqual([b._id]);
    // Nothing to do: same object back, so React sees no change.
    expect(moveExpandedSession(start, "nope", sam, null)).toBe(start);
  });

  it("layout draws a moved session once when it sits in one parent's loaded page and another's bucket", () => {
    // The page's bookkeeping guarantees this; the layout must not double it
    // even if the two sources disagree for a render.
    const me = personNodeId("fixture-user-me");
    const fromRole = ORG_FIXTURE.roles[0].sessions[0];
    const { nodes } = layoutOrgTree(ORG_FIXTURE, { collapsed: new Set(), expanded: { [me]: [fromRole] } });
    const ids = nodes.filter((n) => n.kind === "session" && n.session._id === fromRole._id);
    expect(ids).toHaveLength(1);
  });
});
