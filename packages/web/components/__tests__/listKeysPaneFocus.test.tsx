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
// react-dom/client decides at load whether a DOM exists, so it is loaded
// here — after the globals above — not as a static import.
const {createRoot} = await import("react-dom/client");

afterAll(() => { closeDomWindow(dom); restoreGlobals(); });

const { GenericListView } = await import("../GenericListView");
const { TabParamsCtx } = await import("../../lib/tabParams");

// A list pane beside a focused conversation pane must not answer the keys
// typed there: `c` opened the create task dialog from the other pane.
//
// Focus MOVES while both panes stay mounted, so the cases below hand the pane
// focus and take it away again rather than only mounting it each way.
//
// These cannot catch a gate left out of its effect's dependency list: this
// list's deps change identity on nearly every render, so the effect rebuilds
// and the gate applies either way. Components with stable deps (StackChecklist,
// DocumentDetailLayout) genuinely need the dep, and paneFocusDeps.guard.test.ts
// is what holds that invariant.
function mountList() {
  let created = 0;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  return {
    /** `isActive` is what a stage cell passes: visible tab AND focused pane. */
    render: async (isActive: boolean) => {
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
    },
    press: async () => {
      await act(() => { window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "c", bubbles: true })); });
    },
    creates: () => created,
    cleanup: async () => { await act(() => root.unmount()); container.remove(); },
  };
}

test("a pane without focus ignores its keys", async () => {
  const list = mountList();
  await list.render(false);
  await list.press();
  expect(list.creates()).toBe(0);
  await list.cleanup();
});

test("the focused pane answers its keys", async () => {
  const list = mountList();
  await list.render(true);
  await list.press();
  expect(list.creates()).toBe(1);
  await list.cleanup();
});

test("a pane that loses focus stops answering", async () => {
  const list = mountList();
  await list.render(true);
  await list.press();
  expect(list.creates()).toBe(1);
  // Focus moves to the conversation pane beside it; the list stays mounted.
  await list.render(false);
  await list.press();
  expect(list.creates()).toBe(1);
  await list.cleanup();
});

test("a pane that gains focus starts answering", async () => {
  const list = mountList();
  await list.render(false);
  await list.press();
  expect(list.creates()).toBe(0);
  await list.render(true);
  await list.press();
  expect(list.creates()).toBe(1);
  await list.cleanup();
});
