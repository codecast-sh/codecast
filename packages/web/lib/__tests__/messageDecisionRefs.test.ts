import { describe, expect, test } from "bun:test";
import { messageDecisionRefs } from "../messageDecisionRefs";

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
