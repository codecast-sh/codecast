// The area writes (store/decisionAreasSlice.ts) paint on the click and ride
// dispatch to the side effect of the same name: applying a map sets each
// member's areas (a member it leaves out keeps none), and Share out makes each
// moved decision its new owner's alone.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { useInboxStore } from "../inboxStore";

const s = () => useInboxStore.getState() as any;
const ME = "u".repeat(32);
const SAM = "s".repeat(32);
const BOT = "b".repeat(32);
const D1 = "d".repeat(32);
const D2 = "e".repeat(32);

let calls: Array<[string, unknown[]]> = [];
const owner = {};
beforeAll(() => s()._setDispatch(async (action: string, args: unknown[]) => { calls.push([action, args]); return null; }, { owner }));
afterAll(() => s()._clearDispatch(owner));
beforeEach(() => {
  calls = [];
  useInboxStore.setState({
    currentUser: { _id: ME, name: "Ashot" },
    teamMembers: [
      { _id: ME, name: "Ashot", role: "admin", focus_project_ids: ["p9"] },
      { _id: SAM, name: "Samvit", role: "member" },
      { _id: BOT, name: "Bot", is_bot: true, focus_project_ids: ["p1"] },
    ],
    sessionDecisions: {
      [D1]: { _id: D1, status: "pending", holder: { kind: "user", id: ME }, holder_key: `user:${ME}`, asked_user_ids: [ME], in_queue: true },
      [D2]: { _id: D2, status: "answered", holder: { kind: "user", id: ME }, holder_key: `user:${ME}`, asked_user_ids: [ME] },
    },
    pending: {},
  } as any);
});

describe("applyDecisionAreas", () => {
  it("paints each member's areas and rides dispatch", () => {
    const map = [{ user_id: SAM, project_ids: ["p1", "p2"], takes_decisions: false }];
    s().applyDecisionAreas("t1", map);
    const m = (id: string) => s().teamMembers.find((x: any) => x._id === id);
    expect(m(SAM)).toMatchObject({ focus_project_ids: ["p1", "p2"], takes_decisions: false });
    expect(m(ME).focus_project_ids).toEqual([]);
    expect(m(BOT).focus_project_ids).toEqual(["p1"]);
    expect(calls).toEqual([["applyDecisionAreas", ["t1", map]]]);
  });
});

describe("shareOutDecisions", () => {
  it("each open decision becomes its new owner's alone; an answered one is left", () => {
    s().shareOutDecisions("t1", [{ decision_id: D1, to: SAM }, { decision_id: D2, to: SAM }]);
    expect(s().sessionDecisions[D1]).toMatchObject({ holder: { kind: "user", id: SAM }, holder_key: `user:${SAM}`, asked_user_ids: [SAM], in_queue: false });
    expect(s().sessionDecisions[D2].asked_user_ids).toEqual([ME]);
    expect(calls[0][0]).toBe("shareOutDecisions");
  });
});
