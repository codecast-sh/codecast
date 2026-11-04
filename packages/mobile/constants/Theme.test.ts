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
