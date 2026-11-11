// A jsdom page for the Modern conversion tests: a surface rendered once in
// Modern (the theme context saying so and .modern-style on <html>) and once in
// Classic, so a test can check the hand-built controls wear the Modern looks
// (components/ui/modernLook.ts) and that Classic's class strings did not move.
//
// Import this first and everything React after it (dynamic imports): it
// installs the DOM globals at import time, as the other mount tests do inline.
import { afterAll } from "bun:test";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "./globals";
import { closeDomWindow } from "./domGlobals";
import { cn } from "../lib/utils";

export function installModernDom(url = "https://app.test/") {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url, pretendToBeVisual: true });
  const restore = replaceGlobals({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    localStorage: dom.window.localStorage,
    sessionStorage: dom.window.sessionStorage,
    location: dom.window.location,
    history: dom.window.history,
    HTMLElement: dom.window.HTMLElement,
    HTMLInputElement: dom.window.HTMLInputElement,
    HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
    HTMLButtonElement: dom.window.HTMLButtonElement,
    HTMLAnchorElement: dom.window.HTMLAnchorElement,
    SVGElement: dom.window.SVGElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    NodeFilter: dom.window.NodeFilter,
    Event: dom.window.Event,
    CustomEvent: dom.window.CustomEvent,
    MouseEvent: dom.window.MouseEvent,
    PointerEvent: dom.window.MouseEvent,
    FocusEvent: dom.window.FocusEvent,
    KeyboardEvent: dom.window.KeyboardEvent,
    DocumentFragment: dom.window.DocumentFragment,
    MutationObserver: dom.window.MutationObserver,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    matchMedia: (q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false }),
    requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0),
    cancelAnimationFrame: (id: number) => clearTimeout(id),
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  (dom.window as any).matchMedia ??= (globalThis as any).matchMedia;
  (globalThis as any).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
  (globalThis as any).IntersectionObserver ??= class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } };
  dom.window.HTMLElement.prototype.scrollIntoView ??= () => {};
  dom.window.HTMLElement.prototype.scrollTo ??= () => {};
  afterAll(() => { closeDomWindow(dom); restore(); });
  return dom;
}

/** The theme context's value for a style. */
export const styleValue = (visualStyle: "classic" | "modern") =>
  ({ theme: "light", toggleTheme: () => {}, visualStyle, setVisualStyle: () => {} }) as any;

/** Every element's classes under `root`, one line each, in document order,
 *  with the `modern:` classes taken out and the spacing normalised: what
 *  Classic and Minimal draw. */
export function classicClasses(root: Element): string {
  const lines: string[] = [];
  for (const el of [root, ...root.querySelectorAll("*")]) {
    const raw = el.getAttribute("class");
    if (raw == null) continue;
    const kept = raw.split(/\s+/).filter((c) => c && !c.startsWith("modern:"));
    lines.push(`${el.tagName.toLowerCase()} ${kept.join(" ")}`);
  }
  return lines.join("\n");
}

/** The classes of one element as a list. */
export const classList = (el: Element | null | undefined) => (el?.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);

/** Whether an element wears every class of a look, as cn() leaves it (a
 *  call site merges its overrides into the look with tailwind-merge). */
export function wears(el: Element | null | undefined, look: string): boolean {
  const have = new Set(classList(el));
  return cn(look).split(/\s+/).filter(Boolean).every((c) => have.has(c));
}
