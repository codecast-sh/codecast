import { afterAll, beforeEach, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../test-helpers/globals";
import { closeDomWindow } from "../../test-helpers/domGlobals";

// Alex's report (2026-10-23): shift-click on a card in the inbox's feed home
// opened the conversation instead of selecting. A modified click on a live
// inbox session's card must select, never open.
const dom = new JSDOM("<!doctype html><html><body></body></html>");
const restoreGlobals = replaceGlobals({ window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node, navigator: dom.window.navigator });
const { useInboxStore } = await import("../../store/inboxStore");
const { useInboxSelection } = await import("../inboxSelection");
const { FEED_CARD_ATTR, feedCardOpened, feedCardSelect } = await import("../feedCardSelection");

afterAll(() => {
  closeDomWindow(dom);
  restoreGlobals();
});

const click = (o: Partial<{ metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }> = {}) =>
  ({ metaKey: false, ctrlKey: false, shiftKey: false, preventDefault() {}, ...o }) as any;

beforeEach(() => {
  useInboxSelection.getState().clear();
  useInboxStore.setState((s: any) => ({
    sessions: { ...s.sessions, a: { _id: "a" }, b: { _id: "b" }, c: { _id: "c" }, gone: { _id: "gone", inbox_killed_at: 1 } },
  }));
  document.body.innerHTML = ["a", "x", "b", "c"].map((id) => `<div ${FEED_CARD_ATTR}="${id}"></div>`).join("");
});

test("a plain click is not a selection: the card opens", () => {
  expect(feedCardSelect("a", click())).toBe(false);
  expect(useInboxSelection.getState().ids).toEqual([]);
});

test("cmd-click ticks the card instead of opening it", () => {
  expect(feedCardSelect("a", click({ metaKey: true }))).toBe(true);
  expect(useInboxSelection.getState().ids).toEqual(["a"]);
});

test("shift-click after an opened card ticks the run between them in feed order, skipping non-inbox cards", () => {
  feedCardOpened("a");
  expect(feedCardSelect("c", click({ shiftKey: true }))).toBe(true);
  expect(useInboxSelection.getState().ids).toEqual(["a", "b", "c"]);
});

test("cards that are not live inbox sessions keep opening on any click", () => {
  expect(feedCardSelect("x", click({ shiftKey: true }))).toBe(false);
  expect(feedCardSelect("gone", click({ metaKey: true }))).toBe(false);
  expect(useInboxSelection.getState().ids).toEqual([]);
});
