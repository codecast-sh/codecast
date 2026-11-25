// ct-101440: plain Enter in a quote's note saved and closed it, so a person
// writing a paragraph-length note was thrown out of the editor mid-thought
// (three times in one replay, each reopened within seconds). Enter must add a
// line and leave the editor open; ⌘/Ctrl+Enter saves and closes.

import { afterAll, expect, test } from "bun:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../test-helpers/globals";
import { closeDomWindow } from "../../test-helpers/domGlobals";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://app.test/conversation/c1" });
const restoreGlobals = replaceGlobals({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
  Element: dom.window.Element,
  Node: dom.window.Node,
  KeyboardEvent: dom.window.KeyboardEvent,
  IS_REACT_ACT_ENVIRONMENT: true,
});
const { createRoot } = await import("react-dom/client");
const { useInboxStore } = await import("../../store/inboxStore");
const { CommentEditor } = await import("../MessageReview");

afterAll(() => {
  closeDomWindow(dom);
  restoreGlobals();
});

const CONV = "c1";
const comment = { id: "q1", messageId: "m1", blockIndex: 0, quote: "a quoted line", body: "", createdAt: 1 };

function mount() {
  useInboxStore.setState({ reviewComments: { [CONV]: [{ ...comment }] }, reviewEditingId: comment.id } as never);
  const host = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(<CommentEditor conversationId={CONV} comment={comment} author={null} onDone={() => {}} />);
  });
  const ta = host.querySelector("textarea") as HTMLTextAreaElement;
  return { ta, unmount: () => act(() => root.unmount()) };
}

function type(ta: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")!.set!;
  act(() => {
    setter.call(ta, value);
    ta.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
}

function key(ta: HTMLTextAreaElement, init: KeyboardEventInit) {
  const ev = new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...init });
  act(() => {
    ta.dispatchEvent(ev);
  });
  return ev;
}

test("plain Enter in a note adds a line and keeps the editor open", () => {
  const { ta, unmount } = mount();
  type(ta, "first thought");
  const ev = key(ta, {});
  // The browser inserts the newline only when the keydown is not prevented.
  expect(ev.defaultPrevented).toBe(false);
  expect(useInboxStore.getState().reviewEditingId).toBe(comment.id);
  unmount();
});

test("⌘/Ctrl+Enter saves the note and closes the editor", () => {
  const { ta, unmount } = mount();
  type(ta, "a\nb");
  const ev = key(ta, { metaKey: true, ctrlKey: true });
  expect(ev.defaultPrevented).toBe(true);
  expect(useInboxStore.getState().reviewEditingId).toBe(null);
  expect(useInboxStore.getState().reviewComments[CONV]?.[0]?.body).toBe("a\nb");
  unmount();
});
