import { expect, test } from "bun:test";
import { replaceGlobals } from "./globals";

test("replaces an existing window and restores its exact descriptor", () => {
  const restoreOriginal = replaceGlobals({ window: { leaked: true } });
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  const ownWindow = { innerWidth: 1400 };
  const restore = replaceGlobals({ window: ownWindow });
  try {
    expect(globalThis.window).toBe(ownWindow as any);
    restore();
    expect(Object.getOwnPropertyDescriptor(globalThis, "window")).toEqual(previous);
  } finally {
    restoreOriginal();
  }
});

test("removes a fixture global that was originally absent", () => {
  const key = "__ciFixtureGlobal";
  expect(Object.hasOwn(globalThis, key)).toBe(false);
  const restore = replaceGlobals({ [key]: 42 });
  expect(Object.getOwnPropertyDescriptor(globalThis, key)?.value).toBe(42);
  restore();
  expect(Object.hasOwn(globalThis, key)).toBe(false);
});
