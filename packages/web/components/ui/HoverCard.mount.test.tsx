// The hover card must survive the pointer crossing from its trigger onto the
// card: status chips (daemon, sync) put a copyable command inside, and a card
// that closes on trigger leave cannot be used.
import { afterAll, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../test-helpers/globals";
import { closeDomWindow } from "../../test-helpers/domGlobals";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://app.test/", pretendToBeVisual: true });
const restoreGlobals = replaceGlobals({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element,
  Node: dom.window.Node,
  Event: dom.window.Event,
  CustomEvent: dom.window.CustomEvent,
  MouseEvent: dom.window.MouseEvent,
  PointerEvent: dom.window.MouseEvent,
  FocusEvent: dom.window.FocusEvent,
  IS_REACT_ACT_ENVIRONMENT: true,
});
(globalThis as any).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
(globalThis as any).getComputedStyle ??= dom.window.getComputedStyle.bind(dom.window);
afterAll(() => { closeDomWindow(dom); restoreGlobals(); });

const React = await import("react");
const { act } = React;
const { createRoot } = await import("react-dom/client");
const { HoverCard } = await import("./HoverCard");

const wait = (ms: number) => act(() => new Promise<void>((r) => setTimeout(r, ms)));
const fire = (el: Element, type: "mouseover" | "mouseout") =>
  act(() => { el.dispatchEvent(new dom.window.MouseEvent(type, { bubbles: true, relatedTarget: null })); });
const card = () => document.querySelector("[data-test-card]");

test("stays open while the pointer moves from the trigger onto the card, closes after leaving it", async () => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <HoverCard card={<button data-test-card>cast status</button>}>
        <button data-test-trigger>chip</button>
      </HoverCard>,
    );
  });
  const trigger = document.querySelector("[data-test-trigger]")!;

  await fire(trigger, "mouseover");
  await wait(260);
  expect(card()).not.toBeNull();

  // Leave the trigger and reach the card inside the close delay (no wait
  // between: under load a short wait would outlast the delay itself).
  await fire(trigger, "mouseout");
  await fire(card()!, "mouseover");
  await wait(300);
  expect(card()).not.toBeNull();

  await fire(card()!, "mouseout");
  await wait(300);
  expect(card()).toBeNull();

  await act(async () => root.unmount());
});
