import { expect, mock, test } from "bun:test";

// The same mock fonts.test.ts installs: one run shares a module mock.
mock.module("react-native", () => ({ StyleSheet: { create: (s: any) => s, flatten: (s: any) => (Array.isArray(s) ? Object.assign({}, ...s.flat(Infinity).filter(Boolean)) : s) } }));
const { Palettes, paletteFor, setActiveLook, setActiveScheme, Theme, themedStyles } = await import("./Theme");
const { PALETTE } = await import("@platform/design");

test("the family look wears the @platform/design palette under the app's names", () => {
  const light = paletteFor("light", "family");
  expect(light.bg).toBe(PALETTE.light.bg);
  expect(light.text).toBe(PALETTE.light.ink);
  // The accent classes collapse as the web's hosted mode maps them.
  expect(light.orange).toBe(PALETTE.light.accent);
  expect(light.red).toBe(PALETTE.light.danger);
  expect(light.blue).toBe(PALETTE.light.inkMuted);
  expect(paletteFor("dark", "family").bgAlt).toBe(PALETTE.dark.bgSunken);
  expect(paletteFor("dark", "classic")).toBe(Palettes.dark);
});

test("Theme and themed sheets follow the look as they follow the scheme", () => {
  const sheet = themedStyles((t, look) => ({ title: { color: t.text, fontSize: look === "family" ? 25 : 20 } }));
  setActiveScheme("light");
  setActiveLook("classic");
  expect(Theme.bg).toBe(Palettes.light.bg);
  expect(sheet.title.fontSize).toBe(20);
  setActiveLook("family");
  expect(Theme.bg).toBe(PALETTE.light.bg);
  expect(sheet.title).toEqual({ color: PALETTE.light.ink, fontSize: 25 });
  setActiveLook("classic");
});
