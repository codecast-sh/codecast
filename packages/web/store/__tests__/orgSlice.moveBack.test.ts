// Move back after a failover (convex roleFailover.ts): the owner's line
// leaves the role page in the same tick as the press, survives a stale
// org.tree push, settles on the echo, and comes back if the server refuses.
// Run: bun test store/__tests__/orgSlice.moveBack.test.ts
import { describe, expect, it } from "bun:test";
import { create as mutate } from "mutative";
import { createOrgSlice, dropRejectedOrgIntent, mergeOrgTree, revertOrgIntent, orgIntentNoticeText, type OrgSliceData } from "../orgSlice";
import { ORG_FIXTURE } from "../../components/org/orgFixture";
import type { OrgTree } from "../../components/org/orgTypes";
import type { RoleFailover } from "@codecast/shared/contracts/roleFailover";

const ROLE = "fixture-role-growth";
const FAILOVER: RoleFailover = { at: 1000, reason: "offline", owner_user_id: "fixture-user-me", from: { device_id: "mac", label: "Jason's MacBook", user_id: "u-jason" }, to: { device_id: "cloud-1", label: "cloud-1", user_id: "fixture-user-me" }, cross_user: true };
const withFailover = (): OrgTree => {
  const t: OrgTree = JSON.parse(JSON.stringify(ORG_FIXTURE));
  t.roles.find((r) => r._id === ROLE)!.failover = JSON.parse(JSON.stringify(FAILOVER));
  return t;
};
const run = (data: OrgSliceData, ...args: any[]): OrgSliceData => runAs("moveOrgRoleBack", data, ...args);
const runAs = (name: "moveOrgRoleBack" | "keepOrgRoleHere", data: OrgSliceData, ...args: any[]): OrgSliceData => {
  const slice = createOrgSlice();
  return mutate(data, (draft) => { (slice[name] as any).call(draft, ...args); });
};
const roleOf = (t: OrgTree | null) => t!.roles.find((r) => r._id === ROLE)!;

describe("move back", () => {
  it("clears the line at once, holds over a stale push, and settles on the echo", () => {
    const st = run({ orgTree: withFailover(), orgIntents: [] }, ROLE);
    expect(roleOf(st.orgTree).failover).toBeUndefined();
    expect(st.orgIntents).toHaveLength(1);
    const stale = mergeOrgTree(withFailover(), st.orgIntents);
    expect(roleOf(stale.tree).failover).toBeUndefined();
    expect(stale.intents).toHaveLength(1);
    const echo: OrgTree = JSON.parse(JSON.stringify(ORG_FIXTURE));
    const settled = mergeOrgTree(echo, st.orgIntents);
    expect(settled.intents).toHaveLength(0);
    expect(settled.tree).toBe(echo);
  });

  it("a refusal puts the line back and says so", () => {
    const st = run({ orgTree: withFailover(), orgIntents: [] }, ROLE);
    const reverted: string[] = [];
    const notices = dropRejectedOrgIntent({ orgIntents: st.orgIntents, dropOrgIntent: () => {}, revertOrgIntent: (id) => reverted.push(id) }, "moveOrgRoleBack", [ROLE]);
    expect(reverted).toEqual([st.orgIntents[0].id]);
    expect(notices[0]).toBe(orgIntentNoticeText(st.orgIntents[0], "refused"));
    const back = mutate(st, (d) => { revertOrgIntent(d as any, d.orgIntents[0] as any); });
    expect(roleOf(back.orgTree).failover).toEqual(FAILOVER);
  });

  it("does nothing for a role with no move to undo", () => {
    const st = run({ orgTree: JSON.parse(JSON.stringify(ORG_FIXTURE)), orgIntents: [] }, ROLE);
    expect(st.orgIntents).toHaveLength(0);
  });
});

describe("keep here", () => {
  it("clears the line at once, and only its own refusal puts it back", () => {
    const st = runAs("keepOrgRoleHere", { orgTree: withFailover(), orgIntents: [] }, ROLE);
    expect(roleOf(st.orgTree).failover).toBeUndefined();
    const store = (reverted: string[]) => ({ orgIntents: st.orgIntents, dropOrgIntent: () => {}, revertOrgIntent: (id: string) => reverted.push(id) });
    const other: string[] = [];
    dropRejectedOrgIntent(store(other), "moveOrgRoleBack", [ROLE]);
    expect(other).toEqual([]);
    const own: string[] = [];
    const notices = dropRejectedOrgIntent(store(own), "keepOrgRoleHere", [ROLE]);
    expect(own).toEqual([st.orgIntents[0].id]);
    expect(notices[0]).toBe("Keeping @" + roleOf(withFailover()).handle + " on cloud-1 was refused.");
  });
});
