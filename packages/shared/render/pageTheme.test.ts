import { describe, expect, test } from "bun:test";
import { injectPageTheme, PAGE_PARK_MESSAGE, PAGE_THEME_DEFAULTS, PAGE_THEME_TOKENS } from "./pageTheme";

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

  test("never measures a frame that is not laid out yet, and carries the declared height", () => {
    const script = /<script>([\s\S]*?)<\/script>/.exec(injectPageTheme("<head></head>"))![1]!;
    const posted: { height: number; preferred: number | null }[] = [];
    const listeners: Record<string, () => void> = {};
    const size = { w: 0, h: 0, content: 0 };
    const win = {
      get innerWidth() { return size.w; },
      get innerHeight() { return size.h; },
      scrollY: 0,
      self: 1, top: 2,
      location: { search: "" },
      parent: { postMessage: (m: { height: number; preferred: number | null }) => posted.push({ height: m.height, preferred: m.preferred }) },
      addEventListener: (type: string, fn: () => void) => { listeners[type] = fn; },
    };
    const body = { getBoundingClientRect: () => ({ bottom: size.content }) };
    const doc = {
      body,
      documentElement: { setAttribute() {}, get scrollHeight() { return Math.max(size.content, size.h); } },
      getElementById: () => ({ textContent: "" }),
      querySelector: (sel: string) => (sel === 'meta[name="codecast:height"]' && meta.content ? { getAttribute: () => meta.content } : null),
      addEventListener() {},
    };
    const meta = { content: "" };
    class RO { observe() {} constructor(_fn: () => void) {} }
    new Function("window", "document", "innerWidth", "innerHeight", "ResizeObserver", "getComputedStyle", "location",
      `with (window) { ${script} }`)(win, doc, 0, 0, RO, () => ({ marginBottom: "0" }), win.location);
    // Loaded at 0x0, its text wrapped at zero width: nothing is posted.
    size.content = 160000;
    listeners.load!();
    expect(posted).toEqual([]);
    // Laid out: the real height arrives with the resize.
    Object.assign(size, { w: 1000, h: 600, content: 4000 });
    listeners.resize!();
    expect(posted).toEqual([{ height: 4000, preferred: null }]);
    // A page that declares the height it opens at sends it with the next report.
    meta.content = "640";
    size.content = 4100;
    listeners.resize!();
    expect(posted.at(-1)).toEqual({ height: 4100, preferred: 640 });
  });

  test("parked by the window framing it, the page stops what it plays, inside open shadow roots too", () => {
    const script = /<script>([\s\S]*?)<\/script>/.exec(injectPageTheme("<head></head>"))![1]!;
    const listeners: Record<string, (e: unknown) => void> = {};
    const parent = { postMessage() {} };
    const win = {
      innerWidth: 0, innerHeight: 0, scrollY: 0, self: 1, top: 2,
      location: { search: "" },
      parent,
      addEventListener: (type: string, fn: (e: unknown) => void) => { listeners[type] = fn; },
    };
    const media = (tagName: string) => ({ tagName, paused: false, pause() { this.paused = true; } });
    const video = media("VIDEO");
    const audio = media("AUDIO");
    const host = { tagName: "CAST-PLAYER", shadowRoot: { querySelectorAll: () => [audio] } };
    const doc = {
      body: null,
      documentElement: { setAttribute() {} },
      getElementById: () => ({ textContent: "" }),
      querySelectorAll: () => [video, host],
      addEventListener() {},
    };
    new Function("window", "document", "ResizeObserver", "location", `with (window) { ${script} }`)(win, doc, undefined, win.location);
    // Only the framing window may park it.
    listeners.message!({ source: {}, data: { type: PAGE_PARK_MESSAGE } });
    expect(video.paused).toBe(false);
    listeners.message!({ source: parent, data: { type: PAGE_PARK_MESSAGE } });
    expect(video.paused).toBe(true);
    expect(audio.paused).toBe(true);
  });
});
