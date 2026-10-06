// The shared Evals views read only --ev-* tokens, and @platform/evals'
// tokens.css resolves each one to the host's --sol-* or --font-* value with a
// fallback that is codecast's own look, for a host that has none. Codecast
// owns that look (app/globals.css), so this holds the fallbacks to it: light
// against the :root block, dark against .dark. When globals.css moves a
// colour, the vendored fallbacks must move with it (edit ~/src/platform and
// re-vendor), or a host without --sol-* drifts from codecast's look.

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const TOKENS = resolve(import.meta.dir, "../../../../platform/packages/evals/src/react/tokens.css");
const GLOBALS = resolve(import.meta.dir, "../../app/globals.css");

const uncomment = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");

/** The declarations of the first rule whose selector list is exactly `selector`. */
function block(css: string, selector: string): Map<string, string> {
  const at = uncomment(css)
    .split("}")
    .find((chunk) => chunk.slice(0, chunk.indexOf("{")).trim().split(/\s*,\s*/).join(", ") === selector);
  if (!at) throw new Error(`no ${selector} block`);
  const body = at.slice(at.indexOf("{") + 1);
  return new Map([...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim().replace(/\s+/g, " ")]));
}

/** Each token's host variable and its fallback, `--ev-text: var(--sol-text, #002b36)`, with the area's own names read back as the host's. */
function fallbacks(decls: Map<string, string>): Array<{ host: string; fallback: string }> {
  const out: Array<{ host: string; fallback: string }> = [];
  for (const value of decls.values()) {
    const m = value.match(/^var\((--[\w-]+),\s*(.+)\)$/);
    if (m) out.push({ host: m[1], fallback: m[2].replace(/--ev-font-mono\b/g, "--font-mono").replace(/--ev-/g, "--sol-") });
  }
  return out;
}

const tokens = readFileSync(TOKENS, "utf8");
const globals = readFileSync(GLOBALS, "utf8");

describe("the Evals tokens' fallbacks", () => {
  const cases = [
    { theme: "light", tokens: ":where(:root, .ev-area)", globals: ":root, .hero-sandbox" },
    { theme: "dark", tokens: ':where([data-ev-theme="dark"], [data-ev-theme="dark"] .ev-area)', globals: ".dark" },
  ];
  for (const c of cases) {
    it(`match globals.css in ${c.theme}`, () => {
      const own = block(globals, c.globals);
      const pairs = fallbacks(block(tokens, c.tokens));
      expect(pairs.length).toBeGreaterThan(c.theme === "light" ? 20 : 8);
      const drift = pairs.filter((p) => own.get(p.host) !== p.fallback).map((p) => `${p.host}: tokens.css falls back to ${p.fallback}, globals.css says ${own.get(p.host) ?? "nothing"}`);
      expect(drift).toEqual([]);
    });
  }
});
