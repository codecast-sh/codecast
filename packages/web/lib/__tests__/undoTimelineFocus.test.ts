import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { replaceGlobals } from "../../test-helpers/globals";

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

const undoTimeline = await import("../undoTimelineOpen");
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

describe("undo card focus return", () => {
  beforeEach(() => {
    undoTimeline.close();
    doc.body.innerHTML = "";
  });

  it("closing with the chord (toggle) returns focus to the button that had it", () => {
    const button = el("button");
    button.focus();
    undoTimeline.toggle();
    const card = mountCard();
    expect(card.contains(doc.activeElement)).toBe(true);
    undoTimeline.toggle();
    card.remove();
    expect(doc.activeElement).toBe(button);
  });

  it("opened from the palette, focus returns past the palette's input", () => {
    const button = el("button");
    button.focus();
    const palette = el("div", { "cmdk-root": "" });
    const input = el("input", {}, palette);
    input.focus();
    undoTimeline.open();
    palette.remove();
    mountCard();
    undoTimeline.close();
    expect(doc.activeElement).toBe(button);
  });

  // The toast's History action is a doorway that leaves the DOM as the card
  // opens (opening retires the toast), so focus returns past it.
  it("opened from the toast's History button, focus returns past the toast", () => {
    const composer = el("textarea");
    composer.focus();
    const toaster = el("ol", { "data-sonner-toaster": "" }, el("section", { "aria-label": "Notifications alt+T" }));
    const history = el("button", {}, toaster);
    history.focus();
    undoTimeline.open();
    toaster.remove();
    mountCard();
    undoTimeline.close();
    expect(doc.activeElement).toBe(composer);
  });

  it("a close after focus moved elsewhere leaves it there", () => {
    const button = el("button");
    const other = el("input");
    button.focus();
    undoTimeline.open();
    mountCard();
    other.focus();
    undoTimeline.close();
    expect(doc.activeElement).toBe(other);
  });
});
