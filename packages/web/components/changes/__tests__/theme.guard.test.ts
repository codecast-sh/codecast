import { describe, expect, test } from "bun:test";
import { createRequire } from "node:module";
import postcss, { type Rule } from "postcss";
import tailwindConfig from "../../../tailwind.config";
import { changesCss, code, globalsRoot, pageSources } from "./pageSources";

// The Changes page paints every accent from `var(--sol-*)` (changes-page.md
// 5.2), so the minimal and graphite themes repaint it. Anything else stays one
// color in every theme: Tailwind's `text-sol-blue` and its kin are fixed
// Solarized hex in tailwind.config, the default palette (`text-red-500`) is
// fixed hex, and the shadcn tokens (`text-destructive`) sit outside the sol
// set the themes define. A single one of them shows Solarized blue on a
// graphite page. This guard reads the page's sources and its rules in
// globals.css and fails on any color that does not come from a sol variable.

// CJS require: the ESM interop of tailwind's modules touches the deprecated
// palette alias getters, which print warnings.
const req = createRequire(import.meta.url);
const resolveConfig = req("tailwindcss/resolveConfig");
const flattenColorPalette = req("tailwindcss/lib/util/flattenColorPalette").default;
const CSS_NAMED: string[] = Object.keys(req("tailwindcss/lib/util/colorNames").default);

// Every color name a utility class can take, read from the resolved config, so
// a color added to it is judged without editing this.
const palette: Record<string, unknown> = flattenColorPalette(resolveConfig(tailwindConfig).theme.colors);

/** The sol variable a palette entry paints: `var(--sol-x)`, or a themed() function that returns it. */
function solVar(value: unknown): string | null {
  const v = typeof value === "function" ? value({}) : value;
  return typeof v === "string" ? (/^var\((--sol-[\w-]+)\)$/.exec(v)?.[1] ?? null) : null;
}

/** Color names that follow the theme, to the variable each paints. */
const THEMED = new Map(Object.keys(palette).flatMap((name) => {
  const v = solVar(palette[name]);
  return v ? [[name, v] as const] : [];
}));
const KEYWORDS = new Set(["inherit", "current", "transparent"]);

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const UTILITY = "(?:text|bg|border(?:-[xytrblse])?|ring(?:-offset)?|outline|fill|stroke|from|via|to|decoration|divide|shadow|accent|caret|placeholder)";
const COLOR_CLASS = new RegExp(
  `(?<![\\w-])${UTILITY}-(${Object.keys(palette).sort((a, b) => b.length - a.length).map(esc).join("|")})(?![\\w-])`,
  "g",
);
const COLOR_LITERAL = /(?<![\w&])#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})(?![\w-])|\b(?:rgba?|hsla?)\(/gi;
const NAMED_WORD = new RegExp(
  `(?<![\\w-])(${CSS_NAMED.filter((n) => n !== "transparent").join("|")})(?![\\w-])`,
  "gi",
);
const STRING = /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`[^`]*`/g;
const CSS_SHAPED = /[():;]|\d(?:px|r?em|%)/;

/** Named colors standing alone in a CSS value, after its sol variables are set aside. */
const namedIn = (value: string) => [...value.replace(/var\(--[\w-]+\)/g, "").matchAll(NAMED_WORD)].map((m) => m[1].toLowerCase());

/** Named colors in string literals that read as CSS (a bare color word, or a value with units, parens or colons). */
function namedInStrings(text: string): string[] {
  return [...text.matchAll(STRING)]
    .map((m) => m[0].slice(1, -1).replace(/\$\{[^}]*\}/g, ""))
    .filter((s) => CSS_SHAPED.test(s) || /^\s*[a-z]+\s*$/i.test(s))
    .flatMap(namedIn);
}

/** Every hardcoded color in code (comments already dropped): color classes that ignore the theme, hex, rgb or hsl literals, named colors. */
function hardcodedColors(text: string): string[] {
  const classes = [...text.matchAll(COLOR_CLASS)].filter((m) => !THEMED.has(m[1]) && !KEYWORDS.has(m[1])).map((m) => m[0]);
  return [...classes, ...(text.match(COLOR_LITERAL) ?? []), ...namedInStrings(text)];
}

/** The values of every declaration in a stylesheet, one per line. */
function cssValues(css: string): string {
  const out: string[] = [];
  postcss.parse(css).walkDecls((d) => {
    out.push(d.value);
  });
  return out.join("\n");
}

/** Every sol variable a text paints with: named outright, or behind a themed class. */
function solVarsIn(text: string): string[] {
  return [
    ...[...text.matchAll(/(?<![\w-])--sol-[a-z0-9-]+/g)].map((m) => m[0]),
    ...[...text.matchAll(COLOR_CLASS)].flatMap((m) => THEMED.get(m[1]) ?? []),
  ];
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
    // The palette is the real one: fixed Solarized hex, the default palette and shadcn tokens are colors; sol neutrals are themed.
    for (const name of ["sol-blue", "sol-cyan", "sol-amber", "red-500", "white", "primary", "destructive"]) {
      expect({ name, known: name in palette, themed: THEMED.has(name) }).toEqual({ name, known: true, themed: false });
    }
    expect(THEMED.get("sol-text")).toBe("--sol-text");
    expect(THEMED.get("sol-card")).toBe("--sol-card");

    expect(hardcodedColors(`<span className="mt-1 text-sol-blue">`)).toEqual(["text-sol-blue"]);
    expect(hardcodedColors(`cls = "hover:bg-sol-red/15 border-l-sol-cyan"`)).toEqual(["bg-sol-red", "border-l-sol-cyan"]);
    expect(hardcodedColors(`"text-red-500 bg-white ring-offset-black"`)).toEqual(["text-red-500", "bg-white", "ring-offset-black"]);
    expect(hardcodedColors(`"text-destructive bg-primary/20 border-accent"`)).toEqual(["text-destructive", "bg-primary", "border-accent"]);
    expect(hardcodedColors(`style={{ color: "#268bd2", background: "rgb(0 0 0)" }}`)).toEqual(["#268bd2", "rgb("]);
    expect(hardcodedColors(`"text-[#fdf6e3]"`)).toEqual(["#fdf6e3"]);
    expect(hardcodedColors(`style={{ color: "white", border: "1px solid Black" }} cls="bg-[color:red]"`)).toEqual(["white", "black", "red"]);
    expect(hardcodedColors("`color-mix(in srgb, ${c} 20%, gold)`")).toEqual(["gold"]);

    // Theme classes, keywords, variables and prose are fine.
    expect(hardcodedColors(`"text-sol-text/70 bg-sol-card border-sol-border/25 text-sol-text-dim from-sol-bg to-transparent fill-current"`)).toEqual([]);
    expect(hardcodedColors(`color: "var(--sol-blue)", fill: "color-mix(in srgb, var(--sol-red) 22%, transparent)"`)).toEqual([]);
    expect(hardcodedColors(`"whitespace-nowrap" "shadow-sm text-[13px]" "red_main" "Ready to ship" "why: from session"`)).toEqual([]);
    expect(hardcodedColors(code(`// PR #412 at https://x.dev/#abc\n/* #268bd2\n * #fdf6e3 */\nconst a = 1;`))).toEqual([]);
    expect(namedIn("1px solid var(--sol-border)")).toEqual([]);
    expect(namedIn("0 0 0 1px white")).toEqual(["white"]);
  });

  test("no source under components/changes or the route hardcodes a color", () => {
    const files = pageSources();
    expect(files.length).toBeGreaterThan(10);
    const hits = files.flatMap(({ file, code }) => hardcodedColors(code).map((h) => `${file}: ${h}`));
    expect(hits).toEqual([]);
  });

  // Shared components paint outside these sources: DiffStat's own counts are fixed Solarized classes unless `themed`.
  test("every DiffStat on the page takes its colors from the theme", () => {
    const uses = pageSources().flatMap(({ file, code }) => [...code.matchAll(/<DiffStat\b[^>]*>/g)].map((m) => ({ file, tag: m[0] })));
    expect(uses.length).toBeGreaterThan(0);
    expect(uses.filter((u) => !/\bthemed\b/.test(u.tag))).toEqual([]);
  });

  test("the page's rules in globals.css hardcode no color", () => {
    expect(changesCss).toContain(".chg-root");
    expect(changesCss).toContain("@keyframes chgRise");
    expect([...hardcodedColors(changesCss), ...namedIn(cssValues(changesCss))]).toEqual([]);
  });

  // Solarized dark (`.dark`) sets only its neutrals: Solarized accents are the
  // same in light and dark, so it inherits them from :root. The minimal and
  // graphite themes repaint accents too, so each must set every variable.
  test("every theme variable the page paints with is set by the default, minimal and graphite themes", () => {
    const used = new Set([...pageSources().map((s) => s.code), cssValues(changesCss)].flatMap(solVarsIn));
    // Area colors are named bare (areaColor.ts) and neutrals arrive through classes; both count.
    expect([...used]).toEqual(expect.arrayContaining(["--sol-blue", "--sol-violet", "--sol-magenta", "--sol-yellow", "--sol-text", "--sol-card", "--sol-border"]));
    for (const selector of [":root", ".minimal-style", ".dark.minimal-style"]) {
      const set = themeTokens(selector);
      const missing = [...used].filter((v) => !set.has(v)).sort();
      expect({ selector, missing }).toEqual({ selector, missing: [] });
    }
  });
});
