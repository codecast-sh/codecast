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

test("under Modern no word sits under 12, and capitals sit at 11 at least", async () => {
  const { isCapsText, codeFont } = await import("./fonts");
  expect(monoStyle({ fontSize: 9 }, true, "modern").fontSize).toBe(12);
  expect(monoStyle({ fontSize: 10, lineHeight: 14 }, true, "modern")).toMatchObject({ fontSize: 12, lineHeight: 17 });
  expect(monoStyle({ fontSize: 11.5 }, true, "modern").fontSize).toBe(12);
  expect(monoStyle({ fontSize: 9, textTransform: "uppercase" }, true, "modern").fontSize).toBe(11);
  expect(monoStyle({ fontSize: 9 }, true, "modern", undefined, true).fontSize).toBe(11);
  expect(monoStyle({ fontSize: 13 }, true, "modern").fontSize).toBe(13);
  // Code keeps its mono face as it rises.
  expect(monoStyle([codeFont, { fontSize: 10 }], true, "modern")).toMatchObject({ fontFamily: Mono.regular, fontSize: 12 });
  // Classic sizes are untouched.
  expect(monoStyle({ fontSize: 9 }, true, "classic").fontSize).toBe(9);
  expect(monoStyle([codeFont, { fontSize: 10 }], true, "classic")).toEqual(monoStyle({ fontSize: 10 }, true, "classic"));
  // A family outside the groups (an icon font) is left alone.
  expect(monoStyle({ fontFamily: "FontAwesome", fontSize: 9 }, true, "modern").fontSize).toBe(9);
  // Capitals: a run whose words are capitals.
  expect(isCapsText("410 GONE")).toBe(true);
  expect(isCapsText(["PLAN", " ", 2])).toBe(true);
  expect(isCapsText("Plan")).toBe(false);
  expect(isCapsText("3")).toBe(false);
  expect(isCapsText("A")).toBe(false);
  expect(isCapsText("9:01\u202fAM")).toBe(false);
  expect(isCapsText("OK")).toBe(false);
  expect(isCapsText(undefined)).toBe(false);
});
