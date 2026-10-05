import { expect, mock, test } from "bun:test";

// The resolver only needs StyleSheet.flatten from react-native.
mock.module("react-native", () => ({ StyleSheet: { flatten: (s: any) => (Array.isArray(s) ? Object.assign({}, ...s.flat(Infinity).filter(Boolean)) : s) } }));
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
