import { afterAll, expect, test } from "bun:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../test-helpers/globals";
import { closeDomWindow } from "../../test-helpers/domGlobals";

// A keystroke in a cmdk list (the command palette, the decision palette, the
// undo timeline) costs DOM work only where the list changes. cmdk 1.1.1 re-appended
// every matching item to sort it on each search change and rewrote every
// item's data-value on each render: 2,900 mutation records per key in the
// palette, every one invalidating style on a page of :has() rules
// (patches/cmdk@1.1.1.patch).
const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
dom.window.HTMLElement.prototype.scrollIntoView = function () {};
const restoreGlobals = replaceGlobals({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element,
  Event: dom.window.Event,
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
const groups = ["Sessions", "Docs", "Tasks"];
const rows = (g: string) => Array.from({ length: 50 }, (_, i) => `${g} alpha ${i}`);

async function render(search: string, extra?: string) {
  await act(() => root.render(
    <Command>
      <Command.Input value={search} onValueChange={() => {}} />
      <Command.List>
        {groups.map((g) => (
          <Command.Group key={g} heading={g}>
            {rows(g).map((row) => <Command.Item key={row} value={row}><span>{row}</span>{extra}</Command.Item>)}
          </Command.Group>
        ))}
      </Command.List>
    </Command>,
  ));
}

async function measure(fn: () => Promise<void>) {
  const records: MutationRecord[] = [];
  const observer = new MutationObserver((r) => records.push(...r));
  observer.observe(container.querySelector("[cmdk-list]")!, { subtree: true, childList: true, attributes: true, characterData: true });
  await fn();
  records.push(...observer.takeRecords());
  observer.disconnect();
  const removed = new Set(records.flatMap((r) => Array.from(r.removedNodes)));
  return {
    moved: records.reduce((n, r) => n + Array.from(r.addedNodes).filter((node) => removed.has(node)).length, 0),
    dataValueWrites: records.filter((r) => r.type === "attributes" && r.attributeName === "data-value").length,
    records: records.length,
  };
}

afterAll(async () => {
  await act(() => root.unmount());
  closeDomWindow(dom);
  restoreGlobals();
});

test("a key that keeps the order moves no item and rewrites no data-value", async () => {
  await render("");
  await render("a");
  for (const q of ["al", "alp", "alph"]) {
    const cost = await measure(() => render(q));
    expect(cost).toEqual({ moved: 0, dataValueWrites: 0, records: 0 });
  }
  expect(container.querySelectorAll("[cmdk-item]").length).toBe(150);
});

test("a re-render with the same items and query writes nothing", async () => {
  await render("alpha 1");
  const cost = await measure(() => render("alpha 1"));
  expect(cost).toEqual({ moved: 0, dataValueWrites: 0, records: 0 });
});

test("a key that reorders still sorts by score, best first in each group", async () => {
  await render("");
  await render("alpha 4");
  const order = Array.from(container.querySelectorAll('[cmdk-group-items]')[0].querySelectorAll("[cmdk-item]")).map((el) => el.textContent);
  expect(order[0]).toBe("Sessions alpha 4");
  await render("alpha 49");
  const next = Array.from(container.querySelectorAll('[cmdk-group-items]')[0].querySelectorAll("[cmdk-item]")).map((el) => el.textContent);
  expect(next[0]).toBe("Sessions alpha 49");
});
