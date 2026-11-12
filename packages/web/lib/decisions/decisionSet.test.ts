import { expect, test } from "bun:test";
import { decisionNav, decisionSetHref, flowDecisionsHref, parseDecisionSet, setPosition } from "./decisionSet";

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

const mine = ["sd-1", "sd-2", "sd-3", "sd-4"];

test("a decision the list's view leaves out still flips through the viewer's whole open queue", () => {
  const nav = decisionNav({ named: [], list: ["sd-9"], mine }, ["sd-2"], null);
  expect(nav).toMatchObject({ src: "mine", at: 1, prev: "sd-1", next: "sd-3" });
  expect(nav.set.length).toBe(4);
});

test("the list's order wins when it holds the decision, and a named set over both", () => {
  expect(decisionNav({ named: [], list: ["sd-3", "sd-2"], mine }, ["sd-2"], null)).toMatchObject({ src: "list", at: 1, next: null });
  expect(decisionNav({ named: ["sd-2", "sd-7"], list: mine, mine }, ["sd-2"], null)).toMatchObject({ src: "named", at: 0, next: "sd-7" });
});

test("an answered decision keeps its slot, so next is the one that slid into it", () => {
  const before = decisionNav({ named: [], list: [], mine }, ["sd-2"], null);
  const after = decisionNav({ named: [], list: [], mine: ["sd-1", "sd-3", "sd-4"] }, ["sd-2"], before.slot);
  expect(after).toMatchObject({ at: -1, prev: "sd-1", next: "sd-3" });
  expect(after.set.length).toBe(3);
});

test("the last decision answered has no next", () => {
  const before = decisionNav({ named: [], list: [], mine: ["sd-1"] }, ["sd-1"], null);
  expect(decisionNav({ named: [], list: [], mine: [] }, ["sd-1"], before.slot)).toMatchObject({ next: null, prev: null });
});
