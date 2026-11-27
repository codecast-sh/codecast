// Which marks the icon legend counts as on screen (lib/iconLegend isOnScreen),
// with the page's hit-testing stubbed: the control a mark sits in (a link or
// button whose touch area is laid over its own glyph, as a coarse pointer
// draws it) does not hide the mark; anything else on top does; and the "?"
// panel hides nothing when it floats over the page as a sheet (a phone), but
// does as a column beside it (desktop).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { closeDomWindow } from "../../test-helpers/domGlobals";

const dom = new JSDOM(`<!doctype html><body>
  <main id="main">
    <a href="/compose" id="start"><span data-mark="priority.new_session" id="pen"><svg></svg></span></a>
    <div role="button" id="row"><span data-mark="session.working" id="dot"><svg></svg></span></div>
    <span data-mark="session.idle" id="covered"><svg></svg></span>
    <div id="cover"></div>
    <div id="list"><span data-mark="session.done" id="scrolled"><svg></svg></span></div>
  </main>
  <div data-legend-sheet id="sheet"><div id="sheet-body"></div></div>
</body>`);
const win = dom.window as any;
const doc = win.document as Document;
const g = globalThis as any;
const saved = { document: g.document, getComputedStyle: g.getComputedStyle };
let hits: Element[] = [];

beforeAll(() => {
  g.document = doc;
  g.getComputedStyle = win.getComputedStyle.bind(win);
  win.HTMLElement.prototype.checkVisibility = () => true;
  win.Element.prototype.checkVisibility = () => true;
  win.HTMLElement.prototype.getBoundingClientRect = () => ({ left: 0, top: 0, width: 10, height: 10, right: 10, bottom: 10 });
  doc.elementsFromPoint = () => hits;
});
afterAll(() => {
  g.document = saved.document;
  g.getComputedStyle = saved.getComputedStyle;
  closeDomWindow(dom);
});

const { isOnScreen } = await import("../iconLegend");
const el = (id: string) => doc.getElementById(id) as HTMLElement;

describe("isOnScreen", () => {
  test("a mark under its own link's touch area is on screen (the hit is the link it sits in)", () => {
    hits = [el("start"), el("main"), doc.body];
    expect(isOnScreen(el("pen"))).toBe(true);
    // A row that is a button the same way.
    hits = [el("row"), el("main")];
    expect(isOnScreen(el("dot"))).toBe(true);
  });

  test("a mark under anything else is not: another element on top, or a plain ancestor where it scrolled out of its list", () => {
    hits = [el("cover"), el("covered"), el("main")];
    expect(isOnScreen(el("covered"))).toBe(false);
    hits = [el("main"), doc.body];
    expect(isOnScreen(el("scrolled"))).toBe(false);
    // Another control is no cover the mark sits in.
    hits = [el("start"), el("covered")];
    expect(isOnScreen(el("covered"))).toBe(false);
  });

  test("the ? panel floating over the page as a sheet hides nothing under it; beside the page it does", () => {
    el("sheet").style.position = "fixed";
    hits = [el("sheet-body"), el("sheet"), el("covered"), el("main")];
    expect(isOnScreen(el("covered"))).toBe(true);
    el("sheet").style.position = "";
    expect(isOnScreen(el("covered"))).toBe(false);
  });
});
