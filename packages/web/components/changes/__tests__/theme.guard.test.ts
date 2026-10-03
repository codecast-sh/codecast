import { describe, expect, test } from "bun:test";
import { createRequire } from "node:module";
import type { Rule } from "postcss";
import tailwindConfig from "../../../tailwind.config";
import { changesCss, code, globalsRoot, pageSources } from "./pageSources";

// The Changes page paints every accent from `var(--sol-*)` (changes-page.md
// 5.2), so the minimal and graphite themes repaint it. Tailwind's accent
// classes cannot: `text-sol-blue` and its kin are fixed Solarized hex in
// tailwind.config, and the default palette (`text-red-500`) is fixed hex too.
// A single one of them shows Solarized blue on a graphite page. This guard
// reads the page's sources and its rules in globals.css and fails on any
// color that does not come from a theme variable.

// The names that resolve to fixed values, read from the config and Tailwind
// itself, so a hex accent added to either is covered without editing this.
const solFixed = Object.entries(tailwindConfig.theme?.extend?.colors?.sol ?? {})
  .filter(([, v]) => typeof v === "string")
  .map(([k]) => k);
// CJS require: the ESM interop touches the deprecated alias getters, which print warnings.
const tailwindColors = createRequire(import.meta.url)("tailwindcss/colors");
const paletteFixed = Object.entries(Object.getOwnPropertyDescriptors(tailwindColors))
  .filter(([, d]) => "value" in d && d.value && typeof d.value === "object")
  .map(([k]) => k);

const UTILITY = "(?:text|bg|border(?:-[xytrblse])?|ring(?:-offset)?|outline|fill|stroke|from|via|to|decoration|divide|shadow|accent|caret|placeholder)";
const ACCENT_CLASS = new RegExp(
  `(?<![\\w-])${UTILITY}-(?:sol-(?:${solFixed.join("|")})|(?:${paletteFixed.join("|")})-(?:50|[1-9]00|950)|white|black)(?![\\w-])`,
  "g",
);
const COLOR_LITERAL = /(?<![\w&])#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})(?![\w-])|\b(?:rgba?|hsla?)\(/gi;

/** Every hardcoded color in code (comments already dropped): Tailwind accent classes and hex, rgb or hsl literals. */
function hardcodedColors(text: string): string[] {
  return [...(text.match(ACCENT_CLASS) ?? []), ...(text.match(COLOR_LITERAL) ?? [])];
}

/** The custom properties a theme block sets, by its exact selector. */
function themeTokens(selector: string): Set<string> {
  const out = new Set<string>();
  globalsRoot.walkRules((rule: Rule) => {
    if (!rule.selectors.map((s) => s.trim()).includes(selector)) return;
    rule.walkDecls((d) => {
      if (d.prop.startsWith("--")) out.add(d.prop);
    });
  });
  return out;
}

describe("Changes paints only from theme variables", () => {
  test("the guard sees what it guards against", () => {
    expect(solFixed).toEqual(expect.arrayContaining(["blue", "green", "cyan", "violet", "magenta", "orange", "yellow", "red"]));
    expect(paletteFixed).toEqual(expect.arrayContaining(["red", "blue", "slate"]));
    expect(hardcodedColors(`<span className="mt-1 text-sol-blue">`)).toEqual(["text-sol-blue"]);
    expect(hardcodedColors(`cls = "hover:bg-sol-red/15 border-l-sol-cyan"`)).toEqual(["bg-sol-red", "border-l-sol-cyan"]);
    expect(hardcodedColors(`"text-red-500 bg-white"`)).toEqual(["text-red-500", "bg-white"]);
    expect(hardcodedColors(`style={{ color: "#268bd2", background: "rgb(0 0 0)" }}`)).toEqual(["#268bd2", "rgb("]);
    expect(hardcodedColors(`"text-[#fdf6e3]"`)).toEqual(["#fdf6e3"]);
    // Theme classes, variables and prose are fine.
    expect(hardcodedColors(`"text-sol-text/70 bg-sol-card border-sol-border/25 text-sol-text-dim"`)).toEqual([]);
    expect(hardcodedColors(`color: "var(--sol-blue)", fill: "color-mix(in srgb, var(--sol-red) 22%, transparent)"`)).toEqual([]);
    expect(hardcodedColors(code(`// PR #412 at https://x.dev/#abc\n/* #268bd2\n * #fdf6e3 */\nconst a = 1;`))).toEqual([]);
  });

  test("no source under components/changes or the route hardcodes a color", () => {
    const files = pageSources();
    expect(files.length).toBeGreaterThan(10);
    const hits = files.flatMap(({ file, code }) => hardcodedColors(code).map((h) => `${file}: ${h}`));
    expect(hits).toEqual([]);
  });

  test("the page's rules in globals.css hardcode no color", () => {
    expect(changesCss).toContain(".chg-root");
    expect(changesCss).toContain("@keyframes chgRise");
    expect(hardcodedColors(changesCss)).toEqual([]);
  });

  test("every theme variable the page reads is set by the default, minimal and graphite themes", () => {
    const used = new Set(
      [...pageSources().map((s) => s.code), changesCss].flatMap((t) => [...t.matchAll(/var\((--sol-[a-z0-9-]+)/g)].map((m) => m[1])),
    );
    expect(used.size).toBeGreaterThan(5);
    for (const selector of [":root", ".minimal-style", ".dark.minimal-style"]) {
      const set = themeTokens(selector);
      const missing = [...used].filter((v) => !set.has(v));
      expect({ selector, missing }).toEqual({ selector, missing: [] });
    }
  });
});
