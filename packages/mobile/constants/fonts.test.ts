import { expect, mock, test } from "bun:test";

// The resolver only needs StyleSheet.flatten from react-native; create is the
// theme's (Theme.test.ts mocks the same module the same way, since one run
// shares a module mock across files).
mock.module("react-native", () => ({ StyleSheet: { create: (s: any) => s, flatten: (s: any) => (Array.isArray(s) ? Object.assign({}, ...s.flat(Infinity).filter(Boolean)) : s) } }));
const { Mono, markLateFacesLoaded, monoStyle } = await import("./fonts");

test("late faces stand in with a loaded face until they land, then resolve exactly", () => {
  expect(monoStyle({ fontWeight: "700" }).fontFamily).toBe(Mono.semiBold);
  expect(monoStyle({ fontWeight: "500" }).fontFamily).toBe(Mono.regular);
  expect(monoStyle({ fontWeight: "600" }).fontFamily).toBe(Mono.semiBold);
  markLateFacesLoaded();
  expect(monoStyle({ fontWeight: "700" }).fontFamily).toBe(Mono.bold);
  expect(monoStyle({ fontWeight: "500" }).fontFamily).toBe(Mono.medium);
  expect(monoStyle({ fontStyle: "italic" }).fontFamily).toBe(Mono.italic);
});

test("a style naming another family keeps it", () => {
  expect(monoStyle({ fontFamily: "Menlo", fontWeight: "700" })).toEqual({ fontFamily: "Menlo", fontWeight: "700" });
});

