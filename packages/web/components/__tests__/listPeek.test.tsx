import { afterAll, expect, test } from "bun:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import { MemoryRouter } from "react-router";
import { replaceGlobals } from "../../test-helpers/globals";

import { closeDomWindow } from "../../test-helpers/domGlobals";
const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true, url: "https://codecast.sh/tasks" });
const restoreGlobals = replaceGlobals({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  KeyboardEvent: dom.window.KeyboardEvent,
  localStorage: dom.window.localStorage,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  IntersectionObserver: class { observe() {} disconnect() {} },
  IS_REACT_ACT_ENVIRONMENT: true,
});
const { createRoot } = await import("react-dom/client");

afterAll(() => { closeDomWindow(dom); restoreGlobals(); });

const { GenericListView } = await import("../GenericListView");
const { TabParamsCtx } = await import("../../lib/tabParams");

// Space peeks the focused row beside the list, the peek follows the cursor,
// and space or Esc puts it away: a run of items reads without going in and out.
async function mountList() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const ctx = { tabId: "t1", pathname: "/tasks", params: {}, searchParams: new URLSearchParams(), isActive: true };
  await act(() => root.render(
    <MemoryRouter initialEntries={["/tasks"]}>
      <TabParamsCtx.Provider value={ctx}>
        <GenericListView<{ id: string }>
          title="Tasks"
          tabs={[]}
          activeTab=""
          onTabChange={() => {}}
          flatItems={[{ id: "a" }, { id: "b" }, { id: "c" }]}
          renderRow={(item) => <span>{item.id}</span>}
          getItemId={(item) => item.id}
          getItemRoute={(item) => `/tasks/${item.id}`}
          renderPreview={(item) => <aside data-peek={item.id} />}
          emptyMessage="none"
          onCreate={() => {}}
        />
      </TabParamsCtx.Provider>
    </MemoryRouter>,
  ));
  return {
    press: async (key: string) => {
      await act(() => { window.dispatchEvent(new window.KeyboardEvent("keydown", { key, bubbles: true })); });
    },
    peeked: () => container.querySelector("[data-peek]")?.getAttribute("data-peek") ?? null,
    cleanup: async () => { await act(() => root.unmount()); container.remove(); },
  };
}

test("space peeks the focused row and j/k carry the peek along", async () => {
  const list = await mountList();
  expect(list.peeked()).toBe(null);
  await list.press(" ");
  expect(list.peeked()).toBe("a");
  await list.press("j");
  expect(list.peeked()).toBe("b");
  await list.press("ArrowDown");
  expect(list.peeked()).toBe("c");
  await list.press("k");
  expect(list.peeked()).toBe("b");
  await list.press(" ");
  expect(list.peeked()).toBe(null);
  await list.cleanup();
});

test("escape puts the peek away and moving without one opens nothing", async () => {
  const list = await mountList();
  await list.press(" ");
  expect(list.peeked()).toBe("a");
  await list.press("Escape");
  expect(list.peeked()).toBe(null);
  await list.press("j");
  expect(list.peeked()).toBe(null);
  await list.cleanup();
});
