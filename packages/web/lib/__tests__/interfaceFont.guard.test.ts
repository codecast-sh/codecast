import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// INTERFACE FONT GUARD.
//
// Classic is mono: <body> wears font-mono and --font-ui on :root is the mono
// face, so every glyph is JetBrains Mono and much markup leans on inheriting
// it. The opt-in Modern style swaps the interface to a sans (Instrument Sans)
// under .modern-style, the way Minimal swaps to its own, and code-like
// elements say mono for themselves (code, pre, kbd, modern:font-mono). A
// change that turned Classic sans, or Modern mono, would land on everyone
// using that style at once.

const WEB = join(import.meta.dir, "..", "..");
const html = readFileSync(join(WEB, "index.html"), "utf8");
const css = readFileSync(join(WEB, "app", "globals.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

const MONO_FAMILY = /mono|monospace|courier|menlo|consolas/i;

/** Every rule in globals.css whose selector list has `selector` as one item, in file order. */
function rules(selector: string): Array<{ at: number; body: string }> {
  const out: Array<{ at: number; body: string }> = [];
  for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (rule[1].split(",").map((s) => s.trim()).includes(selector)) out.push({ at: rule.index!, body: rule[2] });
  }
  return out;
}
const fontUi = (body: string) => body.match(/--font-ui\s*:\s*([^;]+);/)?.[1]?.trim();

describe("interface font", () => {
  test("Classic: <body> wears font-mono", () => {
    const body = html.match(/<body\b[^>]*>/)?.[0];
    expect(body).toBeDefined();
    const cls = body!.match(/\bclass\s*=\s*["']([^"']*)["']/)?.[1] ?? "";
    expect(cls.split(/\s+/)).toContain("font-mono");
  });

  test("Classic: --font-ui on :root is the mono face", () => {
    const root = rules(":root").filter((r) => fontUi(r.body));
    expect(root.length).toBeGreaterThan(0);
    // The last one wins on :root.
    expect(fontUi(root.at(-1)!.body)).toMatch(/^var\(--font-mono\)$|mono/i);
  });

  test("Modern: .modern-style sets a sans --font-ui and puts it on <body>", () => {
    const modern = rules(".modern-style").filter((r) => fontUi(r.body));
    expect(modern.length).toBe(1);
    const value = fontUi(modern[0].body)!;
    expect(value).not.toMatch(MONO_FAMILY);
    expect(value).not.toContain("var(--font-mono)");
    expect(value).toMatch(/sans-serif$/);
    // Same specificity as :root, so it must come after the :root token block.
    const root = rules(":root").filter((r) => fontUi(r.body));
    expect(modern[0].at).toBeGreaterThan(root.at(-1)!.at);
    // <body> wears font-mono for Classic; Modern's body rule (0,1,1) outranks it.
    expect(rules(".modern-style body").some((r) => /font-family\s*:\s*var\(--font-ui\)/.test(r.body))).toBe(true);
  });
});
