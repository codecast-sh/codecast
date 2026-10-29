// A role edit paints on every face at once (lib/roleRows): the open
// roleFields intent updateOrgRole records is laid over the role's
// viewerRoles row, so a stale push cannot take it back, and a refusal (the
// intent reverted) shows the server's row again. viewerRoles itself stays as
// the server sent it.
import { afterAll, describe, expect, it } from "bun:test";
import { useInboxStore } from "../inboxStore";
import { roleRowsOf } from "../../lib/roleRows";
import { ORG_FIXTURE } from "../../components/org/orgFixture";
import type { OrgTree } from "../../components/org/orgTypes";

// org.tree always stamps a role's resolved avatar, so the fixture's does too.
const tree = (): OrgTree => { const t: OrgTree = JSON.parse(JSON.stringify(ORG_FIXTURE)); t.roles[0].avatar = "stag"; return t; };
const ROLE = ORG_FIXTURE.roles[0];
const row = (avatar: string, name = ROLE.name) => ({ _id: ROLE._id, short_id: ROLE.short_id, handle: ROLE.handle, name, given_name: null, avatar, icon: null, status: "active", tenure_kind: "standing", assistant: null, scope_type: "team", team_id: null });
const faceOf = () => roleRowsOf(useInboxStore.getState() as never).roles.find((r) => r._id === ROLE._id);
const held = () => (useInboxStore.getState() as any).viewerRoles[ROLE._id];

describe("a role edit on the faces", () => {
  const before = useInboxStore.getState();
  afterAll(() => useInboxStore.setState({ orgTree: before.orgTree, viewerRoles: (before as any).viewerRoles, orgIntents: (before as any).orgIntents } as never));

  it("an optimistic avatar change and rename show on the face at once and hold over a stale push", () => {
    useInboxStore.setState({ orgTree: tree(), orgIntents: [] } as never);
    useInboxStore.getState().syncTable("viewerRoles" as never, [row("stag")] as never);
    expect(faceOf()?.avatar).toBe("stag");

    useInboxStore.getState().updateOrgRole(ROLE._id, { avatar: "owl", name: "Growth lead" });
    expect(faceOf()).toMatchObject({ avatar: "owl", name: "Growth lead" });
    expect(held().avatar).toBe("stag");

    // A push that left the server before the mutation landed.
    useInboxStore.getState().syncTable("viewerRoles" as never, [row("stag")] as never);
    expect(faceOf()).toMatchObject({ avatar: "owl", name: "Growth lead" });
  });

  it("a refused edit shows the server's face again", () => {
    const intent = (useInboxStore.getState() as any).orgIntents.find((i: any) => i.kind === "roleFields");
    useInboxStore.getState().revertOrgIntent(intent.id);
    expect(faceOf()).toMatchObject({ avatar: "stag", name: ROLE.name });
  });
});
