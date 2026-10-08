// This week's numbers (orgFlow.ts): each role's week as a series keyed
// the way org.health keys it, the company's week as their sum, the map's edge
// weights and handoffs, and the two what-ifs, including what they refuse to
// claim.
import { describe, expect, test } from "bun:test";
import { ORG_FIXTURE } from "./orgFixture";
import { ORG_STAFFING_FIXTURE_HEALTH } from "./orgStaffingFixture";
import { companyFlow, flowDays, flowMap, moveAsk, projectCap, projectMove, roleFlows } from "./orgFlow";
import { roleNodeId } from "./orgLayout";

const tree = { ...ORG_FIXTURE, roles: [...ORG_FIXTURE.roles, { ...ORG_FIXTURE.roles[0], _id: "fixture-role-head", short_id: "or-9", handle: "head-of-people", name: "Head of People", reports_to: { kind: "user" as const, user_id: ORG_FIXTURE.people[0].user_id }, standing: { conversation_id: "fixture-head-conv", short_id: "jx7ch1f" } }] };
const now = ORG_STAFFING_FIXTURE_HEALTH.generated_at;

describe("the week", () => {
  test("seven UTC days, oldest first, today last", () => {
    const days = flowDays(Date.parse("2026-10-01T15:00:00Z"));
    expect(days).toEqual(["2026-09-25", "2026-09-26", "2026-09-27", "2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01"]);
  });

  test("each role's series reads org.health's days, busiest first, with its limit and the days it reached it", () => {
    const flows = roleFlows(tree, ORG_STAFFING_FIXTURE_HEALTH, now);
    expect(flows.map((f) => f.role.handle)).toEqual(["growth", "head-of-people"]);
    const growth = flows[0];
    expect(growth.wakes).toEqual([41, 40, 12, 18, 44, 40, 22]);
    expect(growth.done).toEqual([2, 3, 0, 1, 3, 2, 1]);
    expect(growth.wakesTotal).toBe(217);
    expect(growth.cap).toBe(40);
    expect(growth.daysAtCap).toBe(4);
    expect(growth.nodeId).toBe(roleNodeId("fixture-role-growth"));
    expect(growth.statusWord).toBe("stuck");
  });

  test("a role health has not read still stands, at zero; a server without the series falls back on the week's totals", () => {
    const old = { ...ORG_STAFFING_FIXTURE_HEALTH, roles: ORG_STAFFING_FIXTURE_HEALTH.roles.map((r) => ({ ...r, spend: { ...r.spend, wakes_by_day: undefined }, flow: { ...r.flow, done_by_day: undefined } })) };
    const growth = roleFlows(tree, old, now).find((f) => f.role.handle === "growth")!;
    expect(growth.wakes).toEqual([0, 0, 0, 0, 0, 0, 0]);
    expect(growth.wakesTotal).toBe(63); // items_per_day 9 × 7
    expect(growth.doneTotal).toBe(12);
    const none = roleFlows(tree, null, now);
    expect(none).toHaveLength(2);
    expect(none.every((f) => f.wakesTotal === 0 && f.health === null)).toBe(true);
  });

  test("the company's week is the roles' days added", () => {
    const c = companyFlow(roleFlows(tree, ORG_STAFFING_FIXTURE_HEALTH, now));
    expect(c.wakes).toEqual([45, 45, 15, 24, 48, 43, 25]);
    expect(c.atCap).toBe(1);
  });
});

describe("the map", () => {
  test("a reporting edge into a role carries its week; a handoff runs from the sender to the receiver", () => {
    const m = flowMap(roleFlows(tree, ORG_STAFFING_FIXTURE_HEALTH, now));
    expect(m.into[roleNodeId("fixture-role-growth")]).toMatchObject({ n: 217, atLimit: true });
    expect(m.into[roleNodeId("fixture-role-head")]).toMatchObject({ n: 28, atLimit: false });
    expect(m.sends).toEqual([{ id: "send:fixture-role-head->fixture-role-growth", source: roleNodeId("fixture-role-head"), target: roleNodeId("fixture-role-growth"), n: 3 }]);
    expect(m.max).toBe(217);
  });
});

describe("what if", () => {
  const [growth, head] = roleFlows(tree, ORG_STAFFING_FIXTURE_HEALTH, now);

  test("a lower limit counts the days the week would have reached it", () => {
    expect(projectCap(growth, 20)).toMatchObject({ daysAtCap: 5, unknownDays: 0, heldAtLeast: 21 + 20 + 24 + 20 + 2 });
  });

  test("a higher limit cannot say what the held days would have done, and says so apart", () => {
    const p = projectCap(growth, 60);
    expect(p.daysAtCap).toBe(0);
    expect(p.unknownDays).toBe(4);
    expect(p.headroom).toBe(16);
  });

  test("moving a share replays the week on both sides, and the line to the Head of People says it in numbers", () => {
    const p = projectMove(growth, head, 0.5);
    expect(p.from).toEqual([21, 20, 6, 9, 22, 20, 11]);
    expect(p.to).toEqual([25, 25, 9, 15, 26, 23, 14]);
    expect(p.fromDaysAtCap).toBe(0);
    expect(p.toDaysAtCap).toBe(0);
    expect(p.moved).toBe(217 - 109);
    expect(moveAsk(growth, head, p)).toMatch(/^Propose moving about 50% of Head of Growth \(@growth\)'s work to Head of People \(@head-of-people\)\. Over the last week that is about 108 of the 217 pieces of work that reached it; .* at its limit on 0 days instead of 4/);
  });
});
