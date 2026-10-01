import { describe, expect, test } from "bun:test";
import { callAnchorHref, callAnchorKey, callExcerptHref, parseCallAnchor, type CallAnchor } from "./callLinks";

const parse = (href: string) => parseCallAnchor(new URL(href, "https://x.test").searchParams);

describe("call anchors", () => {
  test("every anchor round-trips through its link", () => {
    const anchors: CallAnchor[] = [
      { kind: "turns", from_seq: 4, to_seq: 9 },
      { kind: "turns", from_seq: 7, to_seq: 7 },
      { kind: "summary" },
      { kind: "action", index: 0 },
      { kind: "action", index: 3 },
    ];
    for (const a of anchors) expect(parse(callAnchorHref("abc", a))).toEqual(a);
  });

  test("action items count from one in the URL", () => {
    expect(callAnchorHref("abc", { kind: "action", index: 0 })).toBe("/calls/abc?part=action-1");
    expect(parse("/calls/abc?part=action-0")).toBeNull();
  });

  test("the excerpt links sessions already carry still parse", () => {
    expect(callExcerptHref("abc", { from_seq: 2, to_seq: 5 })).toBe("/calls/abc?turns=2-5");
    expect(parse("/calls/abc?turns=5-2")).toEqual({ kind: "turns", from_seq: 2, to_seq: 5 });
    expect(parse("/calls/abc?turns=3")).toEqual({ kind: "turns", from_seq: 3, to_seq: 3 });
  });

  test("no anchor or junk means the whole call", () => {
    expect(callAnchorHref("abc")).toBe("/calls/abc");
    expect(parse("/calls/abc")).toBeNull();
    expect(parse("/calls/abc?turns=x-y&part=nope")).toBeNull();
  });

  test("keys are distinct per place", () => {
    const keys = [
      callAnchorKey({ kind: "summary" }),
      callAnchorKey({ kind: "action", index: 1 }),
      callAnchorKey({ kind: "turns", from_seq: 1, to_seq: 2 }),
    ];
    expect(new Set(keys).size).toBe(3);
  });
});
