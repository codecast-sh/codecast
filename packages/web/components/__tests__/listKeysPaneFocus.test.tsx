import { afterAll, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { MemoryRouter } from "react-router";
import { replaceGlobals } from "../../test-helpers/globals";

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
afterAll(() => { dom.window.close(); restoreGlobals(); });

const { GenericListView } = await import("../GenericListView");
const { TabParamsCtx } = await import("../../lib/tabParams");

// A list pane beside a focused conversation pane must not answer the keys
// typed there: `c` opened the create task dialog from the other pane.
async function pressInPane(isActive: boolean, key: string) {
  let created = 0;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const ctx = { tabId: "t1", pathname: "/tasks", params: {}, searchParams: new URLSearchParams(), isActive };
  await act(() => root.render(
    <MemoryRouter initialEntries={["/tasks"]}>
      <TabParamsCtx.Provider value={ctx}>
        <GenericListView<{ id: string }>
          title="Tasks"
          tabs={[]}
          activeTab=""
          onTabChange={() => {}}
          flatItems={[{ id: "a" }]}
          renderRow={(item) => <span>{item.id}</span>}
          getItemId={(item) => item.id}
          getItemRoute={(item) => `/tasks/${item.id}`}
          emptyMessage="none"
          onCreate={() => { created++; }}
        />
      </TabParamsCtx.Provider>
    </MemoryRouter>,
  ));
  await act(() => { window.dispatchEvent(new window.KeyboardEvent("keydown", { key, bubbles: true })); });
  await act(() => root.unmount());
  container.remove();
  return created;
}

test("an unfocused list pane ignores its keys", async () => {
  expect(await pressInPane(false, "c")).toBe(0);
});

test("the focused list pane still answers its keys", async () => {
  expect(await pressInPane(true, "c")).toBe(1);
});
