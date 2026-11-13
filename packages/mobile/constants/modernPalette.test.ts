import { expect, test } from "bun:test";
import { DEFAULT_THEME } from "@codecast/web/lib/theme/builtinThemes";
import { THEME_COLOR_TOKENS } from "@codecast/shared/contracts/theme";
import { ModernPalettes } from "./modernPalette";
import { mixHex } from "./colorMix";

test("Modern wears the web's default theme, imported, in both schemes", () => {
  expect(DEFAULT_THEME.id).toBe("verdigris-fjord");
  for (const scheme of ["light", "dark"] as const) {
    const v = DEFAULT_THEME[scheme]!;
    const p = ModernPalettes[scheme];
    expect(p.bg).toBe(v.bg!);
    expect(p.bgAlt).toBe(v["bg-alt"]!);
    expect(p.card).toBe(v.card!);
    expect(p.border).toBe(v.border!);
    expect(p.text).toBe(v.text!);
    expect(p.textMuted).toBe(v["text-muted"]!);
    expect(p.textDim).toBe(v["text-dim"]!);
    // The one accent is the theme's cyan, as on the web.
    expect(p.accent).toBe(v.cyan!);
    expect(p.red).toBe(v.red!);
    expect(p.green).toBe(v.green!);
    // White cards on the near-white page.
    expect(p.cardBg).toBe(v.card!);
  }
});

test("derived surfaces are the web's themeVars mixes", () => {
  const v = DEFAULT_THEME.light!;
  const p = ModernPalettes.light;
  expect(p.bgInset).toBe(mixHex(v.bg!, 40, v["bg-alt"]!));
  expect(p.bgHighlight).toBe(mixHex(v.text!, 6, v["bg-alt"]!));
  expect(p.cardHover).toBe(mixHex(v.text!, 3, v.card!));
  expect(p.textSecondary).toBe(mixHex(v.text!, 88, v.bg!));
});

test("Verdigris declares every colour token, so no palette key falls back", () => {
  for (const scheme of ["light", "dark"] as const) {
    for (const t of THEME_COLOR_TOKENS) expect(DEFAULT_THEME[scheme]?.[t]).toMatch(/^#[0-9a-f]{6}$/i);
  }
});

test("every Modern value is six-digit hex, so `colour + alpha` suffixes stay valid", () => {
  // Call sites append two hex digits of alpha (`Theme.userBubble + '30'`).
  for (const scheme of ["light", "dark"] as const) {
    for (const [key, value] of Object.entries(ModernPalettes[scheme])) {
      expect(`${key}=${value}`).toMatch(/=#[0-9a-f]{6}$/);
    }
  }
});
