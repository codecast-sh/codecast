import { describe, expect, test } from "bun:test";
import { describeError, errorChain, errorSummary, rootError } from "../errorCause";

// The shape React hands to onRecoverableError in a production build: a wrapper
// whose message is only the error code, with the real throw in `cause`.
function reactWrapper(cause: unknown) {
  return new Error(
    "Minified React error #520; visit https://react.dev/errors/520 for the full message",
    { cause }
  );
}

describe("errorCause", () => {
  test("a React recovery wrapper reports the error that actually threw", () => {
    const real = new TypeError("Cannot read properties of undefined (reading 'title')");
    const wrapped = reactWrapper(real);

    expect(errorSummary(wrapped)).toBe(
      "Cannot read properties of undefined (reading 'title')"
    );
    expect(rootError(wrapped)).toBe(real);
    expect(errorChain(wrapped)).toEqual([wrapped, real]);
  });

  test("the described trace keeps every link, outermost first", () => {
    const text = describeError(reactWrapper(new Error("boom")));
    expect(text).toContain("Minified React error #520");
    expect(text).toContain("caused by: boom");
    expect(text.indexOf("#520")).toBeLessThan(text.indexOf("caused by"));
  });

  test("a plain error is its own root", () => {
    const e = new Error("plain");
    expect(errorSummary(e)).toBe("plain");
    expect(rootError(e)).toBe(e);
    expect(errorChain(e)).toEqual([e]);
  });

  test("a thrown string as cause still names the failure", () => {
    expect(errorSummary(reactWrapper("stringly typed"))).toBe("stringly typed");
  });

  test("an opaque object cause is dropped, so the outer message survives", () => {
    expect(errorSummary(reactWrapper({ code: 42 }))).toContain("#520");
  });

  test("an object cause carrying a message is read", () => {
    expect(errorSummary(reactWrapper({ message: "convex: not found" }))).toBe(
      "convex: not found"
    );
  });

  test("a cause with no message falls back to the outer one", () => {
    expect(errorSummary(reactWrapper(new Error("")))).toContain("#520");
  });

  test("a cycle terminates instead of hanging", () => {
    const a = new Error("a");
    const b = new Error("b", { cause: a });
    (a as { cause?: unknown }).cause = b;
    expect(errorChain(a)).toEqual([a, b]);
    expect(errorSummary(a)).toBe("b");
  });

  test("a deep chain is bounded", () => {
    let e = new Error("depth-0");
    for (let i = 1; i <= 20; i++) e = new Error(`depth-${i}`, { cause: e });
    expect(errorChain(e).length).toBe(8);
  });

  test("a non-error throw still yields something reportable", () => {
    expect(errorSummary("just a string")).toBe("just a string");
    expect(rootError(undefined)).toBeInstanceOf(Error);
    expect(describeError(null)).toBe("null");
  });
});
