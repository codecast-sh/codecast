// ct-97578: opening a long conversation froze the page for seconds inside one
// requestAnimationFrame callback, almost all of it forced layout. The
// conversation header's squeeze (useSqueezeToFit) refits its row in a frame
// callback whenever the row's content changes (pills arriving on a cold open,
// a ticking "5m", a status flip) and finds the level by trial: write
// data-squeeze, read scrollWidth back, write the next level, read again. Each
// read after a write is a synchronous style and layout pass of the page, so
// one frame pays one full page layout per trial.
//
// A frame callback may lay the page out once: whatever it reads, it reads
// before or after its one write, never between writes. This mounts the real
// hook in jsdom with a row whose widths follow its squeeze level and counts
// the layout reads that follow a DOM write inside each frame callback.
// Run: bun test hooks/__tests__/squeezeFrameLayout.test.tsx
import { afterAll, beforeAll, expect, test } from "bun:test";
import { closeDomWindow } from "../../test-helpers/domGlobals";

let React: typeof import("react");
let createRoot: typeof import("react-dom/client").createRoot;
let useSqueezeToFit: typeof import("../useSqueezeToFit").useSqueezeToFit;
let dom: any;

// --- Layout model: what a browser would have to lay out ----------------------

let dirty = true;
let inFrame = false;
let forcedInFrame = 0;
const read = () => {
  if (dirty) {
    dirty = false;
    if (inFrame) forcedInFrame++;
  }
};
const write = () => { dirty = true; };

// The row's visible width: a child hidden by the row's squeeze tokens
// (`[data-squeeze~="N"] .cq-sqN { display: none }`) takes no room.
const levelTokens = (row: Element) => new Set((row.getAttribute("data-squeeze") ?? "").split(" ").filter(Boolean));
const rowOf = (el: Element): Element | null => el.closest("[data-test-row]");
const hidden = (el: Element) => {
  const row = rowOf(el);
  if (!row) return false;
  const tokens = levelTokens(row);
  for (let n: Element | null = el; n && n !== row; n = n.parentElement) {
    for (const c of Array.from(n.classList)) {
      const m = /^cq-sq(\d+)$/.exec(c);
      if (m && tokens.has(m[1])) return true;
    }
  }
  return false;
};
const widthOf = (el: Element): number => {
  if (el.hasAttribute("data-test-row")) return Number(el.getAttribute("data-client"));
  if (hidden(el)) return 0;
  const own = el.getAttribute("data-w");
  return own ? Number(own) : Array.from(el.children).reduce((s, c) => s + widthOf(c), 0);
};
const contentWidthOf = (el: Element) => Array.from(el.children).reduce((s, c) => s + widthOf(c), 0);

const frames: Array<() => void> = [];
function runFrames(): number[] {
  const perCallback: number[] = [];
  while (frames.length) {
    const cb = frames.shift()!;
    inFrame = true;
    forcedInFrame = 0;
    try { cb(); } finally { inFrame = false; }
    perCallback.push(forcedInFrame);
  }
  return perCallback;
}

beforeAll(async () => {
  const { JSDOM } = await import("jsdom");
  dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://local.codecast.sh" });
  const w = dom.window;
  for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "MutationObserver", "localStorage"]) {
    Object.defineProperty(globalThis, key, { value: w[key], configurable: true, writable: true });
  }
  class NoopResizeObserver { observe() {} unobserve() {} disconnect() {} }
  (globalThis as any).ResizeObserver = NoopResizeObserver;
  (globalThis as any).requestAnimationFrame = (cb: FrameRequestCallback) => { frames.push(() => cb(0)); return frames.length; };
  (globalThis as any).cancelAnimationFrame = () => {};
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

  // Writes that invalidate layout.
  for (const m of ["setAttribute", "removeAttribute", "toggleAttribute"]) {
    const f = w.Element.prototype[m];
    w.Element.prototype[m] = function (this: Element, ...a: any[]) { write(); return f.apply(this, a); };
  }
  for (const m of ["appendChild", "insertBefore", "removeChild", "replaceChild"]) {
    const f = w.Node.prototype[m];
    w.Node.prototype[m] = function (this: Node, ...a: any[]) { write(); return f.apply(this, a); };
  }
  for (const m of ["add", "remove", "toggle", "replace"]) {
    const f = w.DOMTokenList.prototype[m];
    w.DOMTokenList.prototype[m] = function (this: DOMTokenList, ...a: any[]) { write(); return f.apply(this, a); };
  }
  const sp = w.CSSStyleDeclaration.prototype.setProperty;
  w.CSSStyleDeclaration.prototype.setProperty = function (this: CSSStyleDeclaration, ...a: any[]) { write(); return sp.apply(this, a); };
  const data = Object.getOwnPropertyDescriptor(w.CharacterData.prototype, "data")!;
  Object.defineProperty(w.CharacterData.prototype, "data", { ...data, set(this: CharacterData, v: string) { write(); data.set!.call(this, v); } });

  // Reads that need layout.
  const geometry = (value: (el: Element) => number) => ({ get(this: Element) { read(); return value(this); }, configurable: true });
  Object.defineProperties(w.HTMLElement.prototype, {
    scrollWidth: geometry((el) => (el.hasAttribute("data-test-row") ? contentWidthOf(el) : widthOf(el))),
    clientWidth: geometry(widthOf),
    offsetWidth: geometry(widthOf),
    scrollHeight: geometry(() => 24),
    clientHeight: geometry(() => 24),
    offsetHeight: geometry(() => 24),
    offsetLeft: geometry(() => 0),
    offsetTop: geometry(() => 0),
  });
  w.Element.prototype.getBoundingClientRect = function (this: Element) {
    read();
    const width = widthOf(this);
    return { x: 0, y: 0, left: 0, top: 0, right: width, bottom: 24, width, height: 24, toJSON() {} };
  };
  w.Element.prototype.getClientRects = function (this: Element) { return [this.getBoundingClientRect()]; };

  React = await import("react");
  ({ createRoot } = await import("react-dom/client"));
  ({ useSqueezeToFit } = await import("../useSqueezeToFit"));
}, 60_000);

afterAll(() => { if (dom) closeDomWindow(dom); });

const flush = () => React.act(async () => { await new Promise((r) => setTimeout(r, 0)); });

function pill(level: number, width: number, text = `pill ${level}`) {
  const el = document.createElement("span");
  el.className = `cq-sq${level}`;
  el.setAttribute("data-w", String(width));
  el.textContent = text;
  return el;
}

test("a header refit in a frame callback lays the page out at most once", async () => {
  const rowRef = { current: null as HTMLDivElement | null };
  function Header() {
    useSqueezeToFit(rowRef, 7);
    return React.createElement(
      "div",
      { ref: rowRef, "data-test-row": "", "data-client": "600" },
      React.createElement("span", { "data-w": "300" }, "Texting agent overhaul"),
    );
  }
  const root = createRoot(document.getElementById("root")!);
  await React.act(async () => root.render(React.createElement(Header)));
  const row = rowRef.current!;
  runFrames();
  expect(row.getAttribute("data-squeeze")).toBeNull();

  // A cold open: the header's pills arrive after the first paint (branch,
  // ship state, PR count, files changed...). The row now needs level 4.
  dirty = true;
  for (let level = 1; level <= 7; level++) row.appendChild(pill(level, 100));
  await flush();
  const arrive = runFrames();
  expect(row.getAttribute("data-squeeze")).toBe("1 2 3 4");
  expect(arrive.length).toBeGreaterThan(0);
  expect({ frame: "pills arrive", forcedLayouts: Math.max(...arrive) }).toEqual({ frame: "pills arrive", forcedLayouts: 1 });

  // A relative time in the header ticks ("5m" -> "6m"): nothing that fits
  // changes, and the frame still may lay the page out only once.
  dirty = true;
  (row.querySelector(".cq-sq7")!.firstChild as Text).data = "pill 7 tick";
  await flush();
  const tick = runFrames();
  expect(row.getAttribute("data-squeeze")).toBe("1 2 3 4");
  expect(tick.length).toBeGreaterThan(0);
  expect({ frame: "a clock ticks", forcedLayouts: Math.max(...tick) }).toEqual({ frame: "a clock ticks", forcedLayouts: 1 });

  await React.act(async () => root.unmount());
});
