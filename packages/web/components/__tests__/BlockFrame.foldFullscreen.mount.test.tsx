// ct-101973: a large canvas folded behind its fade was too cramped to read.
// "Show all" unfolds it at the same column width, and the only way to a view
// that fits it was the small Fullscreen icon up in the header, so a reader
// pressed Show all, hid the sessions panel, then hunted for Fullscreen. The
// bar under the fade, where the reader's eye already is, must open the
// fullscreen view in one click, and a wide canvas must open at full width.
import { afterAll, expect, test } from "bun:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../test-helpers/globals";
import { closeDomWindow } from "../../test-helpers/domGlobals";
import { BlockFrame } from "../BlockFrame";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
let report: (() => void) | null = null;
class FakeResizeObserver {
  constructor(cb: () => void) { report = cb; }
  observe() {}
  disconnect() {}
}
const restoreGlobals = replaceGlobals({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  KeyboardEvent: dom.window.KeyboardEvent,
  ResizeObserver: FakeResizeObserver,
  IS_REACT_ACT_ENVIRONMENT: true,
});
const { createRoot } = await import("react-dom/client");

afterAll(() => {
  closeDomWindow(dom);
  restoreGlobals();
});

const doc = dom.window.document;
const overlay = () => doc.body.querySelector(":scope > .fixed.inset-0") as HTMLElement | null;
const click = (el: Element) => el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));

// Mount a block whose content is taller than the fold, and return the
// controls drawn under the folded body (everything after the header).
async function mountFolded(wide: boolean) {
  const host = doc.createElement("div");
  doc.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<BlockFrame title="Canvas" wide={wide}><div data-body>chart</div></BlockFrame>);
  });
  const body = host.querySelector("[data-body]") as HTMLElement;
  Object.defineProperty(body, "offsetHeight", { configurable: true, value: 2500 });
  await act(async () => { report?.(); });
  const frame = host.firstElementChild as HTMLElement;
  const header = frame.firstElementChild as HTMLElement;
  const foldButtons = [...frame.querySelectorAll("button")].filter((b) => !header.contains(b));
  return { root, foldButtons };
}

for (const wide of [false, true]) {
  test(`a folded ${wide ? "wide" : "tall"} canvas opens fullscreen in one click from the bar under its fade`, async () => {
    const { root, foldButtons } = await mountFolded(wide);
    expect(foldButtons.length).toBeGreaterThan(0);
    expect(overlay()).toBeNull();

    const opener = foldButtons.find((b) => /fullscreen/i.test(`${b.textContent} ${b.title} ${b.getAttribute("aria-label") ?? ""}`));
    expect(opener, "no Fullscreen control on the fold bar: the reader must find the header icon").toBeTruthy();
    await act(async () => { click(opener!); });

    const view = overlay();
    expect(view, "one click on the fold bar did not open the fullscreen view").toBeTruthy();
    if (wide) expect(view!.querySelector(".max-w-none"), "a wide canvas must open at full screen width").toBeTruthy();

    // Esc closes it and it opens again.
    await act(async () => { dom.window.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape" })); });
    expect(overlay()).toBeNull();
    await act(async () => { click(opener!); });
    expect(overlay()).toBeTruthy();
    await act(async () => { root.unmount(); });
  });
}
