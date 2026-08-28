import { describe, expect, test, afterEach } from "bun:test";
import { readSharePreload, readSharePreloadNow } from "../sharePreload";
import { scriptSafeJson } from "../../server/share";

const w = globalThis as { window?: unknown };

afterEach(() => {
  delete w.window;
});

describe("readSharePreload", () => {
  test("undefined when nothing was inlined (dev, or server chose not to)", () => {
    w.window = {};
    expect(readSharePreload("message", "tok")).toBeUndefined();
  });

  test("returns the payload only for the matching kind and token", () => {
    w.window = { __SHARE_PRELOAD__: { kind: "message", token: "tok", data: { a: 1 } } };
    expect(readSharePreload("message", "tok")).toEqual({ a: 1 });
    expect(readSharePreload("doc", "tok")).toBeUndefined();
    expect(readSharePreload("message", "other")).toBeUndefined();
  });

  test("carries the server clock for a matching hydration render", () => {
    w.window = { __SHARE_PRELOAD__: { kind: "message", token: "tok", data: {}, now: 1234 } };
    expect(readSharePreloadNow()).toBe(1234);
    w.window = {};
    expect(readSharePreloadNow()).toBeUndefined();
  });

  test("null is a real answer (unknown share), distinct from absent", () => {
    w.window = { __SHARE_PRELOAD__: { kind: "plan", token: "tok", data: null } };
    expect(readSharePreload("plan", "tok")).toBeNull();
  });
});

describe("scriptSafeJson", () => {
  test("cannot break out of the inline script tag", () => {
    const out = scriptSafeJson({ content: "</script><script>alert(1)</script>" })!;
    expect(out).not.toContain("</script>");
    expect(JSON.parse(out).content).toBe("</script><script>alert(1)</script>");
  });

  test("escapes line separators that are valid JSON but invalid JS string literals", () => {
    const out = scriptSafeJson({ s: "a\u2028b\u2029c" })!;
    expect(out).not.toMatch(/[\u2028\u2029]/);
    expect(JSON.parse(out).s).toBe("a\u2028b\u2029c");
  });
});
