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

  // A surface that marks itself role=dialog without being modal (the docked
  // composer, the Fleet drill-in) is part of the page: the field the user
  // was typing in there is where focus goes back, not an older field.
  it("opened from a field in a docked, non-modal dialog, focus returns to that field", () => {
    const search = el("input");
    search.focus();
    const dock = el("div", { role: "dialog" });
    const dockField = el("textarea", {}, dock);
    dockField.focus();
    undoTimeline.open();
    mountCard();
    undoTimeline.close();
    expect(doc.activeElement).toBe(dockField);
  });

  it("a modal dialog is still passed over for the field behind it", () => {
    const composer = el("textarea");
    composer.focus();
    const modal = el("div", { role: "dialog", "aria-modal": "true" });
    const input = el("input", {}, modal);
    input.focus();
    undoTimeline.open();
    modal.remove();
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

  // Focus on the page itself (nothing focused) is a place too: the card gives
  // it back as it found it, never to a field that had focus earlier, where the
  // next single-key shortcut would type.
  it("opened from the page body, focus returns to the body, interactive or peek", () => {
    const composer = el("textarea");
    composer.focus();
    composer.blur();
    expect(doc.activeElement).toBe(doc.body);
    undoTimeline.open();
    const card = mountCard();
    expect(card.contains(doc.activeElement)).toBe(true);
    undoTimeline.close();
    card.remove();
    expect(doc.activeElement).toBe(doc.body);
    // The held peek never takes focus; its fade-out leaves the body as it was.
    undoTimeline.open("peek");
    el("div", { role: "dialog", "data-undo-timeline": "peek" });
    undoTimeline.close();
    expect(doc.activeElement).toBe(doc.body);
  });

  // A peek never takes focus, so its close has none to give back. A field the
  // user left while it showed (a click on blank page, Escape blurring a
  // search input) stays left: refocusing it would let the next single-key
  // shortcut type there.
  it("a peek's close never puts focus back in a field the user left while it showed", () => {
    const composer = el("textarea");
    composer.focus();
    undoTimeline.open("peek");
    el("div", { role: "dialog", "data-undo-timeline": "peek" });
    composer.blur();
    expect(doc.activeElement).toBe(doc.body);
    undoTimeline.close();
    expect(doc.activeElement).toBe(doc.body);
  });

  // A peek pinned with H becomes the interactive card and takes focus; that
  // focus is the card's, so its close hands it back.
  it("a pinned peek that took focus returns it on close", () => {
    const composer = el("textarea");
    composer.focus();
    undoTimeline.open("peek");
    const card = el("div", { role: "dialog", "data-undo-timeline": "peek" });
    undoTimeline.open("interactive");
    el("div", { tabindex: "-1" }, card).focus();
    undoTimeline.close();
    expect(doc.activeElement).toBe(composer);
  });

  it("opened from the palette over the page body, focus returns to the body", () => {
    const composer = el("textarea");
    composer.focus();
    composer.blur();
    const palette = el("div", { "cmdk-root": "" });
    const input = el("input", {}, palette);
    input.focus();
    undoTimeline.open();
    palette.remove();
    mountCard();
    undoTimeline.close();
    expect(doc.activeElement).toBe(doc.body);
  });
});


// The card and the toaster share the bottom-right corner. While the card is
// open the toaster rises above it, and a press on a toast (closing a tip or
// an error) is not a press outside the card.
describe("the undo card and the toaster", () => {
  it("a press on a toast does not close the card; a press on the page does", () => {
    doc.body.innerHTML = "";
    const card = el("div", { role: "dialog", "data-undo-timeline": "interactive" });
    const row = el("button", {}, card);
    const toaster = el("ol", { "data-sonner-toaster": "" });
    const close = el("button", {}, el("li", { "data-sonner-toast": "" }, toaster));
    const page = el("button");
    expect(undoTimeline.pressLeavesCard(row, card)).toBe(false);
    expect(undoTimeline.pressLeavesCard(close, card)).toBe(false);
    expect(undoTimeline.pressLeavesCard(page, card)).toBe(true);
  });

  it("the toaster's lift clears the card's top edge", async () => {
    const { toasterLiftFor } = await import("../undoCardToasterLift");
    // A 400px card sitting 16px off the bottom of an 800px viewport.
    expect(toasterLiftFor(384, 800)).toBe(424);
    // The full-width phone sheet at the very bottom.
    expect(toasterLiftFor(500, 800)).toBe(308);
  });
});
