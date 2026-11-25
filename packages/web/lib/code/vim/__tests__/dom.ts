// A jsdom window installed as the globals CodeMirror and the vim engine read,
// for the file that calls installDom and taken down after it.
import { afterAll } from "bun:test";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../../../test-helpers/globals";
import { closeDomWindow } from "../../../../test-helpers/domGlobals";

export function installDom(): void {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true, url: "http://localhost/" });
  const w = dom.window;
  // jsdom has no layout. CodeMirror measures text through Range rects for
  // vertical motion; empty rects send it down its no-layout fallback.
  const emptyRect = { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON() {} };
  w.Range.prototype.getClientRects = function () {
    return [] as unknown as DOMRectList;
  };
  w.Range.prototype.getBoundingClientRect = function () {
    return emptyRect as DOMRect;
  };
  const restore = replaceGlobals({
    window: w,
    document: w.document,
    navigator: w.navigator,
    localStorage: w.localStorage,
    Window: w.Window,
    HTMLElement: w.HTMLElement,
    Element: w.Element,
    Node: w.Node,
    Text: w.Text,
    KeyboardEvent: w.KeyboardEvent,
    CustomEvent: w.CustomEvent,
    MutationObserver: w.MutationObserver,
    getComputedStyle: w.getComputedStyle.bind(w),
    requestAnimationFrame: w.requestAnimationFrame.bind(w),
    cancelAnimationFrame: w.cancelAnimationFrame.bind(w),
  });
  afterAll(() => {
    restore();
    closeDomWindow(dom);
  });
}
