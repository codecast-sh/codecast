import { describe, expect, test } from "bun:test";
import { hostedApprovalAnswer, hostedApprovalState, hostedAsks } from "./hostedApproval";

const parked = [
  { role: "user", content: "Remind me to put the bins out on Sundays", timestamp: 1 },
  { role: "assistant", content: "", timestamp: 10, tool_calls: [{ id: "c1" }], tool_results: [] },
];
const decision = (extra: Record<string, unknown>) => ({ conversation_id: "conv", created_at: 11, options: [{ label: "Yes" }, { label: "No" }], ...extra });

describe("hostedApprovalState", () => {
  test("parked with no row yet is pending, and asks while the engine says parked", () => {
    const state = hostedApprovalState(parked, [], "conv");
    expect(state).toBe("pending");
    expect(hostedAsks(state, true)).toBe(true);
    expect(hostedAsks(state, false)).toBe(false);
  });

  test("an open row asks", () => {
    expect(hostedAsks(hostedApprovalState(parked, [decision({ status: "pending" })], "conv"), false)).toBe(true);
  });

  // The receipt said "Waiting for your go-ahead" right above "You said yes.
  // On it", because the status lags the answer.
  test("an answer in the store ends the ask even while the status still says parked", () => {
    const state = hostedApprovalState(parked, [decision({ status: "answered", answer_index: 0 })], "conv");
    expect(hostedApprovalAnswer(state)).toBe("Yes");
    expect(hostedAsks(state, true)).toBe(false);
  });

  test("a turn that moved on past the call parks nothing", () => {
    const moved = [...parked.slice(0, 1), { ...parked[1], tool_results: [{ tool_use_id: "c1" }] }, { role: "assistant", content: "Done.", timestamp: 20 }];
    expect(hostedApprovalState(moved, [decision({ status: "pending" })], "conv")).toBe("none");
  });

  test("a row from before the parked call does not count", () => {
    expect(hostedApprovalState(parked, [decision({ status: "answered", answer_index: 0, created_at: 5 })], "conv")).toBe("pending");
  });
});
