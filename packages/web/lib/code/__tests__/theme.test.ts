import { describe, expect, it } from "bun:test";
import type { ThemePalette } from "@codecast/shared/contracts/theme";
import { blockCursorColors } from "../theme";
import { BUILTIN_THEMES, ORIGINAL_PREVIEW } from "../../theme/builtinThemes";

// Every palette the app ships: each built-in theme's sides and Original's.
const palettes: [string, ThemePalette][] = [
  ...BUILTIN_THEMES.flatMap((t) => [
    ...(t.light ? [[`${t.id} light`, t.light] as [string, ThemePalette]] : []),
    ...(t.dark ? [[`${t.id} dark`, t.dark] as [string, ThemePalette]] : []),
  ]),
  ...Object.entries(ORIGINAL_PREVIEW).flatMap(([style, sides]) =>
    Object.entries(sides).map(([side, p]) => [`original ${style} ${side}`, p] as [string, ThemePalette]),
  ),
];

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a: string, b: string) => {
  const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
};

describe("the vim block cursor", () => {
  it("puts a letter on the cell that reads at 4.5:1 or better in every shipped theme", () => {
    expect(palettes.length).toBeGreaterThan(10);
    for (const [name, p] of palettes) {
      const { block, letter } = blockCursorColors({ bg: p.bg!, text: p.text!, cyan: p.cyan! });
      expect({ name, ok: contrast(block, letter) >= 4.5 }).toEqual({ name, ok: true });
    }
  });

  it("keeps the cursor's cyan, choosing the letter that reads on it", () => {
    // Solarized light: cream on cyan is 2.9:1, so the letter goes dark.
    expect(blockCursorColors({ bg: "#FBF5E2", text: "#002b36", cyan: "#2aa198" })).toEqual({ block: "#2aa198", letter: "#002b36" });
    expect(blockCursorColors({ bg: "#002b36", text: "#fdf6e3", cyan: "#2aa198" })).toEqual({ block: "#2aa198", letter: "#002b36" });
  });

  it("falls back to reverse video when the cyan reads against neither", () => {
    expect(blockCursorColors({ bg: "#cccccc", text: "#333333", cyan: "#808080" })).toEqual({ block: "#333333", letter: "#cccccc" });
    // A token that is not hex cannot be measured: reverse video, never a guess.
    expect(blockCursorColors({ bg: "#fff", text: "#000", cyan: "oklch(0.7 0.1 180)" })).toEqual({ block: "#000", letter: "#fff" });
  });
});

it("diff tints are stronger on a dark background than on a light one", async () => {
  const { diffTint } = await import("../theme");
  expect(diffTint({ bg: "#fbf5e2" }, 0.08)).toBe(0.08);
  expect(diffTint({ bg: "#20252e" }, 0.08)).toBe(0.16);
  expect(diffTint({ bg: "not a color" }, 0.08)).toBe(0.08);
});
