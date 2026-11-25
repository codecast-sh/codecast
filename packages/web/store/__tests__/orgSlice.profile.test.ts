// A person's profile edit (store/orgProfile.ts): the short fields paint on the
// tree row as an intent a stale org.tree push cannot revert, `about` lands on
// the person's detail row, and a refusal puts the row back.
import { describe, expect, it } from "bun:test";
import { create as mutate } from "mutative";
import { createOrgSlice, mergeOrgTree, dropRejectedOrgIntent, revertOrgIntent, type OrgSliceData } from "../orgSlice";
import { ORG_FIXTURE } from "../../components/org/orgFixture";
import type { OrgTree } from "../../components/org/orgTypes";

const TEAM = "team1";
const SAM = "fixture-user-sam";
const clone = (): OrgTree => JSON.parse(JSON.stringify(ORG_FIXTURE));
const run = (data: OrgSliceData, ...args: any[]): OrgSliceData => {
  const slice = createOrgSlice();
  return mutate(data, (draft) => { (slice.setOrgPersonProfile as any).call(draft, ...args); });
};
const sam = (t: OrgTree | null) => t!.people.find((p) => p.user_id === SAM)!;

describe("person profile edits", () => {
  it("paints the short fields, survives a stale push, and settles on the echo", () => {
    let st = { orgTree: clone(), orgIntents: [], orgPersonDetails: {} } as unknown as OrgSliceData;
    st = run(st, TEAM, SAM, { title: "  Head of   Growth ", focus: "paid search", labels: ["Growth", "ads"] });
    expect(sam(st.orgTree)).toMatchObject({ title: "Head of Growth", focus: "paid search", labels: ["growth", "ads"] });
    expect(st.orgIntents).toHaveLength(1);

    const stale = mergeOrgTree(clone(), st.orgIntents);
    expect(sam(stale.tree).title).toBe("Head of Growth");
    expect(stale.intents).toHaveLength(1);

    const echo = clone();
    Object.assign(sam(echo), { title: "Head of Growth", focus: "paid search", labels: ["growth", "ads"] });
    expect(mergeOrgTree(echo, st.orgIntents).intents).toHaveLength(0);
  });

  it("clearing a field matches a server row that has none", () => {
    const tree = clone();
    sam(tree).title = "Old";
    let st = { orgTree: tree, orgIntents: [], orgPersonDetails: {} } as unknown as OrgSliceData;
    st = run(st, TEAM, SAM, { title: "" });
    expect(sam(st.orgTree).title).toBeUndefined();
    expect(mergeOrgTree(clone(), st.orgIntents).intents).toHaveLength(0);
  });

  it("writes about on the detail row and leaves the tree alone", () => {
    let st = { orgTree: clone(), orgIntents: [], orgPersonDetails: {} } as unknown as OrgSliceData;
    st = run(st, TEAM, SAM, { about: "Bring me ad questions." });
    expect((st as any).orgPersonDetails[`${TEAM}:${SAM}`].about).toBe("Bring me ad questions.");
    expect(st.orgIntents).toHaveLength(0);
  });

  it("a refusal puts the row back", () => {
    let st = { orgTree: clone(), orgIntents: [], orgPersonDetails: {} } as unknown as OrgSliceData;
    st = run(st, TEAM, SAM, { title: "Nope" });
    const state = {
      orgIntents: st.orgIntents,
      dropOrgIntent: () => {},
      revertOrgIntent: (id: string) => { st = mutate(st, (d) => { revertOrgIntent(d as any, d.orgIntents.find((i) => i.id === id)!); d.orgIntents = d.orgIntents.filter((i) => i.id !== id); }); },
    };
    const notices = dropRejectedOrgIntent(state, "setOrgPersonProfile", [TEAM, SAM, { title: "Nope" }]);
    expect(notices).toHaveLength(1);
    expect(sam(st.orgTree).title).toBe(sam(clone()).title);
  });
});

describe("role managers", () => {
  const ROLE = "fixture-role-growth";
  const runRole = (data: OrgSliceData, ...args: any[]): OrgSliceData => {
    const slice = createOrgSlice();
    return mutate(data, (draft) => { (slice.setOrgRoleManagers as any).call(draft, ...args); });
  };
  it("draws the first manager, keeps the rest, and settles when the tree agrees", () => {
    const me = clone().people.find((p) => p.is_me)!.user_id;
    const list = [{ kind: "user", user_id: me }, { kind: "user", user_id: SAM }];
    let st = { orgTree: clone(), orgIntents: [], orgPersonDetails: {} } as unknown as OrgSliceData;
    st = runRole(st, ROLE, list);
    const role = st.orgTree!.roles.find((r) => r._id === ROLE)!;
    expect(role.reports_to).toEqual(list[0] as any);
    expect(role.also_reports_to).toEqual([list[1]] as any);
    expect(mergeOrgTree(clone(), st.orgIntents).tree.roles.find((r) => r._id === ROLE)!.also_reports_to).toEqual([list[1]] as any);
    const echo = clone();
    Object.assign(echo.roles.find((r) => r._id === ROLE)!, { reports_to: list[0], also_reports_to: [list[1]] });
    expect(mergeOrgTree(echo, st.orgIntents).intents).toHaveLength(0);
  });
  it("refuses an empty list", () => {
    const st = runRole({ orgTree: clone(), orgIntents: [], orgPersonDetails: {} } as unknown as OrgSliceData, ROLE, []);
    expect(st.orgIntents).toHaveLength(0);
  });
});

describe("who may change what", () => {
  const { managerEditRule, mayEditProfile } = require("../orgProfile");
  const tree = (meRole: string): OrgTree => {
    const t = clone();
    t.people.find((p) => p.is_me)!.role = meRole as any;
    return t;
  };
  it("an admin or the person edits any of it; a manager only what they answer for; anyone else nothing", () => {
    const me = clone().people.find((p) => p.is_me)!.user_id;
    const other = { kind: "user", user_id: "someone-else" };
    expect(managerEditRule(tree("admin"), SAM)(other)).toBe(true);
    expect(mayEditProfile(tree("member"), SAM)).toBe(false);
    expect(mayEditProfile(tree("member"), me)).toBe(true);
    // A member who does not manage Sam may change nothing of Sam's.
    expect(managerEditRule(tree("member"), SAM)({ kind: "user", user_id: me })).toBe(false);
    // Once they manage Sam, they may change only what they answer for.
    const managed = tree("member");
    managed.people.find((p) => p.user_id === SAM)!.managers = [{ kind: "user", user_id: me }];
    const rule = managerEditRule(managed, SAM);
    expect(rule(other)).toBe(false);
    expect(rule({ kind: "user", user_id: me })).toBe(true);
    const mine = managed.roles.find((r) => r.reports_to.kind === "user" && r.reports_to.user_id === me);
    if (mine) expect(rule({ kind: "role", role_id: mine._id })).toBe(true);
  });
});
