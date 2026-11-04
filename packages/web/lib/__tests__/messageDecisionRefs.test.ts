import { describe, expect, test } from "bun:test";
import { latestDecisionNamers, messageDecisionRefs } from "../messageDecisionRefs";

describe("messageDecisionRefs", () => {
  test("bare ids and mentions, in first-named order, each once", () => {
    const text = "Answering @[Should grab sd-12] fixes both.\n\n1. sd-12 now\n2. Fix cards: sd-40, sd-41 and @[When a caller sd-7]. Task ct-9 and jx7abcd are not decisions.";
    expect(messageDecisionRefs(text)).toEqual(["sd-12", "sd-40", "sd-41", "sd-7"]);
  });
  test("no decision ids", () => {
    expect(messageDecisionRefs("ct-12 and pl-3")).toEqual([]);
    expect(messageDecisionRefs(undefined)).toEqual([]);
    expect(messageDecisionRefs("xsd-12 or sd-12x")).toEqual([]);
  });
});

describe("latestDecisionNamers", () => {
  test("each decision maps to the last assistant message naming it", () => {
    const msgs = [
      { _id: "m1", role: "assistant", content: "sd-1 and sd-2" },
      { _id: "m2", role: "user", content: "sd-1" },
      { _id: "m3", role: "assistant", content: "still sd-2, now sd-3" },
    ];
    expect([...latestDecisionNamers(msgs)]).toEqual([["sd-1", "m1"], ["sd-2", "m3"], ["sd-3", "m3"]]);
  });
});
