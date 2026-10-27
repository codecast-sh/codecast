// A role edit paints on every face at once (lib/roleRows): updateOrgRole
// writes the face fields on the role's viewerRoles row in the same draft as
// the tree, and that row holds them over a stale push until the server
// echoes. A refused edit puts the row back.
import { afterAll, describe, expect, it } from "bun:test";
import { create as mutate } from "mutative";
import { useInboxStore } from "../inboxStore";
import { createOrgSlice, revertOrgIntent, type OrgSliceData } from "../orgSlice";
import { roleRowsOf } from "../../lib/roleRows";
import { ORG_FIXTURE } from "../../components/org/orgFixture";
import type { OrgTree } from "../../components/org/orgTypes";

// org.tree always stamps a role's resolved avatar (orgTypes), so the fixture's does too.
const tree = (): OrgTree => { const t: OrgTree = JSON.parse(JSON.stringify(ORG_FIXTURE)); t.roles[0].avatar = "stag"; return t; };
const ROLE = ORG_FIXTURE.roles[0];
const row = (avatar: string, name = ROLE.name) => ({ _id: ROLE._id, short_id: ROLE.short_id, handle: ROLE.handle, name, given_name: null, avatar, icon: null, status: "active", tenure_kind: "standing", assistant: null, scope_type: "team", team_id: null });
const faceOf = () => roleRowsOf(useInboxStore.getState() as never).roles.find((r) => r._id === ROLE._id);

describe("a role edit on viewerRoles", () => {
  const before = useInboxStore.getState();
  afterAll(() => useInboxStore.setState({ orgTree: before.orgTree, viewerRoles: (before as any).viewerRoles, orgIntents: (before as any).orgIntents } as never));

  it("an optimistic avatar change and rename show on the face at once and hold over a stale push", () => {
    useInboxStore.setState({ orgTree: tree(), orgIntents: [] } as never);
    useInboxStore.getState().syncTable("viewerRoles" as never, [row("stag")] as never);
    expect(faceOf()?.avatar).toBe("stag");

    useInboxStore.getState().updateOrgRole(ROLE._id, { avatar: "owl", name: "Growth lead" });
    expect(faceOf()).toMatchObject({ avatar: "owl", name: "Growth lead" });

    // A push that left the server before the mutation landed.
    useInboxStore.getState().syncTable("viewerRoles" as never, [row("stag")] as never);
    expect(faceOf()).toMatchObject({ avatar: "owl", name: "Growth lead" });

    // The echo settles it.
    useInboxStore.getState().syncTable("viewerRoles" as never, [row("owl", "Growth lead")] as never);
    expect(faceOf()).toMatchObject({ avatar: "owl", name: "Growth lead" });
  });

  it("a refused edit puts the face fields back", () => {
    const slice = createOrgSlice();
    let st = { orgTree: tree(), orgIntents: [], viewerRoles: { [ROLE._id]: row("stag") } } as unknown as OrgSliceData & { viewerRoles: Record<string, ReturnType<typeof row>> };
    st = mutate(st, (d) => { (slice.updateOrgRole as any).call(d, ROLE._id, { avatar: "owl" }); });
    expect(st.viewerRoles[ROLE._id].avatar).toBe("owl");
    st = mutate(st, (d) => { revertOrgIntent(d as never, d.orgIntents[0]); });
    expect(st.viewerRoles[ROLE._id].avatar).toBe("stag");
  });
});
