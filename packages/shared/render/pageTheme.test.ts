import { describe, expect, test } from "bun:test";
import { injectPageTheme, PAGE_THEME_DEFAULTS, PAGE_THEME_TOKENS } from "./pageTheme";

describe("injectPageTheme", () => {
  test("goes first in <head>, so the page's own styles win", () => {
    const html = '<!doctype html><html><head><style>:root{--sol-blue:red}</style></head><body>x</body></html>';
    const out = injectPageTheme(html);
    expect(out.indexOf('id="cc-page-theme"')).toBeGreaterThan(out.indexOf("<head>"));
    expect(out.indexOf('id="cc-page-theme"')).toBeLessThan(out.indexOf("--sol-blue:red"));
  });

  test("adds a head to a document without one", () => {
    expect(injectPageTheme("<!doctype html><html><body>x</body></html>")).toMatch(/^<!doctype html><html><head><style id="cc-page-theme">/);
    expect(injectPageTheme("<!doctype html><div>x</div>")).toMatch(/^<!doctype html><head><style id="cc-page-theme">/);
    expect(injectPageTheme("<div>x</div>")).toMatch(/^<style id="cc-page-theme">/);
  });

  test("injects once", () => {
    const once = injectPageTheme("<html><head></head></html>");
    expect(injectPageTheme(once)).toBe(once);
  });

  test("declares every token for both modes, and only variables", () => {
    const out = injectPageTheme("<head></head>");
    const css = /<style id="cc-page-theme">([\s\S]*?)<\/style>/.exec(out)![1]!;
    for (const name of PAGE_THEME_TOKENS) {
      expect(css).toContain(`--${name}:${PAGE_THEME_DEFAULTS.light[name]}`);
      expect(css).toContain(`--${name}:${PAGE_THEME_DEFAULTS.dark[name]}`);
    }
    // Nothing but custom properties: a page that ignores the tokens is unchanged.
    for (const rule of css.match(/\{[^{}]*\}/g)!) {
      for (const decl of rule.slice(1, -1).split(";").filter(Boolean)) expect(decl.startsWith("--")).toBe(true);
    }
  });
});
