import { describe, expect, test } from "bun:test";
import { alignGateChoices, optionMoves } from "./gateChoices";

const gate = [{ key: "S", label: "[S] Ship", target: "trial_ship" }, { key: "R", label: "[R] Revise", target: "revise_build" }, { key: "D", label: "[D] Drop", target: "trial_drop" }];

describe("alignGateChoices", () => {
  test("a session's own options route by label, in the order it wrote them", () => {
    expect(alignGateChoices([{ label: "Drop" }, { label: "Ship" }], gate).map((c) => c?.key ?? null)).toEqual(["D", "S"]);
  });
  test("an option in the session's own words routes by its verdict", () => {
    expect(alignGateChoices([{ label: "Ship it as is" }, { label: "Revise: rewrite the close note first" }, { label: "Drop the fix" }], gate).map((c) => c?.key ?? null)).toEqual(["S", "R", "D"]);
  });
  test("a proposal gate's own labels lead the session's words", () => {
    const proposal = [{ key: "A", label: "[A] Build it", target: "approve" }, { key: "R", label: "[R] Revise", target: "revise_proposal" }, { key: "N", label: "[N] Not now", target: "drop_proposal" }];
    expect(alignGateChoices([{ label: "Build it: the prompt change only" }, { label: "Not now" }], proposal).map((c) => c?.key ?? null)).toEqual(["A", "N"]);
  });
  test("an option that names no edge carries no key", () => {
    expect(alignGateChoices([{ label: "Ask Jason first" }], gate)).toEqual([null]);
  });
});

describe("optionMoves", () => {
  test("each old option follows its words to its new place; one no new option says is gone", () => {
    const before = [{ label: "Ship the separate read" }, { label: "Let the agent handle it" }, { label: "Drop it" }];
    expect(optionMoves(before, [before[1], before[0], before[2]])).toEqual([1, 0, 2]);
    expect(optionMoves(before, [{ label: "Let the agent handle it" }, { label: "Drop it" }])).toEqual([undefined, 0, 1]);
  });
});
