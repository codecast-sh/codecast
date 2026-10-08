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

test("the family look sets unnamed text in Instrument Sans and keeps code mono", async () => {
  const { Sans, Serif, markFamilyFacesLoaded, namedFaceGroup } = await import("./fonts");
  // Until the family faces land, family text sets in the system face at its
  // weight rather than naming a face iOS has not registered.
  expect(monoStyle({ fontWeight: "600" }, true, "family")).toEqual({ fontWeight: "600" });
  markFamilyFacesLoaded();
  expect(monoStyle({ fontWeight: "600" }, true, "family").fontFamily).toBe(Sans.semiBold);
  expect(monoStyle({}, true, "classic").fontFamily).toBe(Mono.regular);
  // A style that names a face keeps its group in every look.
  expect(monoStyle({ fontFamily: "SpaceMono", fontWeight: "700" }, true, "family").fontFamily).toBe(Mono.bold);
  expect(monoStyle({ fontFamily: Serif.regular, fontWeight: "700" }, true, "family").fontFamily).toBe(Serif.bold);
  // Nested text inherits its parent's group: a bold run in a reply set in
  // the reading face stays in it.
  const inherited = namedFaceGroup({ fontFamily: Serif.regular });
  expect(monoStyle({ fontWeight: "700" }, true, "family", inherited).fontFamily).toBe(Serif.bold);
  expect(monoStyle({ fontStyle: "italic" }, true, "family", inherited).fontFamily).toBe(Serif.italic);
});
