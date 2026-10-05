import { describe, expect, test } from "bun:test";
import { callAnchorHref, callAnchorKey, callExcerptHref, callMomentHref, callPathRef, callViewParam, parseCallAnchor, parseCallViewParam, type CallAnchor } from "./callLinks";

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

  test("a call is addressed by its short id, the name everything else gives it", () => {
    const call = { _id: "mn7n6jp204bph9nmsdpb74c96s8fkc0p", short_id: "cl-117" };
    expect(callAnchorHref(callPathRef(call))).toBe("/calls/cl-117");
    expect(callMomentHref(callPathRef(call), 150_000)).toBe("/calls/cl-117?t=150");
    // A call from before short ids keeps its full id.
    expect(callPathRef({ _id: call._id, short_id: null })).toBe(call._id);
    expect(callPathRef({ _id: call._id })).toBe(call._id);
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

describe("callViewParam", () => {
  test("spells a view the way a built link does, and reads back through parseCallViewParam", () => {
    expect(callViewParam(null)).toBeNull();
    expect(callViewParam({ screen: true })).toBe("screen");
    expect(callViewParam({ screen: true, identity: "guest:g1" })).toBe("screen:guest%3Ag1");
    expect(callMomentHref("cl-117", 150_000, null, { screen: true, identity: "guest:g1" })).toBe(`/calls/cl-117?t=150&view=${callViewParam({ screen: true, identity: "guest:g1" })}`);
    const back = parseCallViewParam(new URLSearchParams(`t=150&view=${callViewParam({ screen: true, identity: "guest:g1" })}`));
    expect(back).toEqual({ screen: true, identity: "guest:g1" });
  });
});
