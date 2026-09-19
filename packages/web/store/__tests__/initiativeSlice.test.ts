// Initiative writes on the real store (store/initiativeSlice.ts;
// docs/architecture/initiatives-projects-role-page.md I1): what each action
// paints on the draft in the tick of the gesture.
// Run: bun test store/__tests__/initiativeSlice.test.ts
import { beforeEach, describe, expect, it } from "bun:test";
import type { InitiativeRow } from "@codecast/shared/contracts/initiative";
import { ORG_FIXTURE } from "../../components/org/orgFixture";
import { useInboxStore } from "../inboxStore";

const convexId = (seed: string) => seed.padEnd(32, "0").slice(0, 32);
const ID = convexId("initiative");
const ROLE = ORG_FIXTURE.roles[0];
const SCOPED = "fixture-project-growth";

const row = (extra: Partial<InitiativeRow> = {}): InitiativeRow => ({
  _id: ID, short_id: "in-1", title: "Agents run the routine work", status: "active", project_ids: [SCOPED],
  health: "at_risk", health_at: 100, latest_update_id: "upd-1", target_date: 5_000, description: "Why",
  workspace: "team:fixture-team", team_id: "fixture-team", user_id: "fixture-user-me", created_at: 1, updated_at: 1, ...extra,
});

const state = () => useInboxStore.getState() as any;

beforeEach(() => {
  useInboxStore.setState({
    currentUser: { _id: "fixture-user-me" },
    initiatives: { [ID]: row() },
    initiativeUpdates: {},
    orgTree: structuredClone(ORG_FIXTURE),
    orgIntents: [],
  } as any);
});

describe("createInitiative", () => {
  it("paints a stub keyed by the client key, in the workspace the caller named", () => {
    state().createInitiative({ client_key: "in_stub_1", title: "  Ship mobile  ", workspace: "team", team_id: "fixture-team", owner: { user_id: "fixture-user-me", kind: "user" } });
    const stub = state().initiatives["in_stub_1"] as InitiativeRow;
    expect(stub).toMatchObject({ _id: "in_stub_1", client_key: "in_stub_1", short_id: "", title: "Ship mobile", status: "proposed", health: "none", project_ids: [], workspace: "team:fixture-team", team_id: "fixture-team", user_id: "fixture-user-me" });
    // Pending protection compares objects as JSON: `kind` first, as the server stores it.
    expect(JSON.stringify(stub.owner)).toBe('{"kind":"user","user_id":"fixture-user-me"}');
  });

  it("a personal initiative is keyed to its maker, never to the absence of a team", () => {
    state().createInitiative({ client_key: "in_stub_2", title: "Mine", workspace: "personal" });
    expect(state().initiatives["in_stub_2"]).toMatchObject({ workspace: "user:fixture-user-me", team_id: undefined });
  });

  it("refuses a blank title", () => {
    state().createInitiative({ client_key: "in_stub_3", title: "   ", workspace: "personal" });
    expect(state().initiatives["in_stub_3"]).toBeUndefined();
  });
});

describe("updateInitiative", () => {
  it("writes the patch as the server will echo it: a clear leaves the field absent", () => {
    state().updateInitiative(ID, { status: "completed", target_date: null, description: null });
    const r = state().initiatives[ID] as InitiativeRow;
    expect(r.status).toBe("completed");
    expect("target_date" in r && r.target_date !== undefined).toBe(false);
    expect(r.description).toBeUndefined();
    expect(r.updated_at).toBeGreaterThan(1);
  });

  it("stores an owner with kind first, and clears it with null", () => {
    state().updateInitiative(ID, { owner: { role_id: ROLE._id, kind: "role" } as any });
    expect(JSON.stringify(state().initiatives[ID].owner)).toBe(`{"kind":"role","role_id":"${ROLE._id}"}`);
    state().updateInitiative(ID, { owner: null });
    expect(state().initiatives[ID].owner).toBeUndefined();
  });
});

describe("the project list", () => {
  it("adds once, removes, and keeps an empty list a list", () => {
    state().addInitiativeProject(ID, "proj-b");
    state().addInitiativeProject(ID, "proj-b");
    expect(state().initiatives[ID].project_ids).toEqual([SCOPED, "proj-b"]);
    state().removeInitiativeProject(ID, SCOPED);
    state().removeInitiativeProject(ID, "proj-b");
    expect(state().initiatives[ID].project_ids).toEqual([]);
  });

  it("a reorder keeps each project once", () => {
    state().setInitiativeProjects(ID, ["proj-b", SCOPED, "proj-b"]);
    expect(state().initiatives[ID].project_ids).toEqual(["proj-b", SCOPED]);
  });
});

describe("postInitiativeUpdate", () => {
  it("paints the update as a stub and moves the initiative's health, and only its health", () => {
    state().postInitiativeUpdate(ID, { client_key: "in_upd_1", body: "  The inbox has a lead.  ", health: "on_track" });
    expect(state().initiativeUpdates["in_upd_1"]).toMatchObject({ _id: "in_upd_1", client_key: "in_upd_1", initiative_id: ID, body: "The inbox has a lead.", health: "on_track", by: { kind: "user", user_id: "fixture-user-me" }, workspace: "team:fixture-team" });
    const r = state().initiatives[ID] as InitiativeRow;
    expect(r.health).toBe("on_track");
    // When it was said and which update said it are the server's to stamp.
    expect(r.health_at).toBe(100);
    expect(r.latest_update_id).toBe("upd-1");
  });

  it("an empty body posts nothing", () => {
    state().postInitiativeUpdate(ID, { client_key: "in_upd_2", body: "   ", health: "off_track" });
    expect(state().initiativeUpdates["in_upd_2"]).toBeUndefined();
    expect(state().initiatives[ID].health).toBe("at_risk");
  });
});

describe("an owner role has every project of its initiative in its scope", () => {
  const scopeOf = () => state().orgTree.roles.find((r: any) => r._id === ROLE._id).scope.project_ids as string[];

  it("naming a role owner adds the projects its scope lacks, as one intent", () => {
    useInboxStore.setState({ initiatives: { [ID]: row({ project_ids: [SCOPED, "proj-new"] }) } } as any);
    state().updateInitiative(ID, { owner: { kind: "role", role_id: ROLE._id } });
    expect(scopeOf()).toEqual([...ROLE.scope.project_ids, "proj-new"]);
    expect(state().orgIntents.filter((i: any) => i.kind === "roleFields" && i.role_id === ROLE._id)).toHaveLength(1);
  });

  it("a project added under a role owner joins its scope; one already listed adds nothing", () => {
    useInboxStore.setState({ initiatives: { [ID]: row({ owner: { kind: "role", role_id: ROLE._id } }) } } as any);
    expect(state().orgIntents).toHaveLength(0);
    state().addInitiativeProject(ID, "proj-late");
    expect(scopeOf()).toContain("proj-late");
  });

  it("never narrows a role that looks after the whole workspace", () => {
    const tree = structuredClone(ORG_FIXTURE);
    tree.roles[0].scope = { project_ids: [], plan_ids: [] };
    useInboxStore.setState({ orgTree: tree, initiatives: { [ID]: row({ project_ids: ["proj-new"] }) } } as any);
    state().updateInitiative(ID, { owner: { kind: "role", role_id: ROLE._id } });
    expect(scopeOf()).toEqual([]);
    expect(state().orgIntents).toHaveLength(0);
  });

  it("a person owner touches no role", () => {
    state().updateInitiative(ID, { owner: { kind: "user", user_id: "fixture-user-sam" } });
    expect(state().orgIntents).toHaveLength(0);
  });
});
