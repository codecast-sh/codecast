import { afterAll, expect, test } from "bun:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../test-helpers/globals";
import { closeDomWindow } from "../../test-helpers/domGlobals";

// The palette swaps many rows in one commit when its deferred ranking lands.
// cmdk 1.1.1 batched each unmounting item's "was I selected? select the first
// row" check under one key, so only the last unmounted item's check ran: when
// the selected row left with others, nothing stayed selected and Enter did
// nothing ("aurora v" in the palette, on prod). patches/cmdk@1.1.1.patch.
const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
dom.window.HTMLElement.prototype.scrollIntoView = function () {};
const restoreGlobals = replaceGlobals({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element,
  Event: dom.window.Event,
  KeyboardEvent: dom.window.KeyboardEvent,
  MutationObserver: dom.window.MutationObserver,
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
  cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
  IS_REACT_ACT_ENVIRONMENT: true,
});
const { createRoot } = await import("react-dom/client");
const { Command } = await import("cmdk");
const container = document.createElement("div");
document.body.appendChild(container);
const root = createRoot(container);
const picked: string[] = [];

async function render(rows: string[]) {
  await act(() => root.render(
    <Command>
      <Command.Input value="aurora" onValueChange={() => {}} />
      <Command.List>
        <Command.Group heading="Sessions">
          {rows.map((row) => <Command.Item key={row} value={row} onSelect={() => picked.push(row)}>{row}</Command.Item>)}
        </Command.Group>
      </Command.List>
    </Command>,
  ));
}

const selected = () => container.querySelector('[cmdk-item][aria-selected="true"]')?.textContent ?? null;

afterAll(async () => {
  await act(() => root.unmount());
  closeDomWindow(dom);
  restoreGlobals();
});

test("when the selected row leaves along with others, the first remaining row is selected and Enter picks it", async () => {
  await render(["aurora toy", "aurora book", "aurora video"]);
  expect(selected()).toBe("aurora toy");

  await render(["aurora video", "aurora video harness"]);
  expect(selected()).toBe("aurora video");

  const input = container.querySelector("input")!;
  await act(() => input.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
  expect(picked).toEqual(["aurora video"]);
});

test("a row that leaves while another stays selected keeps that selection", async () => {
  await act(() => root.render(null));
  await render(["aurora a", "aurora b", "aurora c"]);
  const input = container.querySelector("input")!;
  await act(() => input.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
  expect(selected()).toBe("aurora b");
  await render(["aurora b", "aurora c"]);
  expect(selected()).toBe("aurora b");
});
