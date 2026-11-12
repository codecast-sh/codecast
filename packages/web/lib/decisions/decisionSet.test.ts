import { expect, test } from "bun:test";
import { decisionSetHref, flowDecisionsHref, parseDecisionSet, setPosition } from "./decisionSet";

test("a set reads from the address once each, lowercased", () => {
  expect(parseDecisionSet("sd-3, SD-1,sd-3,,sd-2")).toEqual(["sd-3", "sd-1", "sd-2"]);
  expect(parseDecisionSet(null)).toEqual([]);
});

test("a set of one is just the decision's page", () => {
  expect(decisionSetHref("sd-1", ["sd-1"])).toBe("/decisions/sd-1");
  expect(decisionSetHref("sd-2", ["sd-1", "sd-2"])).toBe("/decisions/sd-2?set=sd-1,sd-2");
});

test("a decision finds its neighbours by short id or row id", () => {
  const set = ["sd-1", "sd-2", "abc123"];
  expect(setPosition(set, ["SD-2", "x"])).toEqual({ at: 1, prev: "sd-1", next: "abc123" });
  expect(setPosition(set, [undefined, "abc123"])).toEqual({ at: 2, prev: "sd-2", next: null });
  expect(setPosition(set, ["sd-9"])).toBeNull();
});

test("the Line's old Decisions address lands on the Decisions page", () => {
  expect(flowDecisionsHref({ need: "SD-9" })).toBe("/decisions/sd-9");
  expect(flowDecisionsHref({ decision: "sd-4", need: "ct-3" })).toBe("/decisions/sd-4");
  expect(flowDecisionsHref({ need: "ct-3" })).toBe("/decisions?tab=team&source=flows");
  expect(flowDecisionsHref({ who: "me" })).toBe("/decisions?source=flows");
});
