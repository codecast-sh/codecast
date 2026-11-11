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


test("Modern sets unnamed text in Instrument Sans by weight, keeps named mono, and stands in until the faces land", async () => {
  const { Sans, markSansFacesLoaded, markSansItalicLoaded, uiFace } = await import("./fonts");
  // Until Sans is registered: the system face at the same weight and slant.
  expect(monoStyle({ fontWeight: "600", fontSize: 14 }, true, "modern")).toEqual({ fontWeight: "600", fontSize: 14 });
  expect(uiFace(Mono.semiBold, true, "modern")).toBe("System");
  markSansFacesLoaded();
  expect(monoStyle({}, true, "modern").fontFamily).toBe(Sans.regular);
  expect(monoStyle({ fontWeight: "500" }, true, "modern").fontFamily).toBe(Sans.medium);
  expect(monoStyle({ fontWeight: "600" }, true, "modern")).toEqual({ fontFamily: Sans.semiBold });
  expect(monoStyle({ fontWeight: "bold" }, true, "modern").fontFamily).toBe(Sans.bold);
  expect(uiFace(Mono.semiBold, true, "modern")).toBe(Sans.semiBold);
  // The italic loads on its own: until it lands, the system italic.
  expect(monoStyle({ fontStyle: "italic" }, true, "modern")).toEqual({ fontStyle: "italic" });
  markSansItalicLoaded();
  expect(monoStyle({ fontStyle: "italic" }, true, "modern")).toEqual({ fontFamily: Sans.italic });
  // A style that names a mono face stays mono, at its weight.
  expect(monoStyle({ fontFamily: Mono.regular, fontWeight: "700" }, true, "modern").fontFamily).toBe(Mono.bold);
  expect(monoStyle({ fontFamily: Mono.regular, fontStyle: "italic" }, true, "modern").fontFamily).toBe(Mono.italic);
  // Any other family is untouched.
  expect(monoStyle({ fontFamily: "Menlo", fontWeight: "700" }, true, "modern")).toEqual({ fontFamily: "Menlo", fontWeight: "700" });
});

test("nested text inherits the group its parent names, under Modern only", async () => {
  const { Sans, namedFaceGroup } = await import("./fonts");
  const mono = namedFaceGroup({ fontFamily: Mono.regular });
  expect(mono).toBe(Mono);
  expect(namedFaceGroup({ fontFamily: Sans.medium })).toBe(Sans);
  expect(namedFaceGroup({ fontFamily: "Menlo" })).toBeUndefined();
  expect(namedFaceGroup({})).toBeUndefined();
  // A bold run inside mono code stays mono.
  expect(monoStyle({ fontWeight: "700" }, true, "modern", mono).fontFamily).toBe(Mono.bold);
  // Classic ignores the inherited group and the look's faces: mono as before.
  expect(monoStyle({ fontWeight: "700" }, true, "classic", Sans).fontFamily).toBe(Mono.bold);
  expect(monoStyle({}, true, "classic").fontFamily).toBe(Mono.regular);
});
