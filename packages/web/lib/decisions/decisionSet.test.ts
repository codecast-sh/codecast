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

test("a line's or a flow's count opens exactly the decisions it counted", () => {
  const n = (ref: string | null, over: Record<string, unknown> = {}) => ({ counted: true, kind: "decision", decisionRef: ref, decisionId: null, ...over });
  const scoped = [n("sd-4"), n("sd-2"), n(null, { decisionId: "d7" }), n("sd-4"), n("ct-3", { kind: "confirm" }), n("sd-9", { counted: false })];
  expect(flowDecisionsHref({}, scoped)).toBe("/decisions/sd-4?set=sd-4,sd-2,d7");
  expect(flowDecisionsHref({}, [n("sd-5")])).toBe("/decisions/sd-5");
  expect(flowDecisionsHref({}, [])).toBe("/decisions?tab=team&source=flows");
});

const queue = ["sd-1", "sd-2", "sd-3", "sd-4"];

test("a decision in the queue flips through the whole queue, whatever the list's view holds", () => {
  const nav = decisionNav({ named: [], list: ["sd-2", "sd-9"], queue }, ["sd-2"], null);
  expect(nav).toMatchObject({ src: "queue", at: 1, prev: "sd-1", next: "sd-3" });
  expect(nav.set.length).toBe(4);
});

test("one outside the queue flips through the list it was opened from, and a named set wins over both", () => {
  expect(decisionNav({ named: [], list: ["sd-8", "sd-9"], queue }, ["sd-9"], null)).toMatchObject({ src: "list", at: 1, prev: "sd-8", next: null });
  expect(decisionNav({ named: ["sd-2", "sd-7"], list: queue, queue }, ["sd-2"], null)).toMatchObject({ src: "named", at: 0, next: "sd-7" });
});

test("one in no set still offers the queue", () => {
  expect(decisionNav({ named: [], list: [], queue }, ["sd-50"], null)).toMatchObject({ src: "queue", at: -1, prev: null, next: "sd-1" });
});

test("an answered decision keeps its slot, so next is the one that slid into it", () => {
  const before = decisionNav({ named: [], list: [], queue }, ["sd-2"], null);
  const after = decisionNav({ named: [], list: [], queue: ["sd-1", "sd-3", "sd-4"] }, ["sd-2"], before.slot);
  expect(after).toMatchObject({ at: -1, prev: "sd-1", next: "sd-3" });
  expect(after.set.length).toBe(3);
});

test("the last decision answered has no next", () => {
  const before = decisionNav({ named: [], list: [], queue: ["sd-1"] }, ["sd-1"], null);
  expect(decisionNav({ named: [], list: [], queue: [] }, ["sd-1"], before.slot)).toMatchObject({ next: null, prev: null });
});
