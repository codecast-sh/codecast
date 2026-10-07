// The pointer a thread carries toward the org screen (org-staffing.md S36, S41).
// Run: bun test components/org/orgChartPointer.test.ts
import { describe, expect, test } from "bun:test";
import { chartPointerOfParams, chartPointerOfText, newestChartPointer } from "./orgChartPointer";

describe("the pointer an address carries", () => {
  test("reads the proposal, the focus and the lens; the screen's own keys are not a pointer", () => {
    expect(chartPointerOfParams(new URLSearchParams("proposal=op-7&focus=in-3&lens=goals&show=map&beside=conv1"))).toEqual({ proposal: "op-7", focus: "in-3", lens: "goals" });
  });
  test("ignores what is not a proposal or a lens", () => {
    expect(chartPointerOfParams(new URLSearchParams("proposal=ds-3&lens=sideways"))).toEqual({});
  });
  test("proposed=0 turns the overlay off; anything else leaves it on", () => {
    expect(chartPointerOfParams(new URLSearchParams("proposal=op-1&proposed=0"))).toEqual({ proposal: "op-1", proposed: false });
    expect(chartPointerOfParams(new URLSearchParams("proposal=op-1&proposed=1"))).toEqual({ proposal: "op-1" });
  });
});

describe("the pointer a message carries", () => {
  test("op-N on its own line is the proposal; in a sentence it is prose", () => {
    expect(chartPointerOfText("Here is what I would change.\n\nop-12\n\nTell me what you think.")).toEqual({ proposal: "op-12" });
    expect(chartPointerOfText("I revised op-12 after your note.")).toBeNull();
  });
  test("op-N#seq on its own line is that change; in a sentence it is prose", () => {
    expect(chartPointerOfText("One change for you:\n\nop-55#3\n\nSay the word.")).toEqual({ proposal: "op-55", focus: "3" });
    expect(chartPointerOfText("  op-55#3  ")).toEqual({ proposal: "op-55", focus: "3" });
    expect(chartPointerOfText("Rejected op-55#2 (make it P2): too high.")).toBeNull();
    expect(chartPointerOfText("op-55#3\n\nop-55")).toEqual({ proposal: "op-55" });
  });
  test("a link to the org page carries a focus and a lens, with or without a host", () => {
    expect(chartPointerOfText("Look at the owner: https://codecast.sh/org?proposal=op-12&focus=3")).toEqual({ proposal: "op-12", focus: "3" });
    expect(chartPointerOfText("[the goal](/org?show=map&proposal=op-12&focus=in-4&lens=goals).")).toEqual({ proposal: "op-12", focus: "in-4", lens: "goals" });
  });
  test("the last pointer in a message wins", () => {
    expect(chartPointerOfText("op-3\n\nand then /org?proposal=op-4&focus=2")).toEqual({ proposal: "op-4", focus: "2" });
    expect(chartPointerOfText("/org?proposal=op-4&focus=2\n\nop-5")).toEqual({ proposal: "op-5" });
  });
  test("a person's question about one change points at that change", () => {
    expect(chartPointerOfText('About op-9 change 2 ("add a role"):\n\nWhy this one?')).toEqual({ proposal: "op-9", focus: "2" });
  });
});

describe("the newest pointer in a thread", () => {
  const msgs = [
    { _id: "m1", content: "op-1" },
    { _id: "m2", content: "no pointer here" },
    { _id: "m3", content: "see /org?proposal=op-2&focus=1" },
    { _id: "m4", content: "thanks" },
  ];
  test("is the latest message that carries one, keyed by message and content", () => {
    expect(newestChartPointer(msgs)).toEqual({ proposal: "op-2", focus: "1", key: "m3|op-2|1|" });
    expect(newestChartPointer(msgs.slice(0, 2))?.key).toBe("m1|op-1||");
    expect(newestChartPointer([])).toBeNull();
    expect(newestChartPointer(undefined)).toBeNull();
  });
});
