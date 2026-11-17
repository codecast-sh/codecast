import { expect, test } from "bun:test";
import { isFramed } from "../consentFrame";

test("the consent page knows when it is inside another page", () => {
  const top = {} as Window;
  expect(isFramed({ self: top, top } as unknown as Window)).toBe(false);
  expect(isFramed({ self: {} as Window, top } as unknown as Window)).toBe(true);
  // A cross-origin parent can throw on access: treat that as framed.
  const hostile = { self: {} as Window, get top(): Window { throw new Error("SecurityError"); } } as unknown as Window;
  expect(isFramed(hostile)).toBe(true);
});
