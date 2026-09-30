import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../threads/threads.css", import.meta.url), "utf8");

/** Every rule whose selector names `cls`, as its declarations. Comments dropped;
 *  a rule nested in an at-rule is read like a top-level one. */
function rulesNaming(cls: string): Array<{ selector: string; decls: Record<string, string> }> {
  const sheet = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: Array<{ selector: string; decls: Record<string, string> }> = [];
  for (const m of sheet.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = m[1].trim();
    if (!new RegExp(`\\${cls}(?![\\w-])`).test(selector)) continue;
    const decls = Object.fromEntries(
      m[2].split(";").flatMap((declaration) => {
        const colon = declaration.indexOf(":");
        return colon < 0
          ? []
          : [[declaration.slice(0, colon).trim(), declaration.slice(colon + 1).trim()]];
      }),
    );
    out.push({ selector, decls });
  }
  return out;
}

describe("open chat thread scrolling", () => {
  test("keeps replies in the page scroll instead of a nested scroller", () => {
    const rules = rulesNaming(".th-card-replies");
    expect(rules.length).toBeGreaterThan(0);
    for (const { selector, decls } of rules) {
      expect(decls["max-height"], selector).toBeUndefined();
      for (const prop of ["overflow", "overflow-y"]) {
        expect(decls[prop] ?? "", `${selector} ${prop}`).not.toMatch(/auto|scroll/);
      }
    }
  });
});
