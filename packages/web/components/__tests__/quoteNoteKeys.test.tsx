// ct-101441: the keys around a quote's note.
//
// 1. A note that is ONE paragraph wrapping across several visual lines is still
//    several lines to the person typing it. Plain ↑/↓ with the caret on a middle
//    line must move the caret inside the note, not step to the neighbouring
//    note (or out of the editor). Only the first/last VISUAL line hands the
//    arrow on; ⌘/Ctrl+arrow still jumps from anywhere.
// 2. Once focus is back on the message, one stray key (x, ⌫, Delete) must not
//    destroy a quote and its note for good: either it does not remove it, or the
//    removal can be undone with the same quote and note restored.
//
// JSDOM has no layout. The textarea below is described as 200px wide with a
// 20px line height and a 300-character single paragraph, which wraps onto
// several lines (scrollHeight 100 = five lines). A fix that measures the visual
// line some other way may need these stubs extended, but not the assertions.

import { afterAll, expect, test } from "bun:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import { _resetUndoStacks } from "@platform/engine";
import { replaceGlobals } from "../../test-helpers/globals";
import { closeDomWindow } from "../../test-helpers/domGlobals";
import { useInboxStore } from "../../store/inboxStore";
import { performUndo } from "../../store/undoStack";
import { CommentEditor, MessageReview } from "../MessageReview";
import type { PendingComment } from "../../lib/quoteFormat";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://app.test/conversation/c1", pretendToBeVisual: true });
const W = dom.window as any;
const LINE = 20;
const WIDTH = 200;
const CHARS_PER_LINE = 60; // 200px / ~3.3px per char in this model
// A wrapping textarea: lines = ceil(chars / CHARS_PER_LINE).
Object.defineProperty(W.HTMLTextAreaElement.prototype, "clientWidth", { configurable: true, get: () => WIDTH });
Object.defineProperty(W.HTMLTextAreaElement.prototype, "offsetWidth", { configurable: true, get: () => WIDTH });
Object.defineProperty(W.HTMLTextAreaElement.prototype, "scrollHeight", {
  configurable: true,
  get(this: HTMLTextAreaElement) { return Math.max(1, Math.ceil(this.value.length / CHARS_PER_LINE)) * LINE; },
});
Object.defineProperty(W.HTMLTextAreaElement.prototype, "clientHeight", {
  configurable: true,
  get(this: HTMLTextAreaElement) { return Math.max(1, Math.ceil(this.value.length / CHARS_PER_LINE)) * LINE; },
});
W.HTMLElement.prototype.scrollIntoView = function () {};
const realGCS = W.getComputedStyle.bind(W);
const getComputedStyle = (el: Element) => {
  const s = realGCS(el);
  if (el.tagName !== "TEXTAREA") return s;
  return new Proxy(s, {
    get(t, k) {
      if (k === "lineHeight") return `${LINE}px`;
      if (k === "width") return `${WIDTH}px`;
      if (k === "fontSize") return "13px";
      if (k === "getPropertyValue") return (p: string) => (p === "line-height" ? `${LINE}px` : p === "width" ? `${WIDTH}px` : t.getPropertyValue(p));
      const v = (t as any)[k];
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
};

const restore = replaceGlobals({
  window: W,
  document: W.document,
  navigator: W.navigator,
  location: W.location,
  HTMLElement: W.HTMLElement,
  HTMLTextAreaElement: W.HTMLTextAreaElement,
  KeyboardEvent: W.KeyboardEvent,
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  MutationObserver: W.MutationObserver,
  requestAnimationFrame: W.requestAnimationFrame.bind(W),
  cancelAnimationFrame: W.cancelAnimationFrame.bind(W),
  getComputedStyle,
  IS_REACT_ACT_ENVIRONMENT: true,
});
const { createRoot } = await import("react-dom/client");
afterAll(() => { closeDomWindow(dom); restore(); });

const PARAGRAPH = "This note is one long paragraph with no line breaks at all, typed the way most people write a quick note, and it wraps across several visual lines in the narrow quote card so the caret has real lines above and below it.".repeat(2).slice(0, 300);

function press(el: Element, key: string, mods: Partial<KeyboardEventInit> = {}) {
  const ev = new W.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...mods });
  el.dispatchEvent(ev);
  return ev as KeyboardEvent;
}

test("plain ↑/↓ on a middle visual line of a wrapped one-paragraph note stays in the note", async () => {
  const note: PendingComment = { id: "q1", messageId: "m1", blockIndex: 0, quote: "a quoted line", body: PARAGRAPH, createdAt: 1 };
  useInboxStore.setState({ reviewComments: { c1: [note] }, reviewEditingId: "q1" } as any);
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  const steps: number[] = [];
  try {
    await act(() => root.render(<CommentEditor conversationId="c1" comment={note} author={null} onDone={() => {}} onStep={(d) => steps.push(d)} />));
    const ta = host.querySelector("textarea")!;
    expect(ta.value).toBe(PARAGRAPH);
    expect(ta.value.includes("\n")).toBe(false);

    // Caret in the middle of the third of five visual lines.
    const mid = Math.floor(PARAGRAPH.length / 2);
    ta.setSelectionRange(mid, mid);
    let ev!: KeyboardEvent;
    await act(() => { ev = press(ta, "ArrowUp"); });
    expect({ key: "ArrowUp from a middle line", stepped: steps.slice(), prevented: ev.defaultPrevented }).toEqual({ key: "ArrowUp from a middle line", stepped: [], prevented: false });

    ta.setSelectionRange(mid, mid);
    await act(() => { ev = press(ta, "ArrowDown"); });
    expect({ key: "ArrowDown from a middle line", stepped: steps.slice(), prevented: ev.defaultPrevented }).toEqual({ key: "ArrowDown from a middle line", stepped: [], prevented: false });

    // ⌘↑ still jumps out from anywhere.
    ta.setSelectionRange(mid, mid);
    await act(() => { press(ta, "ArrowUp", { metaKey: true }); });
    expect(steps).toEqual([-1]);
  } finally {
    await act(() => root.unmount());
    host.remove();
    useInboxStore.setState({ reviewComments: {}, reviewEditingId: null } as any);
  }
});

test("one stray key on the message cannot destroy a quote and its note for good", async () => {
  _resetUndoStacks();
  const quote: PendingComment = { id: "q1", messageId: "m1", blockIndex: 0, quote: "a quoted line", body: "my careful note", createdAt: 1 };
  useInboxStore.setState({ reviewComments: { c1: [quote] }, reviewEditingId: null, reviewMessageId: "m1", reviewActiveBlock: 0 } as any);
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  try {
    await act(() => root.render(<MessageReview conversationId="c1" messageId="m1" content="a quoted line" renderBlock={(c) => <p>{c}</p>} />));
    const region = host.querySelector<HTMLElement>(".cc-msg-review")!;
    expect(region.getAttribute("data-review-region")).toBe("active");
    region.focus();
    await act(() => { press(region, "x"); });

    const after = () => (useInboxStore.getState().reviewComments.c1 ?? []).find((c) => c.id === "q1");
    if (!after()) {
      // Removed by one key: it must come back, note and all, with undo.
      await act(() => { performUndo(); });
    }
    const back = after();
    expect({ restored: !!back, quote: back?.quote, body: back?.body }).toEqual({ restored: true, quote: "a quoted line", body: "my careful note" });
  } finally {
    await act(() => root.unmount());
    host.remove();
    useInboxStore.setState({ reviewComments: {}, reviewEditingId: null, reviewMessageId: null, reviewActiveBlock: 0 } as any);
  }
});
