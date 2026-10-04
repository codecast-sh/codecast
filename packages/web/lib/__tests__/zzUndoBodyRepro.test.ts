import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { replaceGlobals } from "/Users/ashot/src/codecast/packages/web/test-helpers/globals";

// Every close of the undo card gives focus back to what held it when the card
// opened: Esc, the chord again, an act. A doorway that is itself an overlay
// (the palette's input) is passed over for the last focus outside overlays.
const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://local.codecast.sh" });
const restoreGlobals = replaceGlobals({
  window: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element,
});
afterAll(() => restoreGlobals());

const undoTimeline = await import("/Users/ashot/src/codecast/packages/web/lib/undoTimelineOpen");
const doc = dom.window.document;
// The host subscribes when the app mounts, which starts the focus tracking.
const unsubscribe = undoTimeline.subscribe(() => {});
afterAll(() => unsubscribe());

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, parent: HTMLElement = doc.body) {
  const node = doc.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  parent.appendChild(node);
  return node;
}

/** What UndoTimelineHost renders while open, and how it takes focus. */
function mountCard(): HTMLElement {
  const card = el("div", { role: "dialog", "data-undo-timeline": "interactive" });
  const inner = el("div", { tabindex: "-1" }, card);
  inner.focus();
  return card;
}
describe("body focus", () => {
  it("opened from body, Esc leaves focus on body", () => {
    const ta = el("textarea");
    ta.focus();
    ta.blur();
    expect(doc.activeElement).toBe(doc.body);
    undoTimeline.open();
    const card = mountCard();
    undoTimeline.close();
    card.remove();
    console.log("active after close:", doc.activeElement?.tagName);
    expect(doc.activeElement).toBe(doc.body);
  });
});
