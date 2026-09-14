// The org tree's pending protection (store/orgSlice.ts header). A meta
// singleton gets no engine pending entry, so an optimistic edit survives a
// stale org.tree push only because the merge replays open intents.
import { describe, expect, it } from "bun:test";
import { create as mutate } from "mutative";
import {
  createOrgSlice,
  mergeOrgTree,
  orgIntentSatisfied,
  dropRejectedOrgIntent,
  ORG_INTENT_TTL_MS,
  type OrgIntent,
  type OrgSliceData,
} from "../orgSlice";
import { ORG_FIXTURE, ORG_FIXTURE_ALL_SESSIONS } from "../../components/org/orgFixture";
import { sortOrgSessions, type OrgTree } from "../../components/org/orgTypes";

const ME = "fixture-user-me";
const SAM = "fixture-user-sam";
const ROLE = "fixture-role-growth";
const clone = (): OrgTree => JSON.parse(JSON.stringify(ORG_FIXTURE));

/** Run a slice action body against a draft, the way the middleware does. */
function run(data: OrgSliceData, name: keyof ReturnType<typeof createOrgSlice>, ...args: any[]): OrgSliceData {
  const slice = createOrgSlice();
  return mutate(data, (draft) => { (slice[name] as any).call(draft, ...args); });
}

describe("org intents", () => {
  it("a session move records an intent that a stale push cannot revert, and the echo clears", () => {
    const before = clone();
    const top = before.people[0].sessions[0];
    let st: OrgSliceData = { orgTree: before, orgIntents: [] };
    st = run(st, "reparentOrgSession", top._id, { kind: "role", role_id: ROLE });
    expect(st.orgIntents).toHaveLength(1);
    expect(st.orgTree!.roles[0].sessions.some((s) => s._id === top._id)).toBe(true);
    expect(st.orgTree!.roles[0].total).toBe(ORG_FIXTURE.roles[0].total + 1);

    // A push that started before the mutation landed carries the OLD shape.
    const stale = mergeOrgTree(clone(), st.orgIntents);
    expect(stale.intents).toHaveLength(1);
    expect(stale.tree.roles[0].sessions.some((s) => s._id === top._id)).toBe(true);
    expect(stale.tree.people[0].sessions.some((s) => s._id === top._id)).toBe(false);
    // The feeder's object is not mutated in place.
    expect(clone().people[0].sessions.some((s) => s._id === top._id)).toBe(true);

    // The echo: the server files it under the role. Intent gone, tree as sent.
    const echo = clone();
    const i = echo.people[0].sessions.findIndex((s) => s._id === top._id);
    const [moved] = echo.people[0].sessions.splice(i, 1);
    echo.roles[0].sessions.unshift({ ...moved, org_role_id: ROLE });
    const settled = mergeOrgTree(echo, st.orgIntents);
    expect(settled.intents).toHaveLength(0);
    expect(settled.tree).toBe(echo);
  });

  it("a session loaded beyond the top N moves with its counts when the page hands the row over", () => {
    const tree = clone();
    const beyond = sortOrgSessions(ORG_FIXTURE_ALL_SESSIONS.filter((s) => s.owner_user_id === ME && !s.org_role_id))[10];
    expect(tree.people[0].sessions.some((s) => s._id === beyond._id)).toBe(false);
    const meBefore = tree.people[0].total;
    const roleBefore = tree.roles[0].total;
    let st: OrgSliceData = { orgTree: tree, orgIntents: [] };
    st = run(st, "reparentOrgSession", beyond._id, { kind: "role", role_id: ROLE }, beyond);
    expect(st.orgTree!.people[0].total).toBe(meBefore - 1);
    expect(st.orgTree!.roles[0].total).toBe(roleBefore + 1);
    expect(st.orgTree!.roles[0].sessions.some((s) => s._id === beyond._id)).toBe(true);
    // Without the row the slice cannot find it: no intent, no half move.
    const none = run({ orgTree: clone(), orgIntents: [] }, "reparentOrgSession", beyond._id, { kind: "role", role_id: ROLE });
    expect(none.orgIntents).toHaveLength(0);
    expect(none.orgTree!.roles[0].total).toBe(roleBefore);
  });

  it("a role reparent and a follow toggle replay onto a stale push and clear on echo", () => {
    let st: OrgSliceData = { orgTree: clone(), orgIntents: [] };
    st = run(st, "reparentOrgRole", ROLE, { kind: "user", user_id: SAM });
    st = run(st, "followOrgChannel", "or-1", "k".padEnd(32, "0"), true);
    expect(st.orgIntents.map((i) => i.kind)).toEqual(["moveRole", "follow"]);
    const stale = mergeOrgTree(clone(), st.orgIntents);
    expect(stale.tree.roles[0].reports_to).toEqual({ kind: "user", user_id: SAM });
    expect(stale.tree.roles[0].follow_channel_ids).toEqual(["k".padEnd(32, "0")]);
    const echo = clone();
    echo.roles[0].reports_to = { kind: "user", user_id: SAM };
    echo.roles[0].follow_channel_ids = ["k".padEnd(32, "0")];
    expect(mergeOrgTree(echo, st.orgIntents).intents).toHaveLength(0);
  });

  it("a follow on a stub channel id is refused before it is drawn", () => {
    const st = run({ orgTree: clone(), orgIntents: [] }, "followOrgChannel", "or-1", "chatstub-abc", true);
    expect(st.orgIntents).toHaveLength(0);
    expect(st.orgTree!.roles[0].follow_channel_ids ?? []).toEqual([]);
  });

  it("an intent ages out, and a rejected dispatch drops it at once", () => {
    const old: OrgIntent = { kind: "moveRole", id: "x", role_id: ROLE, reports_to: { kind: "user", user_id: SAM }, at: Date.now() - ORG_INTENT_TTL_MS - 1 };
    expect(mergeOrgTree(clone(), [old]).intents).toHaveLength(0);
    let st: OrgSliceData = { orgTree: clone(), orgIntents: [] };
    st = run(st, "reparentOrgRole", ROLE, { kind: "user", user_id: SAM });
    const dropped: string[] = [];
    dropRejectedOrgIntent({ orgIntents: st.orgIntents, dropOrgIntent: (id) => dropped.push(id) }, "reparentOrgRole", [ROLE, { kind: "user", user_id: SAM }]);
    expect(dropped).toEqual([st.orgIntents[0].id]);
    // A different subject is left alone.
    dropped.length = 0;
    dropRejectedOrgIntent({ orgIntents: st.orgIntents, dropOrgIntent: (id) => dropped.push(id) }, "reparentOrgRole", ["other-role", {}]);
    expect(dropped).toEqual([]);
  });

  it("satisfaction reads the tree, not the intent", () => {
    const tree = clone();
    expect(orgIntentSatisfied(tree, { kind: "moveRole", id: "a", role_id: ROLE, reports_to: { kind: "user", user_id: ME }, at: 0 })).toBe(true);
    expect(orgIntentSatisfied(tree, { kind: "moveRole", id: "a", role_id: ROLE, reports_to: { kind: "user", user_id: SAM }, at: 0 })).toBe(false);
    expect(orgIntentSatisfied(tree, { kind: "moveRole", id: "a", role_id: "gone", reports_to: { kind: "user", user_id: SAM }, at: 0 })).toBe(true);
  });

  it("retiring a role carries its unseen sessions to the parent person's counts", () => {
    const tree = clone();
    const role = tree.roles[0];
    role.total = 30; // 8 drawn, 22 beyond the top N
    role.counts = { ...role.counts, idle: (role.counts.idle ?? 0) + 22 };
    const meTotal = tree.people[0].total;
    const st = run({ orgTree: tree, orgIntents: [] }, "retireOrgRole", ROLE);
    expect(st.orgTree!.roles).toHaveLength(0);
    // 7 drawn rows (the fixture role holds 7 of 8) re-home by owner, the
    // remaining 23 land on the parent person: the header total is unchanged.
    expect(st.orgTree!.people[0].total).toBe(meTotal + 30);
  });
});
