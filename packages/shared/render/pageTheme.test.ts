import { describe, expect, test } from "bun:test";
import { injectPageTheme, PAGE_ESCAPE_MESSAGE, PAGE_PARK_MESSAGE, PAGE_WHEEL_MESSAGE, PAGE_THEME_DEFAULTS, PAGE_THEME_TOKENS } from "./pageTheme";

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

  test("a wheel forwarded by the framing window scrolls the innermost box under the pointer that can move, else the page", () => {
    const script = /<script>([\s\S]*?)<\/script>/.exec(injectPageTheme("<head></head>"))![1]!;
    const listeners: Record<string, (e: unknown) => void> = {};
    const parent = { postMessage() {} };
    const scrolled: Array<[string, number]> = [];
    const node = (name: string, overflowY: string, top: number, parentElement: unknown) => ({
      name, style: { overflowY, overflowX: "visible" }, scrollTop: top, clientHeight: 100, scrollHeight: 600, scrollLeft: 0, clientWidth: 100, scrollWidth: 100, parentElement,
      scrollBy({ top: dy }: { top: number }) { scrolled.push([name, dy]); },
    });
    const body = node("body", "visible", 0, null);
    const page = node("page", "visible", 0, null);
    const box = node("box", "auto", 0, body);
    const text = node("text", "visible", 0, box);
    const win = {
      innerWidth: 0, innerHeight: 0, scrollY: 0, self: 1, top: 2,
      location: { search: "" },
      parent,
      getComputedStyle: (n: { style: unknown }) => n.style,
      addEventListener: (type: string, fn: (e: unknown) => void) => { if (type === "message") listeners[type] = fn; },
    };
    let under: unknown = text;
    const doc = {
      body, scrollingElement: page,
      documentElement: { setAttribute() {} },
      getElementById: () => ({ textContent: "" }),
      querySelectorAll: () => [],
      elementFromPoint: () => under,
      addEventListener() {},
    };
    new Function("window", "document", "ResizeObserver", "location", `with (window) { ${script} }`)(win, doc, undefined, win.location);
    const wheel = (dy: number) => ({ source: parent, data: { type: PAGE_WHEEL_MESSAGE, x: 10, y: 10, dx: 0, dy } });
    listeners.message!({ source: {}, data: wheel(40).data });
    expect(scrolled).toEqual([]);
    listeners.message!(wheel(40));
    // Up from a box already at its top passes to the page.
    listeners.message!(wheel(-40));
    box.scrollTop = 500;
    listeners.message!(wheel(40));
    under = null;
    listeners.message!(wheel(10));
    expect(scrolled).toEqual([["box", 40], ["page", -40], ["page", 40], ["page", 10]]);
  });

  test("framed, the page tells the window framing it that Escape was pressed, unless the page used the key", () => {
    const script = /<script>([\s\S]*?)<\/script>/.exec(injectPageTheme("<head></head>"))![1]!;
    const listeners: Record<string, (e: unknown) => void> = {};
    const sent: unknown[] = [];
    const win = {
      innerWidth: 0, innerHeight: 0, scrollY: 0, self: 1, top: 2,
      location: { search: "" },
      parent: { postMessage: (m: unknown) => sent.push(m) },
      addEventListener: (type: string, fn: (e: unknown) => void) => { listeners[type] = fn; },
    };
    const doc = { body: null, documentElement: { setAttribute() {} }, getElementById: () => ({ textContent: "" }), querySelectorAll: () => [], addEventListener() {} };
    new Function("window", "document", "ResizeObserver", "location", `with (window) { ${script} }`)(win, doc, undefined, win.location);
    listeners.keydown!({ key: "a", defaultPrevented: false });
    listeners.keydown!({ key: "Escape", defaultPrevented: true });
    expect(sent).toEqual([]);
    listeners.keydown!({ key: "Escape", defaultPrevented: false });
    expect(sent).toEqual([{ type: PAGE_ESCAPE_MESSAGE }]);
  });
  test("framed, a page that paints no background gets the backdrop a tab would give it, only when its text would vanish into the host", () => {
    const script = /<script>([\s\S]*?)<\/script>/.exec(injectPageTheme("<head></head>"))![1]!;
    const run = (page: { ink: string; bodyBg?: string; hostBg: string }) => {
      const styles: { id?: string; textContent: string }[] = [];
      const listeners: Record<string, (e: unknown) => void> = {};
      const parent = { postMessage() {} };
      const win = { innerWidth: 0, innerHeight: 0, scrollY: 0, self: 1, top: 2, location: { search: "" }, parent, addEventListener: (t: string, fn: (e: unknown) => void) => { listeners[t] = fn; } };
      const root = { setAttribute() {}, appendChild: (n: { textContent: string }) => styles.push(n) };
      const body = {};
      const doc = { body, head: null, documentElement: root, getElementById: () => ({ textContent: "" }), querySelectorAll: () => [], addEventListener() {}, createElement: () => ({ textContent: "" }) };
      const computed = (node: unknown) => node === root
        ? { backgroundColor: "rgba(0, 0, 0, 0)", getPropertyValue: () => page.hostBg }
        : { backgroundColor: page.bodyBg ?? "rgba(0, 0, 0, 0)", color: page.ink };
      new Function("window", "document", "ResizeObserver", "location", "getComputedStyle", `with (window) { ${script} }`)(win, doc, undefined, win.location, computed);
      listeners.message!({ source: parent, data: { type: "codecast:theme", theme: "dark", tokens: { "sol-bg": page.hostBg } } });
      return styles[0]?.textContent ?? "";
    };
    // Written for a white tab, framed on a dark host: white behind its dark text.
    expect(run({ ink: "rgb(27, 27, 27)", hostBg: "#08404e" })).toBe("html{background-color:#ffffff}");
    // Its text follows the tokens: it stays clear and blends with the host.
    expect(run({ ink: "rgb(253, 246, 227)", hostBg: "rgb(8, 64, 78)" })).toBe("");
    expect(run({ ink: "rgb(27, 27, 27)", hostBg: "#FBF5E2" })).toBe("");
    // It paints its own background: left alone.
    expect(run({ ink: "rgb(27, 27, 27)", bodyBg: "rgb(255, 255, 255)", hostBg: "#08404e" })).toBe("");
    // Light text with no background on a light host gets a dark backdrop.
    expect(run({ ink: "color(srgb 0.95 0.95 0.95)", hostBg: "#fff" })).toBe(`html{background-color:${PAGE_THEME_DEFAULTS.dark["sol-bg"]}}`);
  });
});
