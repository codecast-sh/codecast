import { expect, mock, test } from "bun:test";

// The same mock fonts.test.ts installs: one run shares a module mock.
mock.module("react-native", () => ({ StyleSheet: { create: (s: any) => s, flatten: (s: any) => (Array.isArray(s) ? Object.assign({}, ...s.flat(Infinity).filter(Boolean)) : s) } }));
const { Palettes, paletteFor, setActiveScheme, Theme, themedStyles } = await import("./Theme");

test("Theme and themed sheets follow the active scheme", () => {
  const sheet = themedStyles((t) => ({ title: { color: t.text } }));
  expect(paletteFor("dark")).toBe(Palettes.dark);
  setActiveScheme("light");
  expect(Theme.bg).toBe(Palettes.light.bg);
  expect(sheet.title.color).toBe(Palettes.light.text);
  setActiveScheme("dark");
  expect(Theme.bg).toBe(Palettes.dark.bg);
  expect(sheet.title.color).toBe(Palettes.dark.text);
  setActiveScheme("light");
});

test("Classic resolves to the very same palette objects; Modern to the Verdigris ones", async () => {
  const { ModernPalettes } = await import("./modernPalette");
  expect(paletteFor("light")).toBe(Palettes.light);
  expect(paletteFor("light", "classic")).toBe(Palettes.light);
  expect(paletteFor("dark", "classic")).toBe(Palettes.dark);
  expect(paletteFor("dark", "modern")).toBe(ModernPalettes.dark);
});

test("Theme and themed sheets follow the look as they follow the scheme", async () => {
  const { ModernPalettes } = await import("./modernPalette");
  const { setActiveLook, appearanceKey } = await import("./Theme");
  const sheet = themedStyles((t, look) => ({ title: { color: t.text, fontSize: look === "modern" ? 18 : 20 } }));
  setActiveScheme("light");
  setActiveLook("classic");
  const classicTitle = sheet.title;
  expect(appearanceKey()).toBe("classic:light");
  expect(sheet.title).toEqual({ color: Palettes.light.text, fontSize: 20 });
  setActiveLook("modern");
  expect(appearanceKey()).toBe("modern:light");
  expect(Theme.bg).toBe(ModernPalettes.light.bg);
  expect(sheet.title).toEqual({ color: ModernPalettes.light.text, fontSize: 18 });
  setActiveScheme("dark");
  expect(sheet.title.color).toBe(ModernPalettes.dark.text);
  setActiveScheme("light");
  setActiveLook("classic");
  // Back in Classic, the sheet is the one built before the flip.
  expect(sheet.title).toBe(classicTitle);
  expect(Theme.bg).toBe(Palettes.light.bg);
});
