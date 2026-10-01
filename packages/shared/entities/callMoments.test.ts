import { describe, expect, test } from "bun:test";
import {
  bareEntityIdRegex,
  buildEntityUrl,
  callRefId,
  entityRoute,
  entityTypeFromId,
  formatCallTime,
  isEntityId,
  parseCallRef,
  parseCallTime,
  parseEntityUrl,
} from "./index";
import { callMomentHref, parseCallMomentParam } from "../contracts/callLinks";

const FULL = "k57abcdefghijklmnopqrstuvwxyz012";

describe("call moments", () => {
  test("a time into a call reads three ways", () => {
    expect(parseCallTime("12:34")).toBe(754_000);
    expect(parseCallTime("754s")).toBe(754_000);
    expect(parseCallTime("1:02:03")).toBe(3_723_000);
    expect(parseCallTime("0:07")).toBe(7_000);
    expect(parseCallTime("75:00")).toBe(4_500_000);
  });

  test("anything else is not a time", () => {
    for (const bad of ["", "12", "12:3", "12:60", "1:2:3", "s", "12:34s", "-5s", "1:02:03:04", "abc"]) {
      expect(parseCallTime(bad)).toBeNull();
    }
  });

  test("the clock is the player's: whole seconds, hours only when there are some", () => {
    expect(formatCallTime(0)).toBe("0:00");
    expect(formatCallTime(7_999)).toBe("0:07");
    expect(formatCallTime(754_000)).toBe("12:34");
    expect(formatCallTime(3_723_000)).toBe("1:02:03");
    expect(formatCallTime(-50)).toBe("0:00");
  });

  test("a moment reference splits into the call and its time", () => {
    expect(parseCallRef("cl-42@12:34")).toEqual({ call: "cl-42", turns: null, at_ms: 754_000 });
    expect(parseCallRef("CL-42@754s")).toEqual({ call: "cl-42", turns: null, at_ms: 754_000 });
    expect(parseCallRef("cl-42@1:02:03")).toEqual({ call: "cl-42", turns: null, at_ms: 3_723_000 });
    expect(parseCallRef(`${FULL}@0:30`)).toEqual({ call: FULL, turns: null, at_ms: 30_000 });
    expect(parseCallRef("cl-42@soon")).toBeNull();
    expect(parseCallRef("cl-42@")).toBeNull();
  });

  test("every form that worked before still does, with no moment on it", () => {
    expect(parseCallRef("cl-42")).toEqual({ call: "cl-42", turns: null });
    expect(parseCallRef("cl-42:9")).toEqual({ call: "cl-42", turns: { from_seq: 9, to_seq: 9 } });
    expect(parseCallRef("cl-42:25-15")).toEqual({ call: "cl-42", turns: { from_seq: 15, to_seq: 25 } });
    expect(parseCallRef(`${FULL}:3-4`)).toEqual({ call: FULL, turns: { from_seq: 3, to_seq: 4 } });
    expect(parseCallRef(FULL)).toBeNull();
    expect(parseCallRef("cl-42:9")?.at_ms).toBeUndefined();
  });

  test("callRefId writes a moment in the player's clock, and a moment wins over turns", () => {
    expect(callRefId("cl-42", null, 754_000)).toBe("cl-42@12:34");
    expect(callRefId("cl-42", null, 3_723_500)).toBe("cl-42@1:02:03");
    expect(callRefId("cl-42", { from_seq: 1, to_seq: 2 }, 5_000)).toBe("cl-42@0:05");
    expect(callRefId("cl-42", { from_seq: 1, to_seq: 2 })).toBe("cl-42:1-2");
    for (const ref of ["cl-42@12:34", "cl-42@1:02:03", "cl-7@0:00"]) {
      const p = parseCallRef(ref)!;
      expect(callRefId(p.call, p.turns, p.at_ms)).toBe(ref);
    }
  });

  test("a moment is a call, and routes to the call page at that second", () => {
    expect(entityTypeFromId("cl-42@12:34")).toBe("call");
    expect(entityRoute("call", "cl-42@12:34")).toBe("/calls/cl-42?t=754");
    expect(entityRoute("call", "cl-42:3-4")).toBe("/calls/cl-42?turns=3-4");
    expect(buildEntityUrl("call", "cl-42@754s")).toBe("https://codecast.sh/calls/cl-42?t=754");
  });

  test("a pasted link at a time becomes the moment", () => {
    expect(parseEntityUrl("https://codecast.sh/calls/cl-42?t=754")).toEqual({ type: "call", id: "cl-42@12:34" });
    expect(parseEntityUrl(`https://codecast.sh/calls/${FULL}?t=30`)).toEqual({ type: "call", id: `${FULL}@0:30` });
    // Turns are the more specific place when a link names both.
    expect(parseEntityUrl("https://codecast.sh/calls/cl-42?turns=3-4&t=754")).toEqual({ type: "call", id: "cl-42:3-4" });
  });

  test("prose finds a moment whole, never the call alone", () => {
    const found = (text: string) => text.match(bareEntityIdRegex()) ?? [];
    expect(found("look at cl-42@12:34, the chart")).toEqual(["cl-42@12:34"]);
    expect(found("frame cl-42@754s and cl-9@1:02:03.")).toEqual(["cl-42@754s", "cl-9@1:02:03"]);
    expect(found("lines cl-42:15-25 and cl-42")).toEqual(["cl-42:15-25", "cl-42"]);
    expect(isEntityId("cl-42@12:34")).toBe(true);
    expect(isEntityId("cl-42@later")).toBe(false);
  });
});

describe("the call page at a moment", () => {
  const t = (href: string) => parseCallMomentParam(new URL(href, "https://x.test").searchParams);

  test("?t= carries whole seconds and rides beside an anchor", () => {
    expect(callMomentHref("abc", 754_900)).toBe("/calls/abc?t=754");
    expect(callMomentHref("abc", 5_000, { kind: "turns", from_seq: 3, to_seq: 4 })).toBe("/calls/abc?turns=3-4&t=5");
    expect(t(callMomentHref("abc", 754_000))).toBe(754_000);
  });

  test("the page reads plain, suffixed and fractional seconds, and nothing else", () => {
    expect(t("/calls/abc?t=754s")).toBe(754_000);
    expect(t("/calls/abc?t=1.5")).toBe(1_500);
    expect(t("/calls/abc")).toBeNull();
    expect(t("/calls/abc?t=12:34")).toBeNull();
    expect(t("/calls/abc?t=-3")).toBeNull();
  });
});
