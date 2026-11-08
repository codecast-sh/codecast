// The goal pill and /goal paint from the store before the server answers
// (convex sessionGoals.ts): each action flips the draft and dispatches its
// named side effect with the arguments the server handler reads.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { sessionGoalOf } from "@codecast/shared/contracts/sessionGoal";
import { useInboxStore } from "../inboxStore";

const CONV = "c".repeat(32);
const s = () => useInboxStore.getState() as any;
let calls: Array<[string, unknown[]]> = [];
const owner = {};

beforeAll(() => s()._setDispatch(async (action: string, args: unknown[]) => { calls.push([action, args]); return null; }, { owner }));
afterAll(() => s()._clearDispatch(owner));
beforeEach(() => {
  calls = [];
  useInboxStore.setState({ pending: {}, sessionGoals: {}, currentUser: { _id: "u".repeat(32), name: "Me" } } as any);
});
const goal = () => sessionGoalOf(s().sessionGoals, CONV);

describe("session goal actions", () => {
  it("set paints an active stub that supersedes the previous goal, and dispatches", async () => {
    s().setSessionGoal(CONV, " first ", "k1");
    s().setSessionGoal(CONV, "second", "k2");
    await new Promise((r) => setTimeout(r, 0));
    expect(goal()).toMatchObject({ _id: "k2", objective: "second", status: "active", rounds: 0, max_rounds: 50, max_stalls: 3 });
    expect(calls.map(([a, args]) => [a, args])).toEqual([["setSessionGoal", [CONV, " first ", "k1"]], ["setSessionGoal", [CONV, "second", "k2"]]]);
  });
  it("pause, resume and clear flip the row the server will echo", async () => {
    s().setSessionGoal(CONV, "x", "k1");
    s().pauseSessionGoal(CONV);
    expect(goal()).toMatchObject({ status: "paused", reason: "Paused by the person" });
    s().resumeSessionGoal(CONV);
    expect(goal()).toMatchObject({ status: "active", rounds: 0, stalls: 0, reason: undefined });
    s().clearSessionGoal(CONV);
    expect(goal()?.status).toBe("cleared");
    await new Promise((r) => setTimeout(r, 0));
    expect(calls.map(([a]) => a)).toEqual(["setSessionGoal", "pauseSessionGoal", "resumeSessionGoal", "clearSessionGoal"]);
  });
});
